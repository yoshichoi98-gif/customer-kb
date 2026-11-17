-- 003: customer_feed, one row per chat message or call, labelled with the customer.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Made for asking questions through the Supabase connector (the customer-kb skill): instead of
-- joining messages to customers by domain every time, query this view.
--
-- security_invoker: the view obeys the tables' row-level security, so it is no more open than
-- the tables themselves (a plain view would let the public API key read everything).

create or replace view customer_feed with (security_invoker = true) as
select
  c.name                                   as customer,
  c.status                                 as customer_status,
  'message'                                as kind,
  m.source,                                -- email | pylon | teams | google_chat | slack
  m.thread_title                           as chat,
  m.thread_url                             as link,
  m.sent_at                                as at,
  m.author_name                            as who,
  m.author_email                           as who_email,
  case
    -- Slack is our team, except customer people writing in a channel shared with them (e.g. a Slack Connect channel shared with the customer).
    when m.source = 'slack' and (m.author_email is null or m.author_email ilike '%@example.com') then 'Alleviate (internal)'
    when m.author_email ilike '%@example.com' then 'Alleviate'
    -- Google Chat often gives no email; recognise the person by name from their other messages.
    when m.author_email is null and m.author_name in
      (select author_name from messages where author_email ilike '%@example.com') then 'Alleviate'
    when m.author_email is null and m.author_name in
      (select author_name from messages where author_email is not null and author_email not ilike '%@example.com') then 'Customer'
    when m.author_email is null then 'Unknown'
    -- Only the customer's own domains count as the customer; vendors, partners etc. are 'Other'.
    when lower(split_part(m.author_email, '@', 2)) = any(c.domains) then 'Customer'
    else 'Other'
  end                                      as side,
  (m.thread_title like 'Teams 1:1%' or m.thread_title like 'Google Chat DM%') as is_dm,
  m.text,
  m.id
from messages m
join customers c on m.account_domains && c.domains
union all
select
  c.name, c.status, 'call', v.source, v.title, v.url, v.occurred_at,
  null, null, 'Call (both sides)', false,
  v.raw_text,                              -- full transcript, lines like "[mm:ss] Name: text"
  v.id
from conversations v
join customers c on c.attio_record_id = v.customer_id
where v.kind = 'call';

-- Never readable with the public (anon) or logged-in-user keys; only the connector / service key.
revoke all on customer_feed from anon, authenticated;
