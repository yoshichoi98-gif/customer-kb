// Coverage check: which outside companies do we talk to that are NOT on the customer list?
//
// When a source skips a conversation because no customer is on it, it records the outside email
// domains involved (domains and counts only, never names or content). If a customer shows up
// here, Attio is missing one of its domains, and adding it (or a DOMAIN_ALIASES entry) fixes it.
// Read locally from Supabase source_state "skipped_domains:<source>:<person>".

import type { Db } from "./db.ts";

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com", "live.com", "me.com"]);

export class SkippedDomains {
  private counts: Record<string, number> = {};
  constructor(private homeDomain: string) {}

  add(emails: string[]) {
    for (const d of new Set(emails.map((e) => e.toLowerCase().split("@")[1]).filter(Boolean))) {
      if (d === this.homeDomain || FREE_MAIL.has(d) || d.endsWith(".onmicrosoft.com")) continue;
      this.counts[d] = (this.counts[d] ?? 0) + 1;
    }
  }

  /** Gmail adds up (each email is seen once). Chats are re-checked every run, so they replace. */
  async save(db: Db, key: string, mode: "add" | "replace") {
    const fresh = { since: new Date().toISOString(), counts: {} as Record<string, number> };
    const prev = mode === "add" ? ((await db.getState<typeof fresh>(key)) ?? fresh) : fresh;
    for (const [d, n] of Object.entries(this.counts)) prev.counts[d] = (prev.counts[d] ?? 0) + n;
    await db.setState(key, prev);
  }
}
