// Microsoft Teams chats (1:1, group and meeting chats; not channels), for everyone who signed
// in on /connect. Privacy rule: a chat is read only if one of its members has a customer email
// domain. A chat merely named after a customer, with only our team in it, is skipped, and so is
// every other chat, without reading its messages.
//
// A chat that several signed-in people share is stored once: messages are keyed by Teams'
// own message id, and the thread is the chat id.

import type { Env } from "../env.ts";
import type { Db } from "../db.ts";
import type { ChatMessage, Source } from "./types.ts";
import { accessToken, listConnections } from "../connections.ts";
import { stripHtml } from "../text.ts";
import { SkippedDomains } from "../audit.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface Member { displayName?: string; email?: string; userId?: string }
interface Chat { id: string; topic?: string | null; chatType?: string; webUrl?: string; members?: Member[] }
interface TeamsMsg {
  id: string; messageType?: string; createdDateTime: string; deletedDateTime?: string | null;
  from?: { user?: { id?: string; displayName?: string } } | null; body?: { contentType?: string; content?: string };
}

export function teamsSource(env: Env, db: Db, isCustomer: (emails: string[]) => boolean): Source {
  return {
    name: "teams",
    async enabled() { return Boolean(env.MS_CLIENT_ID) && (await listConnections(db, "microsoft")).length > 0; },
    async fetch(_since, _until, _known, save) {
      const messages: ChatMessage[] = [];
      for (const conn of await listConnections(db, "microsoft")) {
        let token: string;
        try { token = await accessToken(env, db, conn); } catch { continue; }
        const get = async <T>(url: string): Promise<T> => {
          const r = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, { headers: { Authorization: `Bearer ${token}` } });
          if (r.status === 429) { await new Promise((res) => setTimeout(res, 2000)); return get<T>(url); }
          if (!r.ok) throw new Error(`teams ${url.split("?")[0]} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
          return r.json() as Promise<T>;
        };

        const curKey = `cursor:teams:${conn.email}`;
        const cur = await db.getState<{ after: string }>(curKey);
        const after = cur?.after ?? new Date(Date.now() - Number(env.BACKFILL_DAYS || 30) * 86400_000).toISOString();
        const runStarted = new Date().toISOString();

        const skippedDomains = new SkippedDomains(env.HOME_DOMAIN);
        const chats: Chat[] = [];
        let next: string | undefined = `/me/chats?$expand=members&$top=50`;
        while (next) {
          const r: { value?: Chat[]; "@odata.nextLink"?: string } = await get(next);
          chats.push(...(r.value ?? []));
          next = r["@odata.nextLink"];
        }

        for (const chat of chats) {
          const members = chat.members ?? [];
          const emails = members.map((m) => (m.email ?? "").toLowerCase()).filter(Boolean);
          const title = chat.topic || members.map((m) => m.displayName).filter(Boolean).join(", ");
          if (!isCustomer(emails)) { skippedDomains.add(emails); continue; } // not a customer chat: never read
          const emailById = new Map(members.filter((m) => m.userId).map((m) => [m.userId!, (m.email ?? "").toLowerCase()]));

          let mnext: string | undefined =
            `/me/chats/${encodeURIComponent(chat.id)}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${after}`;
          while (mnext) {
            const r: { value?: TeamsMsg[]; "@odata.nextLink"?: string } = await get(mnext);
            for (const m of r.value ?? []) {
              if (m.messageType !== "message" || m.deletedDateTime) continue; // skip system events
              if (m.createdDateTime <= after) continue; // edited old message; already stored
              const text = m.body?.contentType === "html" ? stripHtml(m.body.content ?? "") : (m.body?.content ?? "").trim();
              if (!text) continue;
              messages.push({
                source: "teams",
                threadId: chat.id,
                // "1:1" marks a private conversation: Notion never shows word-for-word quotes from it.
                threadTitle: `${chat.chatType === "oneOnOne" ? "Teams 1:1" : "Teams"}: ${title}`,
                threadUrl: chat.webUrl ?? null,
                messageId: m.id,
                sentAt: m.createdDateTime,
                author: { name: m.from?.user?.displayName, email: m.from?.user?.id ? emailById.get(m.from.user.id) : undefined },
                text,
                accountDomains: [...new Set(emails.map((e) => e.split("@")[1]).filter(Boolean))],
              });
            }
            mnext = r["@odata.nextLink"];
          }
        }
        await save(messages.splice(0));
        await db.setState(curKey, { after: runStarted });
        await skippedDomains.save(db, `skipped_domains:teams:${conn.email}`, "replace");
      }
      return { conversations: [], messages };
    },
  };
}
