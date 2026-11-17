// All conversation sources. Gmail, Google Chat and Teams read only the accounts of people who
// signed in on /connect; with nobody connected they report "not connected" and return nothing.

import type { Env } from "../env.ts";
import type { Db } from "../db.ts";
import type { Source } from "./types.ts";
import type { Matcher } from "../match.ts";
import type { CustomerRow } from "../db.ts";
import { loadContacts } from "../contacts.ts";
import { bluedotSource } from "./bluedot.ts";
import { pylonSource } from "./pylon.ts";
import { googleChatSource } from "./gchat.ts";
import { teamsSource } from "./teams.ts";
import { slackSource } from "./slack.ts";
import { pylonEmailSource } from "./pylon-email.ts";

export function allSources(env: Env, db: Db, matcher: Matcher, customers: CustomerRow[]): Source[] {
  return [
    bluedotSource(db),
    pylonSource(env),
    // Customer email comes from Pylon (inboxes synced to Pylon, customer threads only). Reading
    // Gmail directly stays off for privacy (Oct 9); gmail.ts is kept for reference but never runs.
    pylonEmailSource(env, db, customers),
    googleChatSource(env, db, (email) => matcher.match([email], null) !== null, () => loadContacts(env, db, customers)),
    teamsSource(env, db, (emails) => matcher.match(emails, null) !== null),
    slackSource(env, db,
      (name) => {
        const c = customers.find((x) => x.attio_record_id === matcher.match([], name));
        return c ? { name: c.name, domains: c.domains } : null;
      },
      (text) => matcher.mentions(text).flatMap((id) => customers.find((c) => c.attio_record_id === id)?.domains ?? []),
    ),
  ];
}
