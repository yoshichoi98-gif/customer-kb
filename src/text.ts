// Small text helpers shared by the message sources.

export function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Drop the quoted history under an email reply ("On Tue, X wrote:" and "> ..." lines, Outlook
 * "From: ... Sent: ..." blocks), so each stored email holds only what was newly written.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{5,200} wrote:\s*$/.test(l.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    if (/^From:\s.+/i.test(l.trim()) && /^(Sent|Date):\s/i.test((lines[i + 1] ?? "").trim())) break;
    if (/^_{10,}$/.test(l.trim())) break; // Outlook separator line before quoted mail
    if (l.trim().startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** "Jane Doe <jane@x.com>, bob@y.com" -> [{name, email}] */
export function parseAddresses(header: string | undefined): { name?: string; email: string }[] {
  if (!header) return [];
  const out: { name?: string; email: string }[] = [];
  for (const part of header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? part.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
    if (m) out.push({ name: m[1]?.trim() || undefined, email: m[2].trim().toLowerCase() });
  }
  return out;
}
