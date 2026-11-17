// Customer email, through Pylon (GET /accounts/{id}/email-activities, released Oct 2026).
// Chosen instead of reading anyone's inbox: Pylon only returns email
// threads involving a customer account's contacts, and leaves out emails exchanged only between
// teammates. Coverage = the inboxes the team has synced to Pylon.
//
// Each customer is matched to its Pylon account by the stored pylon_account_id, else by web
// domain. Calendar invites/acceptances and empty bodies are skipped. Pylon already removes the
// quoted history from replies; stripQuotedReply is a safety net.

import type { Env } from "../env.ts";
import type { Db, CustomerRow } from "../db.ts";
import type { ChatMessage, Source } from "./types.ts";
import { stripHtml, stripQuotedReply } from "../text.ts";

interface Activity {
  id: string; account_id: string; happened_at: string;
  messages: {
    id: string; subject: string; message_html: string; timestamp: string;
    contact_id?: string; user_id?: string; issue_id?: string;
    email_info: { from_email: string; to_emails?: string[] | null; cc_emails?: string[] | null };
  }[];
}

const NOISE = /^(invitation|updated invitation|accepted|declined|tentatively accepted|canceled event|cancelled event)\b/i;

export function pylonEmailSource(env: Env, db: Db, customers: CustomerRow[]): Source {
  async function pylon<T>(path: string, attempt = 0): Promise<T> {
    const res = await fetch(`https://api.usepylon.com${path}`, { headers: { Authorization: `Bearer ${(env.PYLON_API_TOKEN ?? "").trim()}` } });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 5) * 1000));
      return pylon<T>(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`pylon ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  return {
    name: "email",
    async enabled() { return Boolean(env.PYLON_API_TOKEN); },
    async fetch(_since, _until, _known, save) {
      // Pylon accounts by domain, for customers without a stored Pylon id.
      const accounts = (await pylon<{ data: { id: string; domains?: string[] }[] }>("/accounts?limit=999")).data;
      const accountFor = (c: CustomerRow) => c.pylon_account_id
        ?? accounts.find((a) => (a.domains ?? []).some((d) => c.domains.includes(d.toLowerCase())))?.id ?? null;

      // Names for senders: our team from /users, customers from /contacts (cached for the run).
      const names = new Map<string, string>();
      for (const u of (await pylon<{ data: { id: string; name?: string }[] }>("/users")).data) if (u.name) names.set(u.id, u.name);
      const contactName = async (id: string) => {
        if (!names.has(id)) {
          try { names.set(id, (await pylon<{ data: { name?: string } }>(`/contacts/${id}`)).data.name ?? ""); }
          catch { names.set(id, ""); }
        }
        return names.get(id) || undefined;
      };

      const backfill = new Date(Date.now() - Number(env.BACKFILL_DAYS || 30) * 86400_000).toISOString();
      // An email can sit under two customers' accounts (e.g. a thread with both Keystone and Altavia):
      // keep it once, tagged with both customers' domains, so it shows up under each.
      const byId = new Map<string, ChatMessage>();
      const cursors: [string, string][] = [];
      for (const c of customers) {
        const acct = accountFor(c);
        if (!acct) continue;
        const curKey = `cursor:pylon_email:${acct}`;
        const after = (await db.getState<{ after: string }>(curKey))?.after;
        // Re-check 3 days back: a thread's time moves forward as replies arrive; stored emails are skipped.
        const start = after ? new Date(Date.parse(after) - 3 * 86400_000).toISOString() : backfill;
        const runStarted = new Date().toISOString();

        let cursor: string | undefined;
        do {
          const q = new URLSearchParams({ start_time: start, limit: "50", ...(cursor ? { cursor } : {}) });
          const r = await pylon<{ data?: Activity[]; pagination?: { cursor?: string; has_next_page?: boolean } }>(`/accounts/${acct}/email-activities?${q}`);
          for (const t of r.data ?? []) {
            const subject = (t.messages[0]?.subject ?? "").replace(/^((re|fw|fwd):\s*)+/i, "").trim() || "(no subject)";
            for (const m of t.messages) {
              if (NOISE.test(m.subject ?? "")) continue;
              const body = stripQuotedReply(stripHtml(m.message_html ?? ""));
              if (!body) continue;
              const e = m.email_info;
              const to = (e.to_emails ?? []).join(", "), cc = (e.cc_emails ?? []).join(", ");
              const seen = byId.get(m.id);
              if (seen) { seen.accountDomains = [...new Set([...(seen.accountDomains ?? []), ...c.domains])]; continue; }
              byId.set(m.id, {
                source: "email",
                threadId: t.id,
                threadTitle: `Email: ${subject}`,
                threadUrl: null,
                messageId: m.id,
                sentAt: m.timestamp,
                author: {
                  name: (m.user_id ? names.get(m.user_id) : m.contact_id ? await contactName(m.contact_id) : undefined) || e.from_email.toLowerCase(),
                  email: e.from_email.toLowerCase(),
                },
                text: `To: ${to || "(none)"}${cc ? ` | Cc: ${cc}` : ""}\n\n${body}`,
                accountDomains: c.domains,
              });
            }
          }
          cursor = r.pagination?.has_next_page ? r.pagination.cursor : undefined;
        } while (cursor);

        cursors.push([curKey, runStarted]);
      }
      // Saved before any cursor moves, so a cut-off run re-reads instead of skipping.
      await save([...byId.values()]);
      for (const [k, at] of cursors) await db.setState(k, { after: at });
      return { conversations: [], messages: [] };
    },
  };
}
