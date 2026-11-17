// Pylon: in-app support chats only (customers' recruiters messaging support from inside the
// Alleviate app - source "chat_widget"). Teams and Google Chat group chats that Pylon also
// captures come through their own sources instead, so nothing is counted twice. Auto-created
// system tickets (tag "auto-created") are skipped; they aren't conversations.
//
// Returns individual messages: the engine stores each one once and only reads what's new, so a
// support thread that gets replies over several days is read one day's update at a time.
//
// Known gap: only issues created in the last 30 days are checked for new replies (Pylon's
// listing window). Replies on older tickets are missed.

import type { Env } from "../env.ts";
import type { ChatMessage, Source } from "./types.ts";
import { stripHtml } from "../text.ts";

interface PylonIssue {
  id: string; number: number; title: string; created_at: string; source: string;
  latest_message_time?: string | null;
  account?: { id: string } | null; tags?: string[] | null;
}
// Shape of GET /issues/{id}/messages on the REST API (differs from Pylon's MCP tool output,
// which says sent_at/body_html).
interface PylonMessage {
  id: string; message_html?: string; timestamp?: string; is_private?: boolean;
  author?: { name?: string; contact?: { email?: string }; user?: { email?: string } };
}

async function pylon<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`https://api.usepylon.com${path}`, { headers: { Authorization: `Bearer ${(env.PYLON_API_TOKEN ?? "").trim()}` } });
  if (!res.ok) throw new Error(`pylon ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function pylonSource(env: Env): Source {
  const accountDomains = new Map<string, string[]>();
  async function domainsFor(accountId: string): Promise<string[]> {
    if (!accountDomains.has(accountId)) {
      const r = await pylon<{ data: { domains?: string[]; domain?: string } }>(env, `/accounts/${accountId}`);
      accountDomains.set(accountId, (r.data.domains ?? (r.data.domain ? [r.data.domain] : [])).map((d) => d.toLowerCase()));
    }
    return accountDomains.get(accountId)!;
  }

  return {
    name: "pylon",
    async enabled() { return Boolean(env.PYLON_API_TOKEN); },
    async fetch(since, until) {
      // Pylon caps a listing at 30 days, so cover the window (at least the last 29 days) in slices.
      const data: PylonIssue[] = [];
      const from = Math.min(since.getTime(), until.getTime() - 29 * 86400_000);
      for (let end = until.getTime(); end > from; end -= 29 * 86400_000) {
        const start = Math.max(from, end - 29 * 86400_000);
        const r = await pylon<{ data: PylonIssue[] }>(env,
          `/issues?start_time=${encodeURIComponent(new Date(start).toISOString())}&end_time=${encodeURIComponent(new Date(end).toISOString())}`);
        data.push(...r.data);
      }
      const messages: ChatMessage[] = [];
      for (const issue of data) {
        if (issue.source !== "chat_widget") continue;
        if ((issue.tags ?? []).includes("auto-created")) continue;
        // Skip threads with no activity since the last pull.
        if (issue.latest_message_time && new Date(issue.latest_message_time) < since) continue;
        const { data: msgs } = await pylon<{ data: PylonMessage[] }>(env, `/issues/${issue.id}/messages`);
        const domains = issue.account?.id ? await domainsFor(issue.account.id) : [];
        for (const m of msgs) {
          if (m.is_private) continue; // internal notes aren't customer conversation
          if (!m.timestamp || new Date(m.timestamp) < since) continue;
          const email = m.author?.contact?.email ?? m.author?.user?.email;
          messages.push({
            source: "pylon",
            threadId: issue.id,
            threadTitle: `Support chat #${issue.number}: ${issue.title}`,
            threadUrl: `https://app.usepylon.com/issues?issueNumber=${issue.number}`,
            messageId: m.id,
            sentAt: m.timestamp,
            author: { name: m.author?.name ?? (m.author?.contact ? "Customer" : "Alleviate"), email: email?.toLowerCase() },
            text: stripHtml(m.message_html ?? ""),
            accountDomains: domains,
          });
        }
      }
      return { conversations: [], messages };
    },
  };
}
