// Slack posting via chat.postMessage. Slack's own markup (mrkdwn): *bold*, _italic_,
// <url|label>. Long digests are split between customers, never inside one.

import type { Env } from "./env.ts";

const MAX_CHARS = 3500;

export async function postMessages(env: Env, sections: string[]): Promise<string[]> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID) return [];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sections) {
    if (cur && cur.length + s.length + 2 > MAX_CHARS) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${s}` : s;
  }
  if (cur) chunks.push(cur);

  const links: string[] = [];
  for (const text of chunks) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN.trim()}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, unfurl_links: false, unfurl_media: false }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
    if (!data.ok) throw new Error(`slack chat.postMessage -> ${data.error}`);
    const permalink = await fetch(`https://slack.com/api/chat.getPermalink?channel=${data.channel}&message_ts=${data.ts}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN.trim()}` },
    }).then((r) => r.json() as Promise<{ permalink?: string }>);
    links.push(permalink.permalink ?? "");
  }
  return links;
}

/** Escape the three characters Slack treats as markup in plain text. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
