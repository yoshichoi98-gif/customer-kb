// One "tick" of the engine. Runs every 15 minutes; each tick does a bounded slice of work so no
// single Worker invocation runs into Cloudflare's 15-minute cap:
//
//   1. refresh the customer list from Attio (every 6 hours)
//   2. ingest: pull new conversations from each connected source into the Supabase archive (hourly)
//   3. read:   have Claude read archived conversations that haven't been read yet
//   4. weekly: from Tuesday 6pm PT, write each active customer's Weekly Report and Account
//              Brief, then post the digest to Slack (resumes across ticks until done)
//
// Everything is idempotent: a crashed tick is simply picked up by the next one.

import type { Env } from "./env.ts";
import { num } from "./env.ts";
import { Db, type ConversationRow, type CustomerRow, type InsightRow, type MessageRow } from "./db.ts";
import { syncCustomers } from "./customers.ts";
import { loadPrompts, type Prompts } from "./prompts.ts";
import { Matcher } from "./match.ts";
import { allSources } from "./sources/index.ts";
import type { ChatMessage } from "./sources/types.ts";
import { readConversation, readInternalCall, writeBrief, writeProductIdeas, writeWeeklyReport, type ConversationRead, type ReportOut } from "./claude.ts";
import { createPage, markdownToBlocks, prop, replacePageBody, updatePage } from "./notion.ts";
import { esc, postMessages } from "./slack.ts";
import { lastReportTime, ptDate, rangeLabel, short } from "./time.ts";

const TICK_BUDGET_MS = 12 * 60_000;
const SOURCE_LABEL: Record<string, string> = { bluedot: "BlueDot call", pylon: "Pylon", email: "Email", teams: "Teams", google_chat: "Google Chat", slack: "Slack" };
const SOURCE_NOUN: Record<string, string> = { bluedot: "call", pylon: "support chat", email: "email", teams: "Teams chat", google_chat: "Google Chat", slack: "Slack channel" };

interface Control { paused?: boolean; archive_only?: boolean; read_sources?: string[]; weekly?: boolean; slack_post?: boolean; slack_team_channels?: boolean; team_slack_read?: boolean }
const sourceFilter = (c: Control | null) => (c?.read_sources?.length ? `&source=in.(${c.read_sources.map(encodeURIComponent).join(",")})` : "");

export interface TickResult { customers?: number; ingested: Record<string, number | string>; read: number; readErrors: string[]; weekly?: string }

export async function tick(env: Env, opts: { forceIngest?: boolean; forceReport?: boolean; readLimit?: number; manual?: boolean; only?: string } = {}): Promise<TickResult> {
  const started = Date.now();
  const timeLeft = () => TICK_BUDGET_MS - (Date.now() - started);
  const db = new Db(env);
  const result: TickResult = { ingested: {}, read: 0, readErrors: [] };

  // Automatic runs can be paused (e.g. while checking quality); manual runs still work.
  // control (Supabase source_state "control"): paused, archive_only, read_sources (e.g. ["bluedot"]:
  // only these sources are read by Claude; unset = all), weekly (true = write Tuesday reports),
  // slack_post (true = post the weekly headline to Slack).
  const control = await db.getState<Control>("control");
  if (!opts.manual && control?.paused) {
    result.weekly = "paused";
    return result;
  }

  // 1. customers
  let customers: CustomerRow[];
  const cs = await db.getState<{ at: number }>("customers_sync");
  const canSync = Boolean(env.ATTIO_API_KEY && env.NOTION_TOKEN);
  if (canSync && (!cs || Date.now() - cs.at > 6 * 3600_000 || opts.forceIngest)) {
    customers = await syncCustomers(env, db);
    await db.setState("customers_sync", { at: Date.now() });
    result.customers = customers.length;
  } else {
    customers = await db.select<CustomerRow>("customers", "status=neq.No%20longer%20active&select=*");
  }
  const byId = new Map(customers.map((c) => [c.attio_record_id, c]));

  // 2. ingest (hourly)
  const ing = await db.getState<{ at: number }>("ingest");
  if (!ing || Date.now() - ing.at > 3600_000 || opts.forceIngest) {
    const matcher = new Matcher(env, customers);
    for (const source of allSources(env, db, matcher, customers)) {
      if (opts.only && source.name !== opts.only) continue; // manual run limited to one source
      if (!(await source.enabled())) { result.ingested[source.name] = "not connected"; continue; }
      try {
        result.ingested[source.name] = await ingestSource(env, db, source, matcher);
      } catch (err) {
        result.ingested[source.name] = `error: ${err instanceof Error ? err.message : err}`;
      }
    }
    await db.setState("ingest", { at: Date.now() });
  }

  // Archive only: store everything in Supabase, no Claude reading or weekly reports.
  // Switched with source_state "control" { archive_only: true }. Also the case without a Claude key.
  if (control?.archive_only || !env.ANTHROPIC_API_KEY) {
    await db.setState("last_tick", { at: new Date().toISOString(), ...result });
    return result;
  }

  // 3. read new conversations
  // Slack team-channel days (and the per-customer "messages naming the customer" updates cut from
  // them) are read once, after the day is over in Pacific time (Yoshi, Nov 11), not re-read as
  // messages arrive.
  const todayPt = ptDate(new Date());
  const todayStart = [7, 8].map((h) => new Date(`${todayPt}T0${h}:00:00Z`))
    .find((d) => ptDate(d) === todayPt && ptDate(new Date(d.getTime() - 1)) !== todayPt)!.toISOString();
  let prompts: Prompts | null = null;
  const pending = await db.select<ConversationRow>("conversations",
    `state=in.(new,error)&attempts=lt.3&or=(customer_id.not.is.null,and(source.eq.bluedot,kind.eq.call),kind.eq.team_update)&or=(thread_id.is.null,thread_id.not.like.slack:team:*,occurred_at.lt.${todayStart})${sourceFilter(control)}&select=id,source,source_id,kind,customer_id,title,occurred_at,url,raw_text,attempts,participants&order=occurred_at.desc&limit=${opts.readLimit ?? 25}`);
  for (const c of pending) {
    if (timeLeft() < 4 * 60_000) break;
    prompts ??= await loadPrompts(env);
    try {
      const customer = c.customer_id ? byId.get(c.customer_id) : undefined;
      if (customer) await readOne(env, db, prompts, c, customer);
      else if (!c.customer_id) await readInternal(env, db, c);
      else throw new Error("customer is no longer active");
      result.read++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.readErrors.push(`${c.id}: ${msg}`);
      await db.update("conversations", `id=eq.${encodeURIComponent(c.id)}`, { state: "error", error: msg.slice(0, 2000), attempts: (c.attempts ?? 0) + 1 });
    }
  }

  // 4. weekly report (never from a test pull limited to one source or with reading off)
  const testPull = Boolean(opts.only) || opts.readLimit === 0;
  if (!testPull && timeLeft() > 3 * 60_000) {
    prompts ??= await loadPrompts(env);
    result.weekly = control?.weekly || opts.forceReport
      ? await weeklyStage(env, db, prompts, customers, timeLeft, opts.forceReport ?? false, control)
      : "weekly reports switched off";
  }
  await db.setState("last_tick", { at: new Date().toISOString(), ...result });
  return result;
}

// ---------- ingest ----------

async function ingestSource(env: Env, db: Db, source: ReturnType<typeof allSources>[number], matcher: Matcher): Promise<number> {
  const key = `cursor:${source.name}`;
  const cur = await db.getState<{ since: string }>(key);
  const until = new Date();
  // Re-scan the last 2 days every time: calls can upload or finish transcribing late. Already
  // archived items are skipped cheaply via `known`.
  const since = cur
    ? new Date(new Date(cur.since).getTime() - 2 * 86400_000)
    : new Date(until.getTime() - num(env.BACKFILL_DAYS, 30) * 86400_000);

  const knownRows = await db.select<{ source_id: string }>("conversations",
    `source=eq.${source.name}&kind=eq.call&occurred_at=gte.${since.toISOString()}&select=source_id`);
  const known = new Set(knownRows.map((r) => r.source_id));
  const newMsgs: MessageRow[] = [];
  const save = async (msgs: ChatMessage[]) => {
    if (!msgs.length) return;
    newMsgs.push(...await db.insertNewReturning<MessageRow>("messages", msgs.map((m) => ({
      id: `${m.source}:${m.messageId}`,
      source: m.source,
      thread_id: `${m.source}:${m.threadId}`,
      thread_title: m.threadTitle,
      thread_url: m.threadUrl,
      sent_at: m.sentAt,
      author_name: m.author.name ?? null,
      author_email: m.author.email ?? null,
      text: m.text,
      account_domains: m.accountDomains ?? [],
    })), "id"));
  };
  const batch = await source.fetch(since, until, known, save);

  // One-shot conversations (calls): archived whole, read once.
  const rows: ConversationRow[] = [];
  for (const it of batch.conversations) {
    const emails = [...it.participants.map((p) => p.email ?? ""), ...(it.accountDomains ?? []).map((d) => `account@${d}`)].filter(Boolean);
    const customer = matcher.match(emails, it.title) ?? (it.source === "bluedot" ? await customerByContactName(db, matcher, it.title) : null);
    // Hiring interviews are never stored (Yoshi, Oct 27). A call with a customer on it always is.
    if (!customer && isInterview(it.title, (it.rawJson as { folder?: string | null } | undefined)?.folder)) continue;
    rows.push({
      id: `${it.source}:${it.sourceId}`,
      source: it.source,
      source_id: it.sourceId,
      kind: "call",
      customer_id: customer,
      title: it.title,
      occurred_at: it.occurredAt,
      participants: it.participants,
      url: it.url,
      raw_text: it.rawText,
      raw_json: it.rawJson ?? null,
      // Calls with no customer (team meetings, prospects, vendors) are still read, for product ideas only.
      state: customer || it.source === "bluedot" ? "new" : "skipped",
      skip_reason: customer ? null : it.source === "bluedot" ? "no customer: read for product ideas only" : "no customer on it (internal, prospect or vendor)",
    });
  }
  await db.insertNew("conversations", rows, "id");

  // Chats and email threads: each message stored once; only new messages become work.
  await save(batch.messages);
  const updates = await buildChatUpdates(db, newMsgs, matcher);

  await db.setState(key, { since: until.toISOString() });
  return rows.length + updates;
}

const INTERVIEW_TITLE = /\b(interview|candidate|hiring)\b/i;
export function isInterview(title: string, folder?: string | null): boolean {
  return INTERVIEW_TITLE.test(title) || /hiring|interview/i.test(folder ?? "");
}

/**
 * A call BlueDot recorded without the customer's email (e.g. titled "Jordan Smith"): look for
 * a customer person's FULL name in the title, using names we've seen on customer chats and emails.
 * First names alone are too ambiguous and never match. Only a single, unambiguous customer counts.
 */
async function customerByContactName(db: Db, matcher: Matcher, title: string): Promise<string | null> {
  const names = [...new Set(title.match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2}\b/g) ?? [])];
  const found = new Set<string>();
  for (const n of names) {
    const rows = await db.select<{ author_email: string }>("messages",
      `author_name=ilike.${encodeURIComponent(n)}&author_email=not.is.null&author_email=not.ilike.*%40example.com&select=author_email&limit=20`);
    for (const r of rows) { const id = matcher.match([r.author_email], null); if (id) found.add(id); }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Group newly stored messages into one "chat update" per thread per Pacific day. The update
 * holds that day's messages (plus a few earlier ones marked as background), so Claude reads only
 * what's new. If more messages land later the same day, that day's update is re-read; earlier
 * days are never touched again.
 */
async function buildChatUpdates(db: Db, newMsgs: MessageRow[], matcher: Matcher): Promise<number> {
  const keyOf = (m: MessageRow) => `${m.thread_id}|${ptDate(new Date(m.sent_at))}`;
  const groups = new Map<string, MessageRow[]>();
  for (const m of newMsgs) groups.set(keyOf(m), [...(groups.get(keyOf(m)) ?? []), m]);

  // Self-heal: messages stored in the last 3 days whose daily update was never built (e.g. a
  // previous run failed after saving them) are picked up here.
  const recent = await db.select<MessageRow>("messages", `created_at=gte.${encodeURIComponent(new Date(Date.now() - 3 * 86400_000).toISOString())}&select=*`);
  const recentKeys = [...new Set(recent.map(keyOf))];
  if (recentKeys.length) {
    const ids = recentKeys.map((k) => k.replace("|", ":"));
    // Checked in batches so the request stays short even after a big backfill.
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map((id) => `"${encodeURIComponent(id)}"`).join(",");
      for (const r of await db.select<{ id: string }>("conversations", `id=in.(${chunk})&select=id`)) have.add(r.id);
    }
    for (const m of recent) if (!have.has(keyOf(m).replace("|", ":")) && !groups.has(keyOf(m))) groups.set(keyOf(m), [m]);
  }

  const line = (m: MessageRow) => `[${m.sent_at.slice(0, 16).replace("T", " ")} UTC] ${m.author_name ?? m.author_email ?? "Unknown"}: ${m.text}`;
  const enc = (t: string) => encodeURIComponent(t);
  // Slack team channels are read by Claude only once control.team_slack_read is on; until then
  // their updates wait as "held" (switching it on also moves held -> new).
  const teamRead = (await db.getState<Control>("control"))?.team_slack_read === true;
  const customersNamed = (m: MessageRow) => [...new Set((m.account_domains ?? []).map((d) => matcher.match([`account@${d}`], null)).filter((id): id is string => Boolean(id)))];

  for (const [k, msgs] of groups) {
    const [threadId, day] = k.split("|");
    const first = msgs[0];
    const earliest = msgs.reduce((t, m) => (m.sent_at < t ? m.sent_at : t), msgs[0].sent_at);
    // All of that day's messages for the thread (some may have been stored on an earlier run).
    const window = await db.select<MessageRow>("messages",
      `thread_id=eq.${enc(threadId)}&sent_at=gte.${enc(new Date(new Date(earliest).getTime() - 86400_000).toISOString())}&select=*&order=sent_at.asc`);
    const today = window.filter((m) => ptDate(new Date(m.sent_at)) === day);
    if (!today.length) continue;
    const before = await db.select<MessageRow>("messages",
      `thread_id=eq.${enc(threadId)}&sent_at=lt.${enc(today[0].sent_at)}&select=*&order=sent_at.desc&limit=8`);

    const text = [
      before.length ? `Earlier messages (background only, already recorded):\n${before.reverse().map(line).join("\n")}\n` : "",
      `New messages:\n${today.map(line).join("\n")}`,
    ].join("\n");

    // Match on everyone in the thread (today plus the earlier background messages), so a day where
    // only our team replied still lands on the customer the thread is with.
    const thread = [...before, ...today];
    const emails = [...new Set([
      ...thread.map((m) => m.author_email ?? ""),
      ...thread.flatMap((m) => m.account_domains ?? []).map((d) => `account@${d}`),
    ].filter(Boolean))];
    // Slack team channels (#team-a, #team-b, ...): unless a customer person writes in the
    // channel (a shared channel), the day is read for product ideas with no customer, and the
    // messages that name a customer become a small update of their own for that customer.
    if (threadId.startsWith("slack:team:")) {
      const authors = [...new Set(thread.map((m) => m.author_email ?? "").filter(Boolean))];
      if (!matcher.match(authors, null)) {
        const state = teamRead ? "new" : "held";
        const base = {
          source: first.source, kind: "team_update", thread_id: threadId, url: first.thread_url, occurred_at: today[0].sent_at,
          state, skip_reason: teamRead ? null : "team channel: waiting for control.team_slack_read", attempts: 0,
        };
        const people = (ms: MessageRow[]) => [...new Map(ms.map((m) => [m.author_email ?? m.author_name, { name: m.author_name ?? undefined, email: m.author_email ?? undefined }])).values()];
        await db.upsert<ConversationRow>("conversations", {
          ...base, id: `${threadId}:${day}`, source_id: `${threadId.split(":").slice(1).join(":")}:${day}`,
          customer_id: null, title: `${first.thread_title ?? "Slack"} (${day})`, participants: people(today), raw_text: text,
        });
        const named = new Map<string, MessageRow[]>();
        for (const m of today) for (const id of customersNamed(m)) named.set(id, [...(named.get(id) ?? []), m]);
        for (const [id, ms] of named) {
          const earlier = before.filter((m) => customersNamed(m).includes(id)).slice(-5);
          await db.upsert<ConversationRow>("conversations", {
            ...base, kind: "chat_update", id: `${threadId}:${day}:${id}`, source_id: `${threadId.split(":").slice(1).join(":")}:${day}:${id}`,
            customer_id: id, title: `${first.thread_title ?? "Slack"}, messages naming the customer (${day})`, participants: people(ms),
            raw_text: [
              earlier.length ? `Earlier messages (background only, already recorded):\n${earlier.map(line).join("\n")}\n` : "",
              `New messages:\n${ms.map(line).join("\n")}`,
            ].join("\n"),
          });
        }
        continue;
      }
    }

    // Chats and emails match by the people in them only, never by title (privacy rule: a chat
    // named after a customer with only our team in it is internal and is not collected).
    const customer = matcher.match(emails, null);
    await db.upsert<ConversationRow>("conversations", {
      id: `${threadId}:${day}`,
      source: first.source,
      source_id: `${threadId.split(":").slice(1).join(":")}:${day}`,
      kind: "chat_update",
      thread_id: threadId,
      customer_id: customer,
      title: `${first.thread_title ?? "Chat"} (${day})`,
      occurred_at: today[0].sent_at,
      participants: [...new Map(today.map((m) => [m.author_email ?? m.author_name, { name: m.author_name ?? undefined, email: m.author_email ?? undefined }])).values()],
      url: first.thread_url,
      raw_text: text,
      state: customer ? "new" : "skipped",
      skip_reason: customer ? null : "no customer on it (internal, prospect or vendor)",
      attempts: 0,
    });
  }
  return groups.size;
}

// ---------- read one conversation ----------

/** Emails and 1:1 DMs: Notion shows the business point, never the person's exact words. The quote
 *  is still extracted (so the point stays checkable) but kept only in the locked archive. */
function isPrivate(c: Pick<ConversationRow, "source" | "title">): boolean {
  return c.source === "email" || /^(Google Chat DM|Teams 1:1)/.test(c.title ?? "");
}

async function readOne(env: Env, db: Db, prompts: Prompts, c: ConversationRow, customer: CustomerRow): Promise<void> {
  const read = await readConversation(env, prompts, {
    customerName: customer.name, source: SOURCE_LABEL[c.source] ?? c.source, title: c.title ?? "", occurredAt: c.occurred_at, text: c.raw_text,
    private: isPrivate(c),
  });

  const insights: InsightRow[] = read.insights.map((i) => ({
    conversation_id: c.id,
    customer_id: c.customer_id,
    type: i.type,
    text: i.text,
    who: i.who || null,
    owner_side: i.owner_side === "None" ? null : i.owner_side,
    quote: i.quote || null,
    quote_time: i.quote_time || null,
    status: i.status,
    occurred_at: c.occurred_at,
  }));
  // Clear any partial insights from an earlier attempt (or this chat-day's earlier read), then insert fresh.
  await db.delete("insights", `conversation_id=eq.${encodeURIComponent(c.id)}`);
  if (insights.length) await db.insertReturning<InsightRow>("insights", insights);

  await db.update("conversations", `id=eq.${encodeURIComponent(c.id)}`, {
    summary: read.summary, extraction: read, state: "extracted", error: null, extracted_at: new Date().toISOString(),
  });
}

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com", "live.com", "me.com"]);

/** "Internal team meeting" / "Call with a prospect or vendor (vendor.example)" from who was on the call. */
function callLabel(c: Pick<ConversationRow, "participants">): string {
  const doms = [...new Set((c.participants ?? []).map((p) => (p.email ?? "").split("@")[1]?.toLowerCase()).filter((d): d is string => Boolean(d)))];
  const outside = doms.filter((d) => d !== "example.com");
  if (!outside.length) return "Internal team meeting";
  const named = outside.filter((d) => !FREE_MAIL.has(d));
  return named.length ? `Call with a prospect or vendor (${named.join(", ")})` : "Call with someone outside Alleviate (personal email)";
}

/** A call with no customer on it: read for product ideas; insights are saved with no customer. */
async function readInternal(env: Env, db: Db, c: ConversationRow): Promise<void> {
  const slackDay = c.kind === "team_update";
  const read = await readInternalCall(env, {
    label: slackDay ? "One day of an internal Alleviate Slack channel" : callLabel(c), title: c.title ?? "", occurredAt: c.occurred_at, text: c.raw_text, chat: slackDay,
  });
  const insights: InsightRow[] = read.insights.map((i) => ({
    conversation_id: c.id,
    customer_id: null,
    type: i.type,
    text: i.text,
    who: i.who || null,
    owner_side: i.owner_side === "None" ? null : i.owner_side,
    quote: i.quote || null,
    quote_time: i.quote_time || null,
    status: i.status,
    occurred_at: c.occurred_at,
  }));
  await db.delete("insights", `conversation_id=eq.${encodeURIComponent(c.id)}`);
  if (insights.length) await db.insertReturning<InsightRow>("insights", insights);
  await db.update("conversations", `id=eq.${encodeURIComponent(c.id)}`, {
    summary: read.summary, extraction: read, state: "extracted", error: null, extracted_at: new Date().toISOString(),
  });
}

// ---------- weekly stage ----------

function conversationDigest(c: ConversationRow, withQuotes: boolean): string {
  const r = c.extraction as ConversationRead | null;
  const lines = [`### ${SOURCE_NOUN[c.source] ?? c.source}, ${c.occurred_at.slice(0, 10)}: ${c.title ?? ""}`, `Link: ${c.url ?? "none"}`, `Summary: ${c.summary ?? ""}`];
  if (r) {
    if (r.people.length) lines.push(`People: ${r.people.map((p) => `${p.name} (${p.company})`).join("; ")}`);
    for (const t of r.tasks) lines.push(`- Task [${t.side}, ${t.state}] ${t.who ? `${t.who}: ` : ""}${t.text}`);
    for (const i of r.insights) lines.push(`- ${i.type}: ${i.text}${withQuotes && !isPrivate(c) && i.quote ? ` | quote: "${i.quote}"${i.quote_time ? ` (${i.quote_time})` : ""}` : ""}`);
  }
  return lines.join("\n");
}

/** Last week's Account Brief, stored inside the customer's latest weekly report row. */
async function previousBriefText(db: Db, customerId: string): Promise<string> {
  const rows = await db.select<{ report: { brief?: { markdown?: string } } }>("weekly_reports",
    `customer_id=eq.${customerId}&select=report&order=week_of.desc&limit=1`);
  return rows[0]?.report?.brief?.markdown ?? "";
}

function reportMarkdown(r: ReportOut): string {
  const sec = (h: string, items: string[]) => `### ${h}\n${(items.length ? items : ["_Nothing noted_"]).map((i) => `- ${i}`).join("\n")}`;
  return [
    sec("Tasks completed by Alleviate Team", r.alleviate_done),
    sec("Tasks completed by Customer Team", r.customer_done),
    sec("Tasks that need to be done by Alleviate Team", r.alleviate_todo),
    sec("Tasks that need to be done by Customer Team", r.customer_todo),
    sec("Sentiment", r.sentiment.map((s) => `${s.kind === "praise" ? "👍" : "⚠️"} ${s.text}`)),
  ].join("\n\n");
}

function digestSection(c: CustomerRow, convs: ConversationRow[], r: ReportOut, reportPageId: string | null): string {
  const links = convs.map((x) => (x.url ? `[${short(x.occurred_at)} ${SOURCE_NOUN[x.source] ?? x.source}](${x.url})` : `${short(x.occurred_at)} ${SOURCE_NOUN[x.source]}`)).join(", ");
  const brief = c.notion_page_id ? ` · [Account Brief](https://www.notion.so/${c.notion_page_id.replace(/-/g, "")})` : "";
  const report = reportPageId ? ` · [Weekly Report](https://www.notion.so/${reportPageId.replace(/-/g, "")})` : "";
  return [
    `## ${c.name}${c.status === "Pilot" ? " (Pilot)" : ""}`,
    `${convs.length} conversation${convs.length === 1 ? "" : "s"}: ${links}${brief}${report}`,
    reportMarkdown(r),
  ].join("\n");
}

const AT_RISK = new Set(["At Risk", "Unhappy", "Frustrated"]);

async function weeklyStage(env: Env, db: Db, prompts: Prompts, customers: CustomerRow[], timeLeft: () => number, force: boolean, control: Control | null): Promise<string> {
  const now = new Date();
  const reportAt = lastReportTime(now, num(env.REPORT_WEEKDAY, 2), num(env.REPORT_HOUR_PT, 18));
  const weekOf = ptDate(reportAt);
  const from = new Date(reportAt.getTime() - 7 * 86400_000);

  const runs = await db.select<{ state: string; detail: Record<string, unknown> }>("runs", `week_of=eq.${weekOf}&select=state,detail`);
  let run = runs[0];
  if (run?.state === "posted") return `week ${weekOf} already posted`;
  if (!run) {
    // Only start once this week's report time has passed less than 2 days ago (so a fresh
    // deploy mid-week doesn't fire a report for an old week), unless forced.
    if (!force && now.getTime() - reportAt.getTime() > 2 * 86400_000) return `waiting for next report time`;
    run = { state: "reports", detail: {} };
    await db.upsert("runs", { week_of: weekOf, state: "reports" });
  }

  // Give unread conversations from the week a chance to be read first (up to 3 hours).
  const unread = await db.select<{ id: string }>("conversations",
    `state=in.(new,error)&attempts=lt.3&customer_id=not.is.null${sourceFilter(control)}&occurred_at=lt.${reportAt.toISOString()}&select=id&limit=1`);
  if (unread.length && now.getTime() - reportAt.getTime() < 3 * 3600_000 && !force) return `week ${weekOf}: waiting for conversations to finish reading`;

  const weekConvs = await db.select<ConversationRow>("conversations",
    `state=eq.extracted&occurred_at=gte.${from.toISOString()}&occurred_at=lt.${reportAt.toISOString()}&select=id,source,customer_id,title,occurred_at,url,summary,extraction&order=occurred_at.asc`);
  const byCustomer = new Map<string, ConversationRow[]>();
  for (const c of weekConvs) if (c.customer_id) byCustomer.set(c.customer_id, [...(byCustomer.get(c.customer_id) ?? []), c]);

  const done = new Set((await db.select<{ customer_id: string }>("weekly_reports", `week_of=eq.${weekOf}&select=customer_id`)).map((r) => r.customer_id));
  const label = rangeLabel(from, reportAt);

  for (const c of customers) {
    const convs = byCustomer.get(c.attio_record_id);
    if (!convs || done.has(c.attio_record_id)) continue;
    if (timeLeft() < 3 * 60_000) return `week ${weekOf}: in progress (${done.size} of ${byCustomer.size} customers)`;

    const report = await writeWeeklyReport(env, prompts, {
      customerName: c.name, weekLabel: label, week: convs.map((x) => conversationDigest(x, true)).join("\n\n"),
    });

    // Living brief from the last ~4 months of history, newest first.
    const history = await db.select<ConversationRow>("conversations",
      `customer_id=eq.${c.attio_record_id}&state=eq.extracted&occurred_at=gte.${new Date(now.getTime() - 120 * 86400_000).toISOString()}&select=id,source,title,occurred_at,url,summary,extraction&order=occurred_at.desc&limit=150`);
    let historyText = "";
    for (const h of history) {
      const d = conversationDigest(h, true);
      if (historyText.length + d.length > 400_000) break;
      historyText += d + "\n\n";
    }
    const prevBrief = await previousBriefText(db, c.attio_record_id);
    const brief = await writeBrief(env, prompts, { customerName: c.name, today: ptDate(now), previousBrief: prevBrief, history: historyText });

    // Notion: the brief replaces the customer page's body; the week's report is its own page.
    let reportPageId: string | null = null;
    if (c.notion_page_id) {
      await replacePageBody(env, c.notion_page_id, markdownToBlocks(brief.brief_markdown));
      await updatePage(env, c.notion_page_id, {
        "Last Contact": prop.date(convs[convs.length - 1].occurred_at),
        Sentiment: prop.select(brief.sentiment),
        "Open Risks": prop.number(brief.open_risks),
        "Brief Updated": prop.date(now.toISOString()),
      });
      reportPageId = await createPage(env, env.NOTION_REPORTS_DS, {
        Report: prop.title(`${c.name}: ${label}`),
        Customer: prop.relation([c.notion_page_id]),
        "Week Of": prop.date(weekOf),
        "Conversations Count": prop.number(convs.length),
        Sentiment: prop.select(report.overall),
      }, markdownToBlocks(reportMarkdown(report)));
    }
    // Supabase keeps everything too; the brief rides inside the weekly report row, so every week's brief is kept.
    await db.upsert("weekly_reports", { customer_id: c.attio_record_id, week_of: weekOf, notion_page_id: reportPageId,
      report: { ...report, brief: { markdown: brief.brief_markdown, sentiment: brief.sentiment, open_risks: brief.open_risks } } });
    done.add(c.attio_record_id);
  }

  // All customers written: build the week's digest page in Notion (also saved in the runs row), then optionally post to Slack.
  const reports = await db.select<{ customer_id: string; report: ReportOut; notion_page_id: string | null }>("weekly_reports", `week_of=eq.${weekOf}&select=customer_id,report,notion_page_id`);
  const reportBy = new Map(reports.map((r) => [r.customer_id, r]));
  const ordered = customers
    .filter((c) => reportBy.has(c.attio_record_id))
    .sort((a, b) => (byCustomer.get(b.attio_record_id)?.length ?? 0) - (byCustomer.get(a.attio_record_id)?.length ?? 0));
  const quiet = customers.filter((c) => !byCustomer.has(c.attio_record_id)).map((c) => c.name).sort();
  const skipped = (await db.select<{ id: string }>("conversations",
    `state=eq.skipped&occurred_at=gte.${from.toISOString()}&occurred_at=lt.${reportAt.toISOString()}&select=id`)).length;
  const atRisk = ordered.filter((c) => AT_RISK.has(reportBy.get(c.attio_record_id)!.report.overall)).map((c) => c.name);

  const digest = [
    `${weekConvs.length} customer conversations across ${ordered.length} accounts.${atRisk.length ? ` Flagged at risk: **${atRisk.join(", ")}**.` : ""}`,
    ...ordered.map((c) => digestSection(c, byCustomer.get(c.attio_record_id)!, reportBy.get(c.attio_record_id)!.report, reportBy.get(c.attio_record_id)!.notion_page_id)),
    ...(prompts.slack.includeNoContact && quiet.length ? [`## No customer contact this week (${quiet.length})`, quiet.join(", ")] : []),
    `*Skipped ${skipped} conversations with no customer on them.*`,
  ].join("\n\n");

  // Product ideas from the whole week: customers, prospects and internal meetings.
  let digestFull = digest;
  try {
    const ideas = await db.select<{ type: string; text: string; who: string | null; customer_id: string | null; occurred_at: string; conversation_id: string }>("insights",
      `type=in.(%22Product%20idea%22,Request,%22Product%20feedback%22)&occurred_at=gte.${from.toISOString()}&occurred_at=lt.${reportAt.toISOString()}&select=type,text,who,customer_id,occurred_at,conversation_id&order=occurred_at.asc&limit=500`);
    if (ideas.length) {
      const convIds = [...new Set(ideas.filter((i) => !i.customer_id).map((i) => i.conversation_id))];
      const convs = new Map<string, ConversationRow>();
      for (let i = 0; i < convIds.length; i += 50) {
        const chunk = convIds.slice(i, i + 50).map((id) => `"${encodeURIComponent(id)}"`).join(",");
        for (const r of await db.select<ConversationRow>("conversations", `id=in.(${chunk})&select=id,title,url,participants`)) convs.set(r.id, r);
      }
      const nameOf = new Map(customers.map((c) => [c.attio_record_id, c.name]));
      const items = ideas.map((i) => {
        const conv = convs.get(i.conversation_id);
        const from = i.customer_id ? `Customer: ${nameOf.get(i.customer_id) ?? "customer"}`
          : conv && callLabel(conv).startsWith("Internal") ? `Internal: ${conv.title ?? "team meeting"}` : `Prospect/vendor: ${conv?.title ?? "call"}`;
        return `- [${i.type}] ${i.text} (${i.who ?? "unknown"}; ${from}; ${i.occurred_at.slice(0, 10)}${conv?.url ? `; ${conv.url}` : ""})`;
      }).join("\n");
      digestFull = `${digest}\n\n## Product ideas this week\n\n${await writeProductIdeas(env, { weekLabel: label, items })}`;
    }
  } catch (err) {
    digestFull = `${digest}\n\n## Product ideas this week\n\n_Could not be written this week: ${err instanceof Error ? err.message : err}_`;
  }

  const digestPageId = await createPage(env, env.NOTION_DIGESTS_DS, {
    Digest: prop.title(`Customer Weekly Digest · ${label}`),
    "Week Of": prop.date(weekOf),
    Accounts: prop.number(ordered.length),
    Conversations: prop.number(weekConvs.length),
    "At Risk": prop.number(atRisk.length),
  }, markdownToBlocks(digestFull));
  const digestUrl = `https://www.notion.so/${digestPageId.replace(/-/g, "")}`;

  const headline = `*Customer Weekly Digest · ${label}* is up: ${weekConvs.length} conversations across ${ordered.length} accounts` +
    (atRisk.length ? `, ${atRisk.length} flagged at risk (${esc(atRisk.join(", "))})` : "") + `.\n<${digestUrl}|Open the digest in Notion>`;
  const links = control?.slack_post ? await postMessages(env, [headline]) : [];
  if (links[0]) await updatePage(env, digestPageId, { "Slack Post": prop.url(links[0]) });
  await db.upsert("runs", { week_of: weekOf, state: "posted", finished_at: new Date().toISOString(), detail: { digest: digestUrl, digest_text: digestFull, slack: links, customers: ordered.length } });
  return `week ${weekOf}: digest ${digestUrl} (${ordered.length} customers${links.length ? ", posted to Slack" : ", no Slack post"})`;
}
