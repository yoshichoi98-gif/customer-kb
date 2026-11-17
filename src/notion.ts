// Notion REST client: plain fetch, sequential writes, retry on 429.
//
// Limits that cause confusing 400s if ignored (learned on coldcall-analyzer):
//   - 2000 characters per rich_text element  -> text is chunked at 1900.
//   - 100 children per append request        -> blocks are appended in batches of 90.
//   - ~3 requests/second per integration     -> never Promise.all writes.
//   - Writes name properties by their exact column name, so renaming a column in the UI
//     breaks the engine. Columns used here are listed in README.md.

import type { Env } from "./env.ts";

const BASE = "https://api.notion.com/v1";
const VERSION = "2025-09-03"; // data-source-aware API (databases are addressed by data source id)
const MAX_TEXT = 1900;
const MAX_CHILDREN = 90;

export async function notion<T>(env: Env, path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN.trim()}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Number(res.headers.get("Retry-After") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(1000, wait * 1000) * (attempt + 1)));
    return notion<T>(env, path, method, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------- rich text + blocks ----------

type RichText = { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: { bold?: boolean; italic?: boolean } };

/** Inline markdown -> rich text: supports **bold**, *italic* and [text](url). */
export function richText(s: string): RichText[] {
  const out: RichText[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (content: string, extra: Partial<RichText> = {}) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push({ type: "text", text: { ...(extra.text ?? {}), content: content.slice(i, i + MAX_TEXT) }, ...(extra.annotations ? { annotations: extra.annotations } : {}) } as RichText);
    }
  };
  while ((m = re.exec(s))) {
    if (m.index > last) push(s.slice(last, m.index));
    if (m[1]) push(m[1], { annotations: { bold: true } });
    else if (m[2]) push(m[2], { annotations: { italic: true } });
    else if (m[3]) push(m[3], { text: { content: "", link: { url: m[4] } } } as Partial<RichText>);
    last = re.lastIndex;
  }
  if (last < s.length) push(s.slice(last));
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

/** Small markdown -> Notion blocks converter: #/##/### headings, - bullets, 1. numbered, paragraphs. */
export function markdownToBlocks(md: string): unknown[] {
  const blocks: unknown[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const t = `heading_${m[1].length}`;
      blocks.push({ object: "block", type: t, [t]: { rich_text: richText(m[2]) } });
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      blocks.push({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(m[1]) } });
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      blocks.push({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText(m[1]) } });
    } else {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: richText(line) } });
    }
  }
  return blocks;
}

// ---------- pages ----------

export async function createPage(env: Env, dataSourceId: string, properties: Record<string, unknown>, children: unknown[] = []): Promise<string> {
  const page = await notion<{ id: string }>(env, "/pages", "POST", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties,
    children: children.slice(0, MAX_CHILDREN),
  });
  if (children.length > MAX_CHILDREN) await appendBlocks(env, page.id, children.slice(MAX_CHILDREN));
  return page.id;
}

export function updatePage(env: Env, pageId: string, properties: Record<string, unknown>): Promise<unknown> {
  return notion(env, `/pages/${pageId}`, "PATCH", { properties });
}

export async function appendBlocks(env: Env, blockId: string, blocks: unknown[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN) {
    await notion(env, `/blocks/${blockId}/children`, "PATCH", { children: blocks.slice(i, i + MAX_CHILDREN) });
  }
}

interface Block { id: string; type: string; has_children?: boolean; [k: string]: unknown }

export async function listChildren(env: Env, blockId: string): Promise<Block[]> {
  const out: Block[] = [];
  let cursor: string | undefined;
  do {
    const r = await notion<{ results: Block[]; has_more: boolean; next_cursor: string | null }>(
      env, `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`, "GET");
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  return out;
}

/** Replace a page's whole body (used for the living Account Brief). Child pages/databases are kept. */
export async function replacePageBody(env: Env, pageId: string, blocks: unknown[]): Promise<void> {
  const existing = await listChildren(env, pageId);
  for (const b of existing) {
    if (b.type === "child_page" || b.type === "child_database") continue;
    await notion(env, `/blocks/${b.id}`, "DELETE");
  }
  await appendBlocks(env, pageId, blocks);
}

/** Plain text of a block (for reading the Prompts page). */
export function blockText(b: Block): string {
  const body = b[b.type] as { rich_text?: { plain_text?: string }[] } | undefined;
  return (body?.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
}

// ---------- property helpers ----------

export const prop = {
  title: (s: string) => ({ title: richText(s.slice(0, 1900)) }),
  text: (s: string | null | undefined) => ({ rich_text: s ? richText(s) : [] }),
  select: (s: string | null | undefined) => ({ select: s ? { name: s } : null }),
  date: (iso: string | null | undefined) => ({ date: iso ? { start: iso.slice(0, 10) } : null }),
  url: (s: string | null | undefined) => ({ url: s || null }),
  number: (n: number | null | undefined) => ({ number: n ?? null }),
  relation: (ids: string[]) => ({ relation: ids.map((id) => ({ id })) }),
};
