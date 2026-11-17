-- 002: store chat / email messages one by one, so a long-running chat is never re-read in full.
-- Run once in the Supabase SQL editor after schema.sql. Safe to re-run.
--
-- Each message is stored once (deduped by its id). New messages are grouped into one
-- "chat update" per chat per Pacific day, which becomes a row in `conversations`
-- (kind = 'chat_update'); Claude reads only that day's new messages, plus a few earlier ones
-- as background.

create table if not exists messages (
  id            text primary key,              -- '<source>:<message id>'
  source        text not null,                 -- pylon | email | teams | google_chat
  thread_id     text not null,                 -- '<source>:<chat/thread id>'
  thread_title  text,
  thread_url    text,
  sent_at       timestamptz not null,
  author_name   text,
  author_email  text,
  text          text not null default '',
  account_domains text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists messages_thread_time on messages (thread_id, sent_at);
alter table messages enable row level security;

alter table conversations add column if not exists kind text not null default 'call';  -- call | chat_update
alter table conversations add column if not exists thread_id text;
