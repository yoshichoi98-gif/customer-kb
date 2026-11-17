---
name: customer-kb
description: Answer questions about Alleviate Health's customers from the Customer Knowledge Bank in Supabase (every customer call transcript, customer email, Teams and Google Chat chat, Pylon support chat, and every message in our public Slack channels). Use whenever someone asks what customers are saying or doing, or what our team has said in Slack - product feedback or questions, bugs, customer frustration, anger or churn risk, feature requests or product ideas, promises we made, how an account or deployment is going, what happened with a customer recently, or comparisons across customers - even if Supabase or the knowledge bank isn't named.
---

# Customer Knowledge Bank

Everything customers have said to Alleviate by call, email and chat (and what our team said about them internally) is stored in the Supabase project **customer-knowledge-bank** (project ref `YOUR_PROJECT_REF`). Query it with the Supabase connector's SQL tool. **Read only: run SELECT statements only, never insert, update, delete or alter anything.**

## The data

Query the view **`customer_feed`**: one row per chat message or call, already labelled with the customer.

| column | meaning |
|---|---|
| `customer` | Customer name (e.g. "Northwind Research", "Summit Research") |
| `customer_status` | Customer, Pilot, or No longer active |
| `kind` | `message` or `call` |
| `source` | `bluedot` (recorded call), `email`, `teams`, `google_chat`, `pylon` (in-app support chat), `slack` (internal) |
| `chat` | Chat, email or call title (e.g. "Teams: Summit + Alleviate Health [Admin]", "Email: Product update", "Support chat #123: ...") |
| `link` | Link back to the original (empty for emails) |
| `at` | When (UTC). Show dates to people in Pacific time. |
| `who`, `who_email` | Author of a message (empty for calls) |
| `side` | `Customer` (someone at the customer's own domains), `Alleviate`, `Alleviate (internal)` (Slack), `Other` (anyone else outside Alleviate: vendors, partners, a parent company; check `who_email`), `Unknown`, or `Call (both sides)` |
| `is_dm` | true for 1:1 chats |
| `text` | The message (emails start with a To and Cc line), or for calls the full transcript with lines like `[12:34] Name: words` |

Other tables, only if needed: `customers` (name, status, domains), `insights` (Claude-tagged items: type = Product feedback, Request, Bug, Risk, Decision, Promise, Praise; usually empty because automatic reading is off; use it when it has rows for the period asked about).

**What each source is:**
- **Calls (bluedot):** full meeting transcripts. The richest source for feedback and frustration, but long (often 5,000+ words). Speaker names are in the transcript lines.
- **Email:** customer email threads from every teammate inbox synced to Pylon (emails only between teammates are left out; calendar invites are skipped). One row per email; the `chat` title is the subject, and the To/Cc line shows who was on it.
- **Teams / Google Chat:** chats that include at least one customer person. `side` tells you who wrote each message.
- **Pylon:** customer support chats from inside the product. Good for bugs and "how do I" questions.
- **Slack `#<customer>-deploy`:** our team talking to each other about the customer. This is internal interpretation, **not the customer's voice**. Use it for context and what we're doing about things, and label it as internal.
- **Slack channels shared with a customer** (`chat` ends "(shared with the customer)", e.g. the Harbor Clinical Slack Connect channels): the customer is in the channel. Their people show as `who` = "Name (Customer name)" and are the customer's voice; everyone else is our team.
- **Slack team channels** (every other public channel, e.g. #team-a, #team-b): a message that names a customer (or replies in a thread whose first message does) shows up in `customer_feed` under that customer, with `chat` like "Slack #team-a (team channel)". Also internal, not the customer's voice. Social and hiring channels are never stored.

**Team Slack, all of it** (questions about what the team said, not tied to one customer): query the `messages` table directly. Team-channel messages have `thread_id` starting `slack:team:`; `thread_title` is the channel, `account_domains` lists the domains of any customers the message names.

```sql
-- what the team said in Slack about a topic, last 30 days (read the whole channel-day around each hit before concluding)
select thread_title as channel, sent_at, author_name, text, thread_url
from messages
where thread_id like 'slack:team:%' and sent_at > now() - interval '30 days'
order by thread_title, sent_at;
```

**Not covered:** email from inboxes not synced to Pylon, private Slack channels (except the customer-shared ones listed by hand) and Slack DMs, social and hiring Slack channels, attachments, anything before the data starts, and messages less than about an hour old. Check coverage when it matters: `select source, min(at), max(at), count(*) from customer_feed group by source;`

## How to answer

**Read everything. Don't answer from keyword hits.** People rarely use the obvious words: frustration sounds like "we've asked three times", ideas sound like "it'd make our lives easier if". Most signal is on calls, in tone and pushback. A keyword search misses these, so it is never the basis of an answer unless the person asked for a quick scan.

1. **Find the customer names** if the question names a company: `select name, status from customers order by name;` and match loosely (e.g. "Lakeside" = "Lakeside Research", "Elara" = "Norvex aka Elara").
2. **Pick the period.** Default to the last 30 days unless asked otherwise.
3. **Question about one customer: read all of it.** Every message and every full call transcript for that customer in the period, in time order. One customer's month is small enough (usually small enough to read in full). Pull chats first, then each call transcript one at a time.
4. **Question across customers** ("who's frustrated", "what are people asking for"): list the customers with activity in the period, then **read each customer fully, one at a time**, noting what's relevant to the question before moving to the next. Combine at the end. Tell the person up front that a full pass takes a while. If they only want a quick look, a keyword scan is allowed, but say clearly that it's partial and may miss things.
5. **Insights table first, if it's filled.** If `insights` has rows covering the period (`select min(occurred_at), max(occurred_at), count(*) from insights;`), those were tagged by Claude reading each conversation in full. Use them for cross-customer questions, then open the source conversations to confirm and quote. If it's empty or doesn't cover the period, read the raw data as above.
6. **Judge things in context.** Never conclude from a single message or transcript line. Read what came before and after, and check later messages to see whether an issue was resolved.
7. Count precisely when giving numbers, and say what the count covers.

Useful queries (adapt them):

```sql
-- who has activity in the period, and how much
select customer, count(*) filter (where kind = 'message') as messages, count(*) filter (where kind = 'call') as calls
from customer_feed where at > now() - interval '30 days'
group by customer order by calls desc, messages desc;

-- all chat messages for one customer, in order
select at, source, chat, who, side, is_dm, text, link
from customer_feed
where customer = 'Northwind Research' and kind = 'message' and at > now() - interval '30 days'
order by chat, at;

-- the calls for one customer (list), then each full transcript by id
select id, at, chat as title, link, length(text) as chars
from customer_feed where customer = 'Northwind Research' and kind = 'call' and at > now() - interval '30 days'
order by at;
select text from customer_feed where id = '<call id>';

-- quick scan only (partial; say so in the answer)
select customer, source, chat, at, who, side, text, link
from customer_feed
where at > now() - interval '30 days' and text ~* '(frustrat|annoy|disappoint)'
order by at desc limit 100;
```

## What to look for

Read with these in mind. The example phrases are what people tend to say, not a search list.

**Product feedback / product questions** ("what are customers saying about X", "what questions do they have")
- How-to questions, confusion, workarounds, praise, things that work or don't. Best in Pylon chats, Teams/Google Chat and calls.
- Group by feature or theme. Separate confusion (a training or UX gap) from real defects.

**Customer frustration / anger / churn risk** ("who's unhappy", "is X frustrated")
- Direct complaints, but also: asking about the same issue repeatedly, "still" and "again", slow or missing replies from our side, campaigns paused, leadership or a new person getting involved, "full transparency" or "we need to talk" messages, comparing us to another vendor, questioning what they're paying for, short or cold replies after warm ones.
- Only the **customer's** words count as evidence. Our Slack talk about their mood is supporting context, labelled internal.
- Rate each account high / medium / low with the reason, and say what's unresolved.

**Product ideas / feature requests** ("what do customers want us to build")
- "Would be great if", "is it possible", "in V1 we could", "we used to", workarounds they built themselves, things they do manually that we could automate.
- Group the same request across customers and count how many customers asked. Note who and when, and whether our team committed to anything.

**Bugs / things broken**
- Errors, things that didn't sync, send, show up or get created, and expired connections. Check later messages to see whether each was fixed.

**Product ideas across customers, prospects and the team** ("what product ideas came up this month?")
- Customer conversations are in `customer_feed`. Internal team meetings, prospect or vendor calls, and days of Slack team channels are NOT in `customer_feed`; their product ideas are in the `insights` table with `customer_id` empty, tagged Product idea, Request, Product feedback or Decision. For a Slack day, `quote_time` is the message time and the conversation title is the channel and date.
- Start from insights, then open the source call to confirm and quote:

```sql
-- product ideas, requests and feedback from everywhere, with where each came from
select i.type, i.text, i.who, i.quote, i.quote_time, i.status, i.occurred_at,
       coalesce(cu.name, case when exists (select 1 from jsonb_array_elements(v.participants) p
                                           where p->>'email' is not null and p->>'email' not ilike '%@example.com')
                              then 'Prospect/vendor' else 'Internal' end) as source_label,
       v.title, v.url, v.id as conversation_id
from insights i
join conversations v on v.id = i.conversation_id
left join customers cu on cu.attio_record_id = i.customer_id
where i.type in ('Product idea', 'Request', 'Product feedback', 'Decision')
  and i.occurred_at > now() - interval '30 days'
order by i.occurred_at desc;

-- the full transcript of one internal or prospect call
select title, occurred_at, url, raw_text from conversations where id = '<conversation_id>';
```
- Label each idea by where it came from (customer name, Prospect/vendor, or Internal), group the same idea across sources, and say how many customers, prospects and internal meetings raised it.
- Hiring interviews and private recordings are never stored, so they never appear.

**Promises we made** ("what did we commit to X")
- Our side saying "we will", "I'll", "by Friday", "should be live", "we'll follow up", in chats and on calls.
- List each with owner, date promised, due date if stated, and any evidence it was delivered.

**Account overview** ("what's going on with X")
- Read everything for the customer in the last 14 to 30 days. Summarize: current state, open issues, what they're asking for, mood, what we owe them, and what's coming up. Then cite.

## Answer rules

- Lead with the answer in plain language, then the evidence.
- Every claim gets: **who** (name and company), **when** (date, Pacific time), **where** (source and chat or call title, with the `link`), and a short quote when one helps. For calls, include the `[mm:ss]` timestamp.
- Keep customer voice and our internal Slack interpretation clearly separate.
- If sources disagree (e.g. a call says one thing and a later chat another), show both side by side with their sources. Don't pick one silently.
- Say what you didn't check or couldn't see (e.g. attachments aren't stored, an inbox not synced to Pylon).
- Don't use em-dashes.

## Privacy

- Never show patient or study-participant details (names, contact details, conditions); describe patient matters only in aggregate.
- Leave out personal matters about anyone: health, HR (performance, pay, leave), family, gossip.
- 1:1 chats with customers (`is_dm = true`) can be quoted and shown in full like any other chat.
