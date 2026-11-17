// The editable parts of the Claude prompts. Until Oct 27 these were read from the Notion
// "Prompts & Questions" page each run; Yoshi chose to keep them here instead (no Notion, and the
// team doesn't need to edit them).
// To change a prompt, edit it here and redeploy.

import type { Env } from "./env.ts";

export interface Prompts {
  standingQuestions: string[];
  insightInstructions: string;
  briefInstructions: string;
  reportInstructions: string;
  slack: { includeNoContact: boolean };
}

const STANDING_QUESTIONS = [
  "What product feedback did they give (praise, complaints, feature requests)?",
  "What changed for this account this week?",
  "What is at risk, and what would make it worse?",
  "What did we promise them, and is it done?",
  "Who are the key people on their side, and what does each care about?",
];

const INSIGHT_INSTRUCTIONS = `You are reading one full conversation between Alleviate Health and a customer (a call transcript, an email thread, or a chat) and pulling out the things worth remembering. Each becomes one row in Insights.
- Types: Product feedback, Request, Bug, Risk, Decision, Promise, Praise.
- One insight per row, written as one plain sentence ("Jane wants a weekly export of new referrals").
- Record who said it and which side owns any follow-up (Alleviate or Customer).
- Skip small talk, scheduling logistics and anything routine. Fewer, better insights beat many weak ones.
- For calls, every claim must come with a short exact quote from the transcript and its timestamp, like ("we need the dashboard by Friday" 12:31). If you can't find a quote for something, leave it out.
- Never copy a calendar date from an AI-generated summary. Use the conversation's own date or relative wording like "next week".
- Don't use em-dashes.`;

const BRIEF_INSTRUCTIONS = `You are rewriting the living Account Brief for one customer, using their past conversations and last week's brief.

Sections, in this order:
1. Where things stand: 3 to 5 sentences on the current state of the account.
2. Who's who: their people and ours, with role and what each cares about.
3. Open asks: what they're waiting on from us, and what we're waiting on from them.
4. Product feedback: running list, newest first, each with the date and a link to the conversation.
5. Risks: anything that could hurt the account, newest first.
6. Standing questions: answer each question from the Standing questions section.
7. History: one line per week, newest first.

Keep anything still true from last week's brief. Remove anything that's been resolved and note it in History. Every point links to the conversation it came from.`;

const REPORT_INSTRUCTIONS = `You are writing this week's report for one customer, using only this week's conversations.

Use exactly these five headings, with up to 3 bullets each. If one has nothing, write "Nothing noted".
- Tasks completed by Alleviate Team
- Tasks completed by Customer Team
- Tasks that need to be done by Alleviate Team
- Tasks that need to be done by Customer Team
- Sentiment (concerns or praises): start each bullet with 👍 for praise or ⚠️ for a concern, most serious first

Each bullet is one line, plain language, and names the person when known ("Jane: send the updated contact list"). Don't use em-dashes.`;

export async function loadPrompts(_env: Env): Promise<Prompts> {
  return {
    standingQuestions: STANDING_QUESTIONS,
    insightInstructions: INSIGHT_INSTRUCTIONS,
    briefInstructions: BRIEF_INSTRUCTIONS,
    reportInstructions: REPORT_INSTRUCTIONS,
    slack: { includeNoContact: true },
  };
}
