# Customer Knowledge Bank

One place for everything our customers have said to us. It collects every customer call, email, support chat and team chat, archives it word for word, has Claude pull out the insights with exact quotes, and every Tuesday writes a report and an up-to-date brief for each customer.

## Why I built it

Customer context was scattered across six tools: call recordings, support tickets, email, Slack, Microsoft Teams and Google Chat. Before a renewal or a check-in, someone had to dig through all of them to answer "how is this account doing?" Feature requests and promises made on calls got lost. I wanted one archive that anyone, or any AI assistant, could ask.

## What it does

- **Collects** every conversation from BlueDot (call recordings), Pylon (support chats and email), Gmail, Microsoft Teams, Google Chat and Slack, and stores each in full in Supabase.
- **Matches** each conversation to the right customer using email domains, CRM names, nicknames and who was in the room.
- **Reads** each conversation with Claude and pulls out tagged insights (product feedback, requests, bugs, risks, decisions, promises, praise), each with a verbatim quote and who said it.
- **Writes** to Notion: a living Account Brief per customer, a weekly report, and an insights table you can filter.
- **Posts** a weekly digest to Slack every Tuesday evening.
- **Answers questions:** a Claude skill (`skill/customer-kb/SKILL.md`) lets anyone ask in plain English ("what has this customer complained about this month?") and answers from the archive with SQL.

## How it works

```
Every 15 minutes (Cloudflare Worker):
  1. Refresh the customer list from the CRM (Attio)              every 6 hours
  2. Pull new conversations from each source into Supabase      hourly
  3. Claude reads anything not yet read -> insights + Notion
  4. From Tuesday 6pm PT: weekly report + account brief per customer, then Slack
```

## Engineering decisions

- **Small slices, safe restarts.** Each 15-minute run does a bounded amount of work and stops before Cloudflare's time limit. Everything is idempotent, so a crashed run is simply finished by the next one.
- **One shape for six sources.** Each source is its own module, but all of them return the same `Conversation` type, so adding a seventh is a single file.
- **Accuracy rules the model can't override.** Quotes must be copied word for word or left out, dates are never taken from AI-written summaries, and personal or medical details about anyone are never recorded.
- **Editable by non-engineers.** The prompts Claude follows live on a Notion page, so the customer team can change what gets extracted without a code change.
- **Right model for each job.** A faster model reads conversations and writes weekly reports; a stronger model writes the account briefs.
- **Careful name matching.** Customer names that are also everyday words only count when written the way the company writes them, so ordinary conversation isn't misfiled.

## Stack

TypeScript, Cloudflare Workers (cron), Supabase (Postgres), Anthropic Claude API (structured outputs), Notion API, Slack API, plus integrations with BlueDot, Pylon, Gmail, Microsoft Graph, Google Chat and Attio. About 3,000 lines.

## Layout

| File | What it does |
|---|---|
| `src/pipeline.ts` | The 15-minute tick: ingest, read, weekly reports, Slack |
| `src/sources/*.ts` | One file per source, all returning the same shape |
| `src/claude.ts` | The Claude passes (read a conversation, write a brief, write a weekly report) |
| `src/match.ts` | Which customer a conversation belongs to |
| `src/customers.ts` | CRM to Supabase and Notion customer sync |
| `src/prompts.ts` | Loads the editable prompts from Notion |
| `supabase/*.sql` | Archive tables and the `customer_feed` view |
| `skill/customer-kb/SKILL.md` | Claude skill for asking questions of the archive |

## Running it

Create a Supabase project and run `supabase/schema.sql`. Copy `.dev.vars.example` to `.dev.vars` and fill in the keys, then `npm install && npm run deploy`. In production, secrets are set with `npx wrangler secret put <NAME>`.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
