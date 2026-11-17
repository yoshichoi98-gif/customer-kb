// Which customer is a conversation with?
//
// Rules carried over from the manual digest runs:
//   1. Any participant whose email domain belongs to a customer -> that customer.
//   2. Free-mail and vendor/partner domains never decide a match (a partner like ExamplePartner on
//      an Norvex call belongs to Norvex because Norvex people are also on it).
//   3. If no domain matches, look for a customer's name in the title (calls where only
//      Alleviate people dialed in, e.g. "Q7/Alleviate: Pilot Sync"). Nicknames that the Attio
//      name won't produce ("Q7") come from NAME_ALIASES.
//   4. Otherwise it's internal and skipped.

import type { Env } from "./env.ts";
import type { CustomerRow } from "./db.ts";

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com", "live.com", "me.com"]);
// Customer names that are also everyday words (see Matcher.mentions).
const NEEDS_FULL_NAME = new Set(["meridian", "harbor"]);
const CASE_SENSITIVE = new Set(["bloom", "summit", "unity", "anchor"]);
const nameRe = (n: string, flags: string) => new RegExp(`(^|[^a-zA-Z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9]|$)`, flags);

export class Matcher {
  private byDomain = new Map<string, string>();
  private byName: { re: RegExp; id: string }[] = [];

  constructor(env: Env, customers: CustomerRow[]) {
    for (const c of customers) for (const d of c.domains) this.byDomain.set(d.toLowerCase(), c.attio_record_id);
    for (const pair of (env.DOMAIN_ALIASES ?? "").split(",")) {
      const [d, id] = pair.split("=").map((s) => s?.trim());
      if (d && id) this.byDomain.set(d.toLowerCase(), id);
    }
    for (const c of customers) {
      // Match on the distinctive part of the name: "Norvex aka Elara" -> Norvex, Elara;
      // "Northwind Research" -> Northwind. Generic words are dropped so "Research" alone
      // never matches.
      const names = c.name.split(/\s+aka\s+|\//i).map((n) =>
        n.replace(/\b(clinical|research|trials?|health|network|group|inc|llc)\b/gi, "").trim()).filter((n) => n.length >= 3);
      for (const n of names) this.addName(n, c.attio_record_id);
      this.addFullName(c.name, c.attio_record_id);
    }
    const idByName = new Map(customers.map((c) => [c.name.toLowerCase(), c.attio_record_id]));
    for (const pair of (env.NAME_ALIASES ?? "").split(",")) {
      const [nick, name] = pair.split("=").map((s) => s?.trim());
      const id = name ? idByName.get(name.toLowerCase()) : undefined;
      if (nick && id) this.addName(nick, id);
    }
  }

  private addName(n: string, id: string) {
    this.byName.push({ re: nameRe(n, "i"), id });
    // Free-text mentions (Slack team channels) are stricter than titles: a name that is also an
    // everyday word only counts when written the company's way ("Summit", not "summit"), and
    // "Meridian" / "Harbor" never count alone ("the meridian line", "a harbor tour").
    const word = n.toLowerCase();
    if (NEEDS_FULL_NAME.has(word)) return;
    this.byMention.push({ re: nameRe(n, CASE_SENSITIVE.has(word) ? "" : "i"), id });
  }

  private byMention: { re: RegExp; id: string }[] = [];

  /** Every customer named in a piece of free text (a Slack message), by name or nickname. */
  mentions(text: string): string[] {
    const found = new Set<string>();
    for (const { re, id } of this.byMention) if (re.test(text)) found.add(id);
    for (const { re, id } of this.byFullName) if (re.test(text)) found.add(id);
    return [...found];
  }

  private byFullName: { re: RegExp; id: string }[] = [];
  /** The full customer name ("Meridian Clinical Trials") and its first two words ("Meridian Clinical") always count as a mention. */
  addFullName(name: string, id: string) {
    const words = name.split(/\s+aka\s+/i)[0].trim().split(/\s+/);
    for (const n of new Set([words.join(" "), words.slice(0, 2).join(" ")])) if (n.length >= 5 && n.includes(" ")) this.byFullName.push({ re: nameRe(n, "i"), id });
  }

  match(participantEmails: string[], title: string | null): string | null {
    const counts = new Map<string, number>();
    for (const e of participantEmails) {
      const d = e.split("@")[1]?.toLowerCase();
      if (!d || FREE_MAIL.has(d)) continue;
      const id = this.byDomain.get(d);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (counts.size) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (title) for (const { re, id } of this.byName) if (re.test(title)) return id;
    return null;
  }
}
