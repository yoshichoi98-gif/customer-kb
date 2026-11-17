// Customer contact directory: every known email address of a person at a customer, mapped to
// that customer. Used to find Google Chat DMs with customers, since Google doesn't tell apps who
// is in a chat by email.
//
// Built from (1) everyone the archive has seen on customer calls, emails and chats, and (2) the
// people at each customer company in Attio. Rebuilt at most once a day.

import type { Env } from "./env.ts";
import type { CustomerRow, Db } from "./db.ts";

export type Contacts = Record<string, string>; // email -> customer attio_record_id

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com", "live.com", "me.com"]);

async function attioPeopleEmails(env: Env, domains: string[]): Promise<string[]> {
  if (!env.ATTIO_API_KEY || !domains.length) return [];
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch("https://api.attio.com/v2/objects/people/records/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ATTIO_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { $or: domains.map((d) => ({ email_addresses: { email_domain: { $eq: d } } })) }, limit: 500, offset }),
    });
    if (!res.ok) { console.warn(`attio people query -> ${res.status} ${(await res.text()).slice(0, 200)}`); return out; }
    const { data } = (await res.json()) as { data: { values: { email_addresses?: { email_address?: string }[] } }[] };
    for (const p of data) for (const e of p.values.email_addresses ?? []) if (e.email_address) out.push(e.email_address.toLowerCase());
    if (data.length < 500) break;
    offset += 500;
  }
  return out;
}

export async function loadContacts(env: Env, db: Db, customers: CustomerRow[]): Promise<Contacts> {
  const cached = await db.getState<{ at: number; contacts: Contacts }>("contacts");
  if (cached && Date.now() - cached.at < 24 * 3600_000) return cached.contacts;

  const byDomain = new Map<string, string>();
  for (const c of customers) for (const d of c.domains) byDomain.set(d.toLowerCase(), c.attio_record_id);
  const contacts: Contacts = {};
  const add = (email: string | undefined) => {
    const e = (email ?? "").toLowerCase().trim();
    const d = e.split("@")[1];
    if (!d || FREE_MAIL.has(d) || d === env.HOME_DOMAIN) return;
    const id = byDomain.get(d);
    if (id) contacts[e] = id;
  };

  const convs = await db.select<{ participants: { email?: string }[] }>("conversations", "customer_id=not.is.null&select=participants&limit=10000");
  for (const c of convs) for (const p of c.participants ?? []) add(p.email);
  const msgs = await db.select<{ author_email: string | null }>("messages", "author_email=not.is.null&select=author_email&limit=20000");
  for (const m of msgs) add(m.author_email ?? undefined);
  for (const e of await attioPeopleEmails(env, [...byDomain.keys()])) add(e);

  await db.setState("contacts", { at: Date.now(), contacts });
  return contacts;
}
