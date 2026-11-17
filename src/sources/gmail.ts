// Gmail, for everyone who signed in on /connect.
//
// Privacy by design: for each new email the engine first reads only the headers (From/To/Cc).
// The body is fetched only when someone from a customer's domain is on the email; everything
// else (internal, vendors, newsletters, personal) is never opened or stored.
//
// The same email often sits in several people's inboxes. It's stored once, keyed by its
// Message-ID header, and grouped into a thread by the first Message-ID in its References chain,
// which is the same for every recipient.
//
// Each person has their own cursor, so a slow inbox never holds up the others, and a run caps
// how many emails it checks per person (the next run continues where it stopped).

import type { Env } from "../env.ts";
import type { Db } from "../db.ts";
import type { ChatMessage, Source } from "./types.ts";
import { accessToken, listConnections } from "../connections.ts";
import { parseAddresses, stripHtml, stripQuotedReply } from "../text.ts";
import { SkippedDomains } from "../audit.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_HEADER_CHECKS = 250;   // per person per run
const SLICE_DAYS = 7;            // emails are listed a week at a time, oldest week first

type Header = { name: string; value: string };
interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] }
interface Msg { id: string; threadId: string; internalDate: string; payload?: Part }

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bodyText(p: Part | undefined): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return b64urlDecode(p.body.data);
  for (const c of p.parts ?? []) { const t = bodyText(c); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return stripHtml(b64urlDecode(p.body.data));
  for (const c of p.parts ?? []) if (c.mimeType === "text/html" && c.body?.data) return stripHtml(b64urlDecode(c.body.data));
  return "";
}

export function gmailSource(env: Env, db: Db, isCustomerEmail: (emails: string[]) => boolean): Source {
  return {
    name: "email",
    async enabled() { return Boolean(env.GOOGLE_CLIENT_ID) && (await listConnections(db, "google")).length > 0; },
    async fetch() {
      const messages: ChatMessage[] = [];
      for (const conn of await listConnections(db, "google")) {
        let token: string;
        try { token = await accessToken(env, db, conn); } catch { continue; } // flagged on the Connect page
        // Gmail has a per-person, per-minute read budget. Pace requests and back off on 429/quota.
        const get = async <T>(path: string, attempt = 0): Promise<T> => {
          await new Promise((res) => setTimeout(res, 120));
          const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
          if ((r.status === 429 || r.status === 403) && attempt < 5) {
            const body = await r.text();
            if (r.status === 429 || /quota|rate/i.test(body)) {
              await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
              return get<T>(path, attempt + 1);
            }
            throw new Error(`gmail ${path.split("?")[0]} -> ${r.status} ${body.slice(0, 200)}`);
          }
          if (!r.ok) throw new Error(`gmail ${path.split("?")[0]} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
          return r.json() as Promise<T>;
        };

        const curKey = `cursor:gmail:${conn.email}`;
        const cur = await db.getState<{ after: number }>(curKey); // epoch ms of last processed email
        const afterMs = cur?.after ?? Date.now() - Number(env.BACKFILL_DAYS || 30) * 86400_000;
        // One week at a time, so a big backfill is never cut short by the listing cap.
        const sliceEnd = Math.min(afterMs + SLICE_DAYS * 86400_000, Date.now() - 60_000);

        // Newest-first listing; collect ids, then process oldest first so the cursor only moves forward.
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          const q = encodeURIComponent(`after:${Math.floor(afterMs / 1000)} before:${Math.floor(sliceEnd / 1000)} -in:chats -in:spam -in:trash`);
          const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?q=${q}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
          ids.push(...(r.messages ?? []).map((m) => m.id));
          pageToken = r.nextPageToken;
        } while (pageToken && ids.length < 5000);
        ids.reverse();

        const skippedDomains = new SkippedDomains(env.HOME_DOMAIN);
        let newest = afterMs;
        let checked = 0;
        for (const id of ids) {
          if (checked++ >= MAX_HEADER_CHECKS) break;
          const meta = await get<Msg>(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`);
          const ts = Number(meta.internalDate);
          if (ts <= afterMs) continue;
          newest = Math.max(newest, ts);
          const h = (n: string) => meta.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
          const from = parseAddresses(h("From"));
          const all = [...from, ...parseAddresses(h("To")), ...parseAddresses(h("Cc"))];
          if (!isCustomerEmail(all.map((a) => a.email))) {
            // Not a customer email: never opened. If our team wrote it, note who it went to.
            if (from[0]?.email.endsWith(`@${env.HOME_DOMAIN}`)) skippedDomains.add(all.map((a) => a.email));
            continue;
          }

          const full = await get<Msg>(`/messages/${id}?format=full`);
          const text = stripQuotedReply(bodyText(full.payload));
          const msgId = (h("Message-ID") ?? id).trim();
          const root = (h("References") ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? (h("In-Reply-To") ?? "").trim() ?? "";
          const subject = (h("Subject") ?? "(no subject)").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
          messages.push({
            source: "email",
            threadId: root || msgId,
            threadTitle: `Email: ${subject}`,
            threadUrl: null, // Gmail links only open in the recipient's own inbox
            messageId: msgId,
            sentAt: new Date(ts).toISOString(),
            author: { name: from[0]?.name, email: from[0]?.email },
            text: `${all.length ? `(to: ${all.slice(1).map((a) => a.email).join(", ")})\n` : ""}${text}`.slice(0, 20_000),
            // Everyone on From/To/Cc, so an email our team sends to a customer still matches that customer.
            accountDomains: [...new Set(all.map((a) => a.email.split("@")[1]).filter((d) => d && d !== env.HOME_DOMAIN))],
          });
        }
        await skippedDomains.save(db, `skipped_domains:email:${conn.email}`, "add");
        // Stopped at the cap: resume after the last email checked. Otherwise the whole slice is done.
        await db.setState(curKey, { after: checked > MAX_HEADER_CHECKS ? newest : Math.max(newest, sliceEnd) });
      }
      return { conversations: [], messages };
    },
  };
}
