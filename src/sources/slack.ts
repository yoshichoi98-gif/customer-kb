// Slack: every public channel in our workspace, read with the "Customer Weekly Digest" bot.
//
// Two kinds of channel:
//   - Customer channels: "<customer>-deploy" (+ any channel in SLACK_EXTRA_CHANNELS, e.g. the private
//     Slack Connect channels shared with Harbor Clinical, added Nov 11; the bot must be invited to a
//     private channel). Every message belongs to that customer, as before.
//   - Team channels: every other public channel (#team-a, #team-b, ...). Stored as
//     internal team chat. A message that names a customer ("Q7 is unhappy") is tied to that
//     customer (Yoshi, Nov 2); a reply counts as naming the customer when its thread's first
//     message does. Their messages are stored with thread id "team:<channel id>".
//
// Left out on purpose (never joined, never read), all Yoshi's calls on Nov 2: social channels,
// hiring / recruiting channels (same reason BlueDot interviews are never stored), test channels,
// plus the channels named in SLACK_SKIP_CHANNELS (bot alert feeds and any channel that
// carries personal data). The full included / excluded list is saved each run to
// source_state "slack:channels" (read it locally).
//
// Team channels are only pulled when source_state "control" has slack_team_channels: true, so the
// list can be checked before the bot joins anything.
//
// Each message is stored once. Thread replies are included: every run looks at the last 14 days
// of each channel and re-reads only threads with a reply newer than the last one stored.
//
// Bot scopes needed: channels:read, channels:history, channels:join, users:read, users:read.email
// (+ groups:read, groups:history for a private shared channel).

import type { Env } from "../env.ts";
import type { Db } from "../db.ts";
import type { ChatMessage, Source } from "./types.ts";

const API = "https://slack.com/api";
const THREAD_WINDOW_DAYS = 14;

// Social and hiring channels, by name. Checked against the whole channel name.
const SKIP_SOCIAL = /(^|[-_])(random|social|fun|watercooler|water-cooler|celebrations?|birthdays?|pets?|food|lunch|music|memes?|off-?topic|shoutouts?|kudos|games?|sports|books?|travel|photos?|intros?|introductions)([-_]|$)/;
const SKIP_TEST = /(^|[-_])test([-_]|$)/;
const SKIP_HIRING = /(hiring|recruit|interview|candidates?|talent|careers?|(^|[-_])jobs?([-_]|$)|(^|[-_])hr([-_]|$)|people-ops|payroll|benefits|onboarding-new-hires?)/;

interface Channel { id: string; name: string; is_member?: boolean; is_archived?: boolean; is_private?: boolean; is_ext_shared?: boolean; num_members?: number; purpose?: { value?: string } }
interface SlackMsg { ts: string; thread_ts?: string; reply_count?: number; latest_reply?: string; user?: string; bot_id?: string; subtype?: string; text?: string; username?: string }
interface State { channels: Record<string, string>; threads: Record<string, Record<string, string>> } // channel -> last ts; channel -> {thread_ts: last reply ts}
export interface ChannelList {
  at: string;
  team_channels_on: boolean;
  included: { id: string; name: string; kind: "customer" | "team"; customer?: string; members?: number }[];
  excluded: { id: string; name: string; reason: string; members?: number }[];
}

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "bot_add", "bot_remove", "pinned_item", "channel_archive"]);

export function slackSource(
  env: Env,
  db: Db,
  customerForChannel: (name: string) => { name: string; domains: string[] } | null,
  mentionedDomains: (text: string) => string[],
): Source {
  const token = () => (env.SLACK_BOT_TOKEN ?? "").trim();

  async function slack<T>(method: string, params: Record<string, string>, attempt = 0): Promise<T> {
    const r = await fetch(`${API}/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (r.status === 429 && attempt < 5) {
      await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 2) * 1000));
      return slack<T>(method, params, attempt + 1);
    }
    const body = (await r.json()) as { ok: boolean; error?: string; needed?: string } & T;
    if (!body.ok) throw new Error(`slack ${method} -> ${body.error}${body.needed ? ` (needs scope ${body.needed})` : ""}`);
    return body;
  }

  return {
    name: "slack",
    async enabled() { return Boolean(token()); },
    async fetch(_since, _until, _known, save) {
      const control = (await db.getState<{ slack_team_channels?: boolean }>("control")) ?? {};
      const teamOn = control.slack_team_channels === true;

      // --- which channels
      // SLACK_EXTRA_CHANNELS: "channel id or name=customer", comma-separated. Private channels (e.g.
      // one shared with the customer) are listed here and need the bot invited; it can't join them.
      const extra = new Map<string, string>(); // channel id or name -> customer name or nickname
      for (const pair of (env.SLACK_EXTRA_CHANNELS ?? "").split(",")) {
        const [key, name] = pair.split("=").map((s) => s?.trim());
        if (key && name) extra.set(key.replace(/^#/, "").toLowerCase(), name);
      }
      const extraFor = (c: Channel) => extra.get(c.id.toLowerCase()) ?? extra.get(c.name.toLowerCase());
      // SLACK_SKIP_CHANNELS: "name" or "name=reason", comma-separated.
      const skipNames = new Map((env.SLACK_SKIP_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
        .map((s) => { const [n, r] = s.split("="); return [n.trim().replace(/^#/, "").toLowerCase(), r?.trim() || "left out by hand"] as const; }));
      const channels: Channel[] = [];
      let cursor = "";
      do {
        const r = await slack<{ channels: Channel[]; response_metadata?: { next_cursor?: string } }>("conversations.list", {
          types: extra.size ? "public_channel,private_channel" : "public_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}),
        });
        channels.push(...r.channels);
        cursor = r.response_metadata?.next_cursor ?? "";
      } while (cursor);

      const list: ChannelList = { at: new Date().toISOString(), team_channels_on: teamOn, included: [], excluded: [] };
      const picked: (Channel & { kind: "customer" | "team"; domains?: string[]; customer?: string })[] = [];
      const found = new Set<string>();
      for (const c of channels.sort((a, b) => a.name.localeCompare(b.name))) {
        const members = c.num_members;
        const listed = extraFor(c);
        if (listed) found.add(extra.get(c.id.toLowerCase()) !== undefined ? c.id.toLowerCase() : c.name.toLowerCase());
        if (c.is_private && !listed) {
          // Private channels the bot was invited to are read only when listed by hand.
          list.excluded.push({ id: c.id, name: c.name, reason: "private channel, not listed in SLACK_EXTRA_CHANNELS", members });
          continue;
        }
        const customer = listed || /-deploy$/.test(c.name) ? customerForChannel(listed ?? c.name.replace(/-deploy$/, "")) : null;
        if (customer) {
          picked.push({ ...c, kind: "customer", domains: customer.domains, customer: customer.name });
          list.included.push({ id: c.id, name: c.name, kind: "customer", customer: customer.name, members });
          continue;
        }
        const reason = skipNames.get(c.name) ?? (SKIP_HIRING.test(c.name) ? "hiring / recruiting" : SKIP_SOCIAL.test(c.name) ? "social" : SKIP_TEST.test(c.name) ? "test channel" : null);
        if (reason) { list.excluded.push({ id: c.id, name: c.name, reason, members }); continue; }
        list.included.push({ id: c.id, name: c.name, kind: "team", members });
        if (teamOn) picked.push({ ...c, kind: "team" });
      }
      // Listed by hand but not visible to the bot: a private channel it hasn't been invited to yet.
      for (const [key, name] of extra) if (!found.has(key)) {
        list.excluded.push({ id: /^[cg][a-z0-9]{8,}$/.test(key) ? key.toUpperCase() : "", name: key, reason: `listed for ${name}, but the bot isn't in it (private), so it can't be read` });
      }
      await db.setState("slack:channels", list);

      // Our own bot's posts (the weekly digest line) are never stored.
      const me = await slack<{ user_id?: string; bot_id?: string; team_id?: string }>("auth.test", {});

      // --- who's who (cached per run)
      const users = new Map<string, { name: string; email?: string; team?: string }>();
      const who = async (id?: string): Promise<{ name: string; email?: string; team?: string }> => {
        if (!id) return { name: "Unknown" };
        if (!users.has(id)) {
          try {
            const r = await slack<{ user: { real_name?: string; name?: string; team_id?: string; profile?: { email?: string; real_name?: string } } }>("users.info", { user: id });
            users.set(id, { name: r.user.profile?.real_name || r.user.real_name || r.user.name || id, email: r.user.profile?.email?.toLowerCase(), team: r.user.team_id });
          } catch { users.set(id, { name: id }); }
        }
        return users.get(id)!;
      };
      const readable = async (text: string) => {
        let out = text;
        for (const m of text.matchAll(/<@([UW][A-Z0-9]+)>/g)) out = out.replace(m[0], `@${(await who(m[1])).name}`);
        return out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1").replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      };

      const st = (await db.getState<State>("cursor:slack:channels")) ?? { channels: {}, threads: {} };
      const backfillFrom = String((Date.now() - Number(env.BACKFILL_DAYS || 30) * 86400_000) / 1000);
      const windowFrom = (Date.now() - THREAD_WINDOW_DAYS * 86400_000) / 1000;

      const errors: string[] = [];
      for (const ch of picked) {
        try {
          if (!ch.is_member && !ch.is_private) await slack("conversations.join", { channel: ch.id });
          const messages: ChatMessage[] = [];
          const after = st.channels[ch.id] ?? backfillFrom;
          const threads = (st.threads[ch.id] ??= {});
          const team = ch.kind === "team";
          const push = async (m: SlackMsg, parent?: SlackMsg) => {
            if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) return;
            if ((me.user_id && m.user === me.user_id) || (me.bot_id && m.bot_id === me.bot_id)) return;
            const text = (await readable(m.text ?? "")).trim();
            if (!text) return;
            const u: { name: string; email?: string; team?: string } = m.user ? await who(m.user) : { name: m.username || "Bot" };
            // In a channel shared with the customer, their people are marked with the company name
            // ("Jane Doe (Harbor Clinical)") so the reader can tell the two sides apart.
            const outsider = !team && ch.customer && u.team && me.team_id && u.team !== me.team_id;
            const parentText = parent ? await readable(parent.text ?? "") : "";
            const parentLine = parent ? `(reply in thread "${parentText.slice(0, 80)}") ` : "";
            messages.push({
              source: "slack",
              threadId: team ? `team:${ch.id}` : ch.id,
              threadTitle: team ? `Slack #${ch.name} (team channel)` : `Slack #${ch.name} (${ch.is_ext_shared ? "shared with the customer" : "internal team channel"})`,
              threadUrl: `https://slack.com/app_redirect?channel=${ch.id}`,
              messageId: `${ch.id}:${m.ts}`,
              sentAt: new Date(Number(m.ts) * 1000).toISOString(),
              author: { name: outsider ? `${u.name} (${ch.customer})` : u.name, email: u.email },
              text: `${parentLine}${text}`,
              // Team channels: the customers this message (or its thread's first message) names.
              accountDomains: team ? mentionedDomains(`${parentText}\n${text}`) : ch.domains!,
            });
          };

          // Last 14 days of the channel (or since the backfill start on its first run): new top-level
          // messages, plus any thread whose latest reply is newer than what's stored.
          const oldest = String(Math.min(Number(after), windowFrom));
          let newest = after;
          const reread: SlackMsg[] = [];
          let c = "";
          do {
            const r = await slack<{ messages: SlackMsg[]; response_metadata?: { next_cursor?: string } }>("conversations.history", {
              channel: ch.id, oldest, limit: "200", ...(c ? { cursor: c } : {}),
            });
            for (const m of r.messages) {
              if (Number(m.ts) > Number(after)) await push(m);
              if (Number(m.ts) > Number(newest)) newest = m.ts;
              // A thread we haven't tracked yet is read in full; replies already stored are skipped.
              const seen = threads[m.ts] ?? "0";
              if (m.reply_count && m.latest_reply && Number(m.latest_reply) > Number(seen)) reread.push(m);
            }
            c = r.response_metadata?.next_cursor ?? "";
          } while (c);

          for (const parentMsg of reread) {
            const seen = threads[parentMsg.ts] ?? "0";
            let last = seen;
            let rc = "";
            do {
              const r = await slack<{ messages: SlackMsg[]; response_metadata?: { next_cursor?: string } }>("conversations.replies", {
                channel: ch.id, ts: parentMsg.ts, limit: "200", ...(seen === "0" ? {} : { oldest: seen }), ...(rc ? { cursor: rc } : {}),
              });
              const parent = r.messages.find((m) => m.ts === parentMsg.ts) ?? parentMsg;
              for (const m of r.messages) {
                if (m.ts === parentMsg.ts || Number(m.ts) <= Number(seen)) continue;
                await push(m, parent);
                if (Number(m.ts) > Number(last)) last = m.ts;
              }
              rc = r.response_metadata?.next_cursor ?? "";
            } while (rc);
            threads[parentMsg.ts] = last;
          }
          // Stop tracking threads older than the 14-day window (their replies so far are stored).
          for (const ts of Object.keys(threads)) if (Number(ts) < windowFrom) delete threads[ts];
          st.channels[ch.id] = newest;

          // Saved channel by channel, so a run that gets cut off keeps what it already read.
          await save(messages);
          await db.setState("cursor:slack:channels", st);
        } catch (err) {
          // One channel failing (e.g. the bot can't join it) doesn't stop the others.
          errors.push(`#${ch.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (errors.length) await db.setState("slack:channels", { ...list, errors });
      return { conversations: [], messages: [] };
    },
  };
}
