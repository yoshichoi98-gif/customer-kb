// Google Chat, for everyone who signed in on /connect.
//
// Privacy rule: a space is read only if a real person from a customer is in it. A space named after
// a customer but with only our team in it (e.g. an internal "SampleCo prep" chat) is never read.
//
// Google Chat only gives apps a number for each person ("users/123"), never an email, so matching
// works like this:
//   1. (removed: matching spaces by name; see the privacy rule above)
//   2. Direct messages and group chats: each member's number is turned into an email with the
//      People API (read-only contacts permission). That works for coworkers and for anyone in
//      the signed-in person's contacts, including Gmail's automatic "Other contacts" (everyone
//      they've emailed). A chat is kept if a member's email is at a customer.
//   3. Backup: for every known customer contact (see contacts.ts), the engine asks Google "is
//      there a DM between this person and that email?" (spaces.findDirectMessage). This catches
//      DMs with contacts the People API won't reveal.
// Spaces that match none of these are never read.
//
// The DM lookup is rebuilt at most once a day per person and spread across runs (a capped
// number of lookups per run), so it never blows a run's time or request budget.

import type { Env } from "../env.ts";
import type { Db } from "../db.ts";
import type { ChatMessage, Source } from "./types.ts";
import { accessToken, listConnections } from "../connections.ts";
import type { Contacts } from "../contacts.ts";
import { SkippedDomains } from "../audit.ts";

const API = "https://chat.googleapis.com/v1";
const LOOKUPS_PER_RUN = 100;
const RESOLVES_PER_RUN = 150;     // People API lookups per person per run; the rest wait for the next run
const PEOPLE = "https://people.googleapis.com/v1";

interface Space { name: string; displayName?: string; spaceType?: string }
interface ChatMsg { name: string; createTime: string; text?: string; sender?: { name?: string; displayName?: string } }
interface DmMap {
  started: number;          // when this daily rebuild began
  done: boolean;
  checked: number;          // how many contacts have been looked up in this rebuild
  dms: Record<string, string>;  // DM space name -> contact email
  ids: Record<string, string>;  // Google user id ("users/123") -> contact email
  // Every Google user id we've looked up -> the customer's email, "@<our domain>" for a coworker,
  // or "" for anyone else / unknown. Only customer addresses are ever stored.
  who?: Record<string, string>;
}

export function googleChatSource(
  env: Env, db: Db, isCustomerEmail: (email: string) => boolean, getContacts: () => Promise<Contacts>,
): Source {
  return {
    name: "google_chat",
    async enabled() { return Boolean(env.GOOGLE_CLIENT_ID) && (await listConnections(db, "google")).length > 0; },
    async fetch(_since, _until, _known, save) {
      const messages: ChatMessage[] = [];
      const skipped: Record<string, number> = {};
      const contacts = await getContacts();
      const contactEmails = Object.keys(contacts).sort();

      for (const conn of await listConnections(db, "google")) {
        let token: string;
        try { token = await accessToken(env, db, conn); } catch { continue; }
        const call = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
          const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
          if (r.status === 404) return { status: 404, body: null };
          if (!r.ok) {
            // One refused lookup (e.g. a permission not granted yet, or an external user Google
            // won't resolve) shouldn't stop the whole pull; record it and treat as "no match".
            const why = `${path.split("?")[0].split("/").slice(0, 3).join("/")} -> ${r.status}`;
            skipped[why] = (skipped[why] ?? 0) + 1;
            return { status: r.status, body: null };
          }
          return { status: r.status, body: (await r.json()) as T };
        };

        // --- 2. DM map: which DMs are with known customer contacts (rebuilt daily, in slices)
        const mapKey = `gchat_map:${conn.email}`;
        let map = (await db.getState<DmMap>(mapKey)) ?? { started: 0, done: false, checked: 0, dms: {}, ids: {} };
        if (map.done && Date.now() - map.started > 24 * 3600_000) map = { started: Date.now(), done: false, checked: 0, dms: map.dms, ids: map.ids };
        if (!map.started) map.started = Date.now();
        if (!map.done) {
          const slice = contactEmails.slice(map.checked, map.checked + LOOKUPS_PER_RUN);
          for (const email of slice) {
            const dm = await call<{ name: string }>(`/spaces:findDirectMessage?name=${encodeURIComponent(`users/${email}`)}`);
            if (dm.body?.name) {
              map.dms[dm.body.name] = email;
              const mem = await call<{ member?: { name?: string } }>(`/${dm.body.name}/members/${encodeURIComponent(`users/${email}`)}`);
              if (mem.body?.member?.name) map.ids[mem.body.member.name] = email;
            }
          }
          map.checked += slice.length;
          if (map.checked >= contactEmails.length) map.done = true;
          await db.setState(mapKey, map);
        }

        // --- who is "users/123"? People API first, then the person's own contacts + Other contacts
        map.who ??= {};
        let resolves = 0;
        let contactIndex: Map<string, string> | null = null;
        const people = async <T>(path: string): Promise<T | null> => {
          const r = await fetch(`${PEOPLE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) { const why = `people ${path.split("?")[0].split("/").slice(0, 2).join("/")} -> ${r.status}`; skipped[why] = (skipped[why] ?? 0) + 1; return null; }
          return (await r.json()) as T;
        };
        type Person = { emailAddresses?: { value?: string }[]; metadata?: { sources?: { type?: string; id?: string }[] } };
        const buildContactIndex = async () => {
          const idx = new Map<string, string>();
          for (const path of ["/otherContacts?readMask=emailAddresses,metadata&sources=READ_SOURCE_TYPE_CONTACT&sources=READ_SOURCE_TYPE_PROFILE&pageSize=1000",
                              "/people/me/connections?personFields=emailAddresses,metadata&pageSize=1000"]) {
            let pt: string | undefined;
            do {
              const r = await people<{ otherContacts?: Person[]; connections?: Person[]; nextPageToken?: string }>(`${path}${pt ? `&pageToken=${pt}` : ""}`);
              for (const p of [...(r?.otherContacts ?? []), ...(r?.connections ?? [])]) {
                const email = p.emailAddresses?.[0]?.value?.toLowerCase();
                for (const src of p.metadata?.sources ?? []) if (src.type === "PROFILE" && src.id && email) idx.set(`users/${src.id}`, email);
              }
              pt = r?.nextPageToken;
            } while (pt);
          }
          return idx;
        };
        const whoIs = async (userId: string): Promise<string> => {
          if (userId in map.who!) return map.who![userId];
          if (resolves++ >= RESOLVES_PER_RUN) return "";
          const p = await people<Person>(`/people/${userId.split("/")[1]}?personFields=emailAddresses`);
          let email = p?.emailAddresses?.[0]?.value?.toLowerCase() ?? "";
          if (!email) { contactIndex ??= await buildContactIndex(); email = contactIndex.get(userId) ?? ""; }
          const customer = Boolean(email) && isCustomerEmail(email);
          map.who![userId] = customer ? email : email.endsWith(`@${env.HOME_DOMAIN}`) ? `@${env.HOME_DOMAIN}` : "";
          if (customer) map.ids[userId] = email;
          return email; // used for this run only, never stored unless it's a customer
        };
        const skippedDomains = new SkippedDomains(env.HOME_DOMAIN);
        const stats = { dms: 0, dmCustomer: 0, dmInternal: 0, dmOther: 0, dmUnknown: 0 };

        // --- list spaces and decide which are customer conversations
        const spaces: Space[] = [];
        let pageToken: string | undefined;
        do {
          const r = await call<{ spaces?: Space[]; nextPageToken?: string }>(`/spaces?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`);
          spaces.push(...(r.body?.spaces ?? []));
          pageToken = r.body?.nextPageToken;
        } while (pageToken);

        // One cursor per customer chat, so a chat matched for the first time gets the full backfill.
        const curKey = `cursor:gchat:${conn.email}`;
        const cur = (await db.getState<{ spaces?: Record<string, string> }>(curKey)) ?? {};
        const spaceAfter = cur.spaces ?? {};
        const backfillFrom = new Date(Date.now() - Number(env.BACKFILL_DAYS || 30) * 86400_000).toISOString();
        const runStarted = new Date().toISOString();

        for (const sp of spaces) {
          let title: string | null = null;
          let contactsInSpace: string[] = [];
          {
            // 2. look at who's in it (and 3. DMs already found by the backup search)
            const mem = await call<{ memberships?: { member?: { name?: string; type?: string } }[] }>(`/${sp.name}/members?pageSize=100`);
            const emails: string[] = [];
            for (const m of mem.body?.memberships ?? []) {
              const id = m.member?.name;
              if (!id || m.member?.type === "BOT") continue;
              const email = map.ids[id] ?? (await whoIs(id));
              if (email) emails.push(email);
              else if (sp.spaceType === "DIRECT_MESSAGE") stats.dmUnknown++;
            }
            contactsInSpace = [...new Set([...emails.filter(isCustomerEmail), ...(map.dms[sp.name] ? [map.dms[sp.name]] : [])])];
            if (sp.spaceType === "DIRECT_MESSAGE") {
              stats.dms++;
              if (contactsInSpace.length) stats.dmCustomer++;
              else if (emails.some((e) => e.endsWith(`@${env.HOME_DOMAIN}`)) && emails.every((e) => e.endsWith(`@${env.HOME_DOMAIN}`)) && emails.length > 1) stats.dmInternal++;
              else if (emails.length > 1) stats.dmOther++;
            }
            if (!contactsInSpace.length) skippedDomains.add(emails);
            if (contactsInSpace.length) title = sp.spaceType === "DIRECT_MESSAGE"
              ? `Google Chat DM with ${contactsInSpace.join(", ")}`
              : `Google Chat: ${sp.displayName || `group with ${contactsInSpace.join(", ")}`}`;
          }
          if (!title) continue; // not a customer conversation: never read
          const after = spaceAfter[sp.name] ?? backfillFrom;

          let pt: string | undefined;
          do {
            const filter = encodeURIComponent(`createTime > "${after}"`);
            const r = await call<{ messages?: ChatMsg[]; nextPageToken?: string }>(`/${sp.name}/messages?pageSize=1000&filter=${filter}${pt ? `&pageToken=${pt}` : ""}`);
            for (const m of r.body?.messages ?? []) {
              if (!m.text?.trim()) continue;
              const senderEmail = m.sender?.name ? map.ids[m.sender.name] : undefined;
              messages.push({
                source: "google_chat",
                threadId: sp.name,
                threadTitle: title,
                threadUrl: `https://chat.google.com/room/${sp.name.split("/")[1]}`,
                messageId: m.name,
                sentAt: m.createTime,
                author: { name: m.sender?.displayName || senderEmail, email: senderEmail },
                text: m.text,
                // Lets the engine attach the chat to the right customer by the contacts' domains.
                accountDomains: [...new Set(contactsInSpace.map((e) => e.split("@")[1]))],
              });
            }
            pt = r.body?.nextPageToken;
          } while (pt);
          spaceAfter[sp.name] = runStarted;
        }
        await save(messages.splice(0));
        await db.setState(curKey, { spaces: spaceAfter });
        await db.setState(mapKey, map);
        await db.setState(`gchat_dm_stats:${conn.email}`, { at: runStarted, ...stats });
        await skippedDomains.save(db, `skipped_domains:google_chat:${conn.email}`, "replace");
      }
      if (Object.keys(skipped).length) await db.setState("gchat_last_skips", { at: new Date().toISOString(), skipped });
      return { conversations: [], messages };
    },
  };
}
