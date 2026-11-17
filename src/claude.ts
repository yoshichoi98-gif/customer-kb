// The three Claude passes:
//   1. readConversation  - one full conversation -> summary, people, tasks, insights (with quotes)
//   2. writeBrief        - a customer's history -> the living Account Brief + standing answers
//   3. writeWeeklyReport - a customer's week -> the 5-bucket report
//
// The editable instructions come from the Notion Prompts page; the fixed parts here are only the
// output shape and the hard rules that protect accuracy (quote verbatim, never trust AI
// summaries for dates).
//
// Models (wrangler.jsonc): claude-sonnet-5-5 reads conversations and writes weekly reports;
// claude-opus-5-5 (BRIEF_MODEL) writes Account Briefs. Notes: adaptive thinking is on by default and
// counts against max_tokens; temperature and prefill are rejected; structured output goes through
// output_config.format; forced tool use is rejected (not used here).

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.ts";
import type { Prompts } from "./prompts.ts";

const INSIGHT_TYPES = ["Product feedback", "Request", "Bug", "Risk", "Decision", "Promise", "Praise"] as const;
const SENTIMENTS = ["Advocate", "Positive", "Neutral", "Frustrated", "At Risk", "Unhappy"] as const;

const HARD_RULES = `Hard rules (these override anything above):
- Quotes must be copied word for word from the conversation text. Never paraphrase inside quotation marks. If you can't find a supporting quote, leave the point out.
- For calls, the timestamp is the [mm:ss] stamp on the line the quote comes from.
- Never take a calendar date from an AI-written summary. Use the conversation's own date or relative wording ("next week").
- Alleviate Health staff use @example.com addresses; everyone else is the customer or a partner of theirs.
- Privacy: never record personal or sensitive details about anyone, in any field (summary, people, tasks, insights, quotes, briefs, reports): health or medical matters of staff or contacts; HR matters (performance, hiring or firing, pay, benefits, leave); family or personal life; politics or religion; gossip or personal opinions about colleagues. Never record anything that identifies a patient or study participant (names, contact details, or a condition tied to a person); describe patient matters only in aggregate ("3 records were missing a required field"). If a business point can't be made without these details, leave it out.
- Don't use em-dashes.`;

async function structured<T>(env: Env, opts: { system: string; user: string; schema: Record<string, unknown>; effort: "low" | "medium" | "high"; maxTokens: number; model?: string }): Promise<T> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // Streamed so long briefs (large max_tokens) don't hit the SDK's non-streaming timeout guard.
  const response = await client.messages.stream({
    model: opts.model ?? env.ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    output_config: { effort: opts.effort, format: { type: "json_schema", schema: opts.schema } },
  }).finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request (refusal)");
  if (response.stop_reason === "max_tokens") throw new Error("Claude output truncated at max_tokens");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude returned unparseable JSON (stop_reason=${response.stop_reason}): ${text.slice(0, 200)}`);
  }
}

const str = { type: "string" };
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

// ---------- 1. one conversation ----------

export interface ConversationRead {
  summary: string;
  people: { name: string; company: string; side: "Alleviate" | "Customer" | "Other" }[];
  tasks: { side: "Alleviate" | "Customer"; state: "done" | "to do"; who: string; text: string }[];
  insights: { type: (typeof INSIGHT_TYPES)[number]; text: string; who: string; owner_side: "Alleviate" | "Customer" | "None"; quote: string; quote_time: string; status: "Open" | "Done" | "No action" }[];
}

const READ_SCHEMA = obj({
  summary: str,
  people: { type: "array", items: obj({ name: str, company: str, side: { type: "string", enum: ["Alleviate", "Customer", "Other"] } }) },
  tasks: { type: "array", items: obj({ side: { type: "string", enum: ["Alleviate", "Customer"] }, state: { type: "string", enum: ["done", "to do"] }, who: str, text: str }) },
  insights: {
    type: "array",
    items: obj({
      type: { type: "string", enum: [...INSIGHT_TYPES] },
      text: str,
      who: str,
      owner_side: { type: "string", enum: ["Alleviate", "Customer", "None"] },
      quote: str,
      quote_time: str,
      status: { type: "string", enum: ["Open", "Done", "No action"] },
    }),
  },
});

export function readConversation(env: Env, prompts: Prompts, c: { customerName: string; source: string; title: string; occurredAt: string; text: string; private?: boolean }): Promise<ConversationRead> {
  const system = `You read one conversation between Alleviate Health (an AI patient-recruitment company for clinical research sites) and a customer, and record what matters for the customer success team.

${prompts.insightInstructions}

Also list:
- people: everyone who took part, with company and side.
- tasks: concrete things each side completed in this conversation ("done") or committed to do next ("to do"), one line each, naming who.
- quote_time: "mm:ss" for calls, "" otherwise.
${c.private ? `- This is a private conversation (an email or a 1:1 direct message). Still give a word-for-word quote for each insight (it is kept only in a locked archive), but write the insight text and the summary as a neutral business point in your own words, without echoing the person's phrasing or tone.
` : ""}- If the source is Slack and the title says "shared with the customer", the customer is in this channel: people whose name is followed by the customer's name in brackets are the customer, everyone else is our team. Treat it like any customer chat.
- Any other Slack source is an internal Alleviate team channel about the customer: the customer is not in it. Record our team's plans, decisions, open tasks and concerns about the account, always as our side; never present them as something the customer said or wants. If the title says "messages naming the customer", these are messages from a general team channel that mention this customer: record only what is about this customer.
- If the text has an "Earlier messages (background only)" section, use it only to understand what the new messages refer to. Record people, tasks and insights only from the "New messages" section; the earlier ones were already recorded.

${HARD_RULES}`;
  const user = `Customer: ${c.customerName}
Source: ${c.source}
Title: ${c.title}
Date: ${c.occurredAt.slice(0, 10)}

<conversation>
${c.text}
</conversation>`;
  return structured<ConversationRead>(env, { system, user, schema: READ_SCHEMA, effort: "medium", maxTokens: 16000 });
}

// ---------- 1b. internal and prospect calls -> product ideas ----------
// BlueDot calls with no customer on them (team meetings, prospect demos, vendor calls). Hiring
// interviews and private recordings never get this far. Same answer shape as a customer read, so
// the insights land in the same table (with no customer).

const INTERNAL_TYPES = ["Product idea", "Request", "Product feedback", "Decision"] as const;
const INTERNAL_SCHEMA = obj({
  summary: str,
  people: { type: "array", items: obj({ name: str, company: str, side: { type: "string", enum: ["Alleviate", "Customer", "Other"] } }) },
  tasks: { type: "array", items: obj({ side: { type: "string", enum: ["Alleviate", "Customer"] }, state: { type: "string", enum: ["done", "to do"] }, who: str, text: str }) },
  insights: {
    type: "array",
    items: obj({
      type: { type: "string", enum: [...INTERNAL_TYPES] },
      text: str,
      who: str,
      owner_side: { type: "string", enum: ["Alleviate", "Customer", "None"] },
      quote: str,
      quote_time: str,
      status: { type: "string", enum: ["Open", "Done", "No action"] },
    }),
  },
});

export function readInternalCall(env: Env, c: { label: string; title: string; occurredAt: string; text: string; chat?: boolean }): Promise<ConversationRead> {
  const what = c.chat
    ? "one day of messages in an internal Alleviate Health Slack channel (Alleviate is an AI patient-recruitment company for clinical research sites). Only our team writes there"
    : "one recorded call at Alleviate Health (an AI patient-recruitment company for clinical research sites) that has no customer on it: either an internal team meeting, or a call with a prospect or vendor";
  const system = `You read ${what}. Your job is to collect what matters for the product.

Record as insights:
- Product idea: a feature, improvement or workflow change someone proposed, including half-formed ideas, and the problem it would solve.
- Request: something a prospect or vendor asked Alleviate's product to do, or said they would need before buying.
- Product feedback: a prospect's reaction to the product (what impressed them, what put them off, objections, comparisons to competitors).
- Decision: a decision the team made about the product (build, change, drop, prioritize).

Rules for insights:
- One insight per row, written as one plain sentence that says what the idea or need is and why.
- who: the person who raised it. owner_side: "Alleviate" for anything our team would build or decide, otherwise "None". Use "Customer" only for a prospect's own follow-up.
- status: "Open" for ideas and requests not yet acted on, "Done" if the call says it already shipped, "No action" if it was considered and dropped.
- Skip small talk, scheduling, sales logistics, pricing negotiation and anything not about the product. Fewer, better insights beat many weak ones.
${c.chat
    ? `- Every insight needs a short exact quote from the messages, and as quote_time the message's time exactly as written in its brackets (e.g. "2026-11-02 17:05 UTC"). If you can't find a quote, leave it out.
- When a message is about a named customer, say which customer in the insight text. If the text has an "Earlier messages (background only)" section, use it only to understand the new messages; record insights only from the "New messages" section.`
    : "- Every insight needs a short exact quote from the transcript and its [mm:ss] timestamp. If you can't find a quote, leave it out."}

Also list:
- people: everyone who took part, with company and side (our team is "Alleviate"; prospects, vendors and anyone else are "Other").
- tasks: concrete product-related things someone committed to do ("to do") or reported finished ("done"), one line each, naming who. Our team is side "Alleviate"; anyone else is "Customer".
- summary: two or three sentences on what the ${c.chat ? "messages were" : "call was"} about, from a product point of view.

${HARD_RULES}`;
  const user = `${c.chat ? "Source" : "Call type"}: ${c.label}
Title: ${c.title}
Date: ${c.occurredAt.slice(0, 10)}

<conversation>
${c.text}
</conversation>`;
  return structured<ConversationRead>(env, { system, user, schema: INTERNAL_SCHEMA, effort: "medium", maxTokens: 16000 });
}

// ---------- 1c. the weekly product-ideas roll-up ----------

export async function writeProductIdeas(env: Env, input: { weekLabel: string; items: string }): Promise<string> {
  const system = `You write the "Product ideas this week" section of Alleviate Health's weekly customer digest, read by leadership and the product team.

You get every product idea, request and piece of product feedback recorded this week, each tagged with where it came from: a customer (by name), a prospect or vendor call, or an internal team meeting.

Write markdown:
- Group the same or similar ideas together under a short bold theme name, most frequently raised first.
- Under each theme: one line saying what's being asked for and why, then "Raised by:" listing each source (customer name, "Prospect: <company or call title>", or "Internal: <meeting title>") with the date and the link when given.
- Say how many separate customers, prospects and internal meetings raised each theme.
- End with a short "Single mentions" list for ideas raised only once that don't fit a theme.
- No intro or conclusion. If there is nothing, write "No product ideas were recorded this week."

${HARD_RULES}`;
  const user = `Week: ${input.weekLabel}

<this_weeks_items>
${input.items}
</this_weeks_items>`;
  const r = await structured<{ markdown: string }>(env, { system, user, schema: obj({ markdown: str }), effort: "medium", maxTokens: 16000 });
  return r.markdown;
}

// ---------- 2. the living Account Brief ----------

export interface BriefOut { brief_markdown: string; sentiment: (typeof SENTIMENTS)[number]; open_risks: number }

const BRIEF_SCHEMA = obj({ brief_markdown: str, sentiment: { type: "string", enum: [...SENTIMENTS] }, open_risks: { type: "integer" } });

export function writeBrief(env: Env, prompts: Prompts, input: { customerName: string; today: string; previousBrief: string; history: string }): Promise<BriefOut> {
  const questions = prompts.standingQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const system = `You maintain the living Account Brief for one Alleviate Health customer, read by the customer success team.

${prompts.briefInstructions}

Standing questions to answer in the brief:
${questions}

Format brief_markdown with "## " section headings, "- " bullets and [text](url) links to the source conversations. sentiment is your overall read of the account right now. open_risks is the number of unresolved risks.

${HARD_RULES}`;
  const user = `Customer: ${input.customerName}
Today: ${input.today}

<previous_brief>
${input.previousBrief || "(none yet - this is the first brief)"}
</previous_brief>

<conversation_history newest_first="true">
${input.history}
</conversation_history>`;
  // Briefs synthesize months of history into one judgment, so they run on the stronger model.
  return structured<BriefOut>(env, { system, user, schema: BRIEF_SCHEMA, effort: "high", maxTokens: 32000, model: env.BRIEF_MODEL || env.ANTHROPIC_MODEL });
}

// ---------- 3. the weekly 5-bucket report ----------

export interface ReportOut {
  alleviate_done: string[];
  customer_done: string[];
  alleviate_todo: string[];
  customer_todo: string[];
  sentiment: { kind: "praise" | "concern"; text: string }[];
  overall: (typeof SENTIMENTS)[number];
}

const list = { type: "array", items: str };
const REPORT_SCHEMA = obj({
  alleviate_done: list,
  customer_done: list,
  alleviate_todo: list,
  customer_todo: list,
  sentiment: { type: "array", items: obj({ kind: { type: "string", enum: ["praise", "concern"] }, text: str }) },
  overall: { type: "string", enum: [...SENTIMENTS] },
});

export async function writeWeeklyReport(env: Env, prompts: Prompts, input: { customerName: string; weekLabel: string; week: string }): Promise<ReportOut> {
  const system = `You write this week's report for one Alleviate Health customer, using only this week's conversations.

${prompts.reportInstructions}

Return each bucket as a list of plain one-line bullets (no leading dash or emoji); return an empty list when a bucket has nothing. Sentiment items are tagged praise or concern, most serious concern first. overall is your read of the account this week.

${HARD_RULES}`;
  const user = `Customer: ${input.customerName}
Week: ${input.weekLabel}

<this_weeks_conversations>
${input.week}
</this_weeks_conversations>`;
  const r = await structured<ReportOut>(env, { system, user, schema: REPORT_SCHEMA, effort: "medium", maxTokens: 16000 });
  // The Prompts page says "up to 3 bullets"; enforce it so one chatty week can't blow up Slack.
  for (const k of ["alleviate_done", "customer_done", "alleviate_todo", "customer_todo"] as const) r[k] = r[k].slice(0, 3);
  r.sentiment = r.sentiment.slice(0, 3);
  return r;
}
