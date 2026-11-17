-- Customer Account Knowledge Bank: raw archive + engine ledger.
--
-- Run once in the Supabase SQL editor (Project -> SQL Editor -> New query -> paste -> Run).
-- Safe to re-run: everything is IF NOT EXISTS.
--
-- Why it lives here and not in Notion: Notion holds only what's worth reading (Briefs,
-- Insights, Weekly Reports). This database holds EVERYTHING, in full, so that a new prompt or
-- question added later can be re-run over the whole history, and so anyone can ask Claude
-- questions against the actual transcripts through the Supabase connector.

create extension if not exists vector;

-- One row per active customer account. Mirrors Attio (Customer/Pilot) and the Notion
-- Customers table; attio_record_id is the shared key across all three.
create table if not exists customers (
  attio_record_id   text primary key,
  name              text not null,
  status            text not null,             -- Customer | Pilot | No longer active
  domains           text[] not null default '{}',
  notion_page_id    text,
  pylon_account_id  text,
  updated_at        timestamptz not null default now()
);

-- One row per conversation from any source. id = '<source>:<source_id>' so a re-run is a
-- no-op rather than a duplicate. raw_text is the full readable text (speaker-labelled
-- transcript, email thread, chat log); raw_json keeps the original payload for re-parsing.
create table if not exists conversations (
  id               text primary key,
  source           text not null,               -- bluedot | email | teams | google_chat | pylon
  source_id        text not null,
  customer_id      text references customers(attio_record_id),
  title            text,
  occurred_at      timestamptz not null,
  participants     jsonb not null default '[]',
  url              text,
  raw_text         text not null default '',
  raw_json         jsonb,
  summary          text,
  -- Claude's full read of the conversation: people, tasks done / to do on each side, insights.
  extraction       jsonb,
  -- new -> extracted | skipped | error. Only 'new' and 'error' rows get (re)processed.
  state            text not null default 'new',
  skip_reason      text,
  error            text,
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  extracted_at     timestamptz,
  search           tsvector generated always as
                     (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(raw_text,''))) stored
);
create index if not exists conversations_customer_time on conversations (customer_id, occurred_at desc);
create index if not exists conversations_state on conversations (state);
create index if not exists conversations_search on conversations using gin (search);

-- One row per insight pulled out of a conversation. Mirrored to the Notion Insights table.
create table if not exists insights (
  id               bigserial primary key,
  conversation_id  text not null references conversations(id) on delete cascade,
  customer_id      text references customers(attio_record_id),
  type             text not null,               -- Product feedback | Request | Bug | Risk | Decision | Promise | Praise
  text             text not null,
  who              text,
  owner_side       text,                        -- Alleviate | Customer
  quote            text,
  quote_time       text,                        -- mm:ss into the call, when from a call
  status           text not null default 'Open',
  occurred_at      timestamptz not null,
  notion_page_id   text,
  created_at       timestamptz not null default now()
);
create index if not exists insights_customer_time on insights (customer_id, occurred_at desc);
create index if not exists insights_type on insights (type);

-- One row per customer per week; mirrored to Notion Weekly Reports and posted to Slack.
create table if not exists weekly_reports (
  customer_id      text not null references customers(attio_record_id),
  week_of          date not null,
  report           jsonb not null,
  notion_page_id   text,
  created_at       timestamptz not null default now(),
  primary key (customer_id, week_of)
);

-- Weekly run state machine, so a run that outlasts one Worker invocation resumes cleanly.
create table if not exists runs (
  week_of          date primary key,
  state            text not null default 'pending',  -- pending -> reports -> posted
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  detail           jsonb not null default '{}'
);

-- Source cursors and sign-ins (e.g. the BlueDot refresh token). Only the engine reads this;
-- row-level security below blocks every role except the service key.
create table if not exists source_state (
  source           text primary key,
  data             jsonb not null default '{}',
  updated_at       timestamptz not null default now()
);

alter table customers      enable row level security;
alter table conversations  enable row level security;
alter table insights       enable row level security;
alter table weekly_reports enable row level security;
alter table runs           enable row level security;
alter table source_state   enable row level security;
