// Customer list: Attio is the source of truth for which accounts are active (Customer/Pilot)
// and their domains. Each run mirrors that into Supabase and the Notion Customers table,
// keyed on the Attio record id.

import type { Env } from "./env.ts";
import type { CustomerRow, Db } from "./db.ts";
import { createPage, notion, prop, updatePage } from "./notion.ts";

interface AttioRecord {
  id: { record_id: string };
  values: Record<string, { value?: unknown; domain?: string; option?: { title?: string }; status?: { title?: string } }[]>;
}

async function attioActiveCompanies(env: Env): Promise<{ id: string; name: string; status: string; domains: string[] }[]> {
  const out: { id: string; name: string; status: string; domains: string[] }[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.ATTIO_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: { $or: [{ account_status: "Customer" }, { account_status: "Pilot" }] },
        limit: 500,
        offset,
      }),
    });
    if (!res.ok) throw new Error(`attio query -> ${res.status} ${await res.text()}`);
    const { data } = (await res.json()) as { data: AttioRecord[] };
    for (const r of data) {
      const name = String(r.values.name?.[0]?.value ?? "").trim();
      if (!name || /\btest\b/i.test(name)) continue; // e.g. "Yoshi Pylon Test Sync"
      const s = r.values.account_status?.[0];
      out.push({
        id: r.id.record_id,
        name,
        status: s?.option?.title ?? s?.status?.title ?? "Customer",
        domains: (r.values.domains ?? []).map((d) => String(d.domain ?? "").toLowerCase()).filter(Boolean),
      });
    }
    if (data.length < 500) break;
    offset += 500;
  }
  return out;
}

/** Notion Customers rows keyed by Attio Record ID. */
async function notionCustomerPages(env: Env): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const r = await notion<{ results: { id: string; properties: Record<string, { rich_text?: { plain_text: string }[] }> }[]; has_more: boolean; next_cursor: string | null }>(
      env, `/data_sources/${env.NOTION_CUSTOMERS_DS}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of r.results) {
      const rid = (p.properties["Attio Record ID"]?.rich_text ?? []).map((t) => t.plain_text).join("").trim();
      if (rid) map.set(rid, p.id);
    }
    cursor = r.has_more ? r.next_cursor ?? undefined : undefined;
  } while (cursor);
  return map;
}

/**
 * Mirror Attio -> Supabase + Notion. New Customer/Pilot accounts are added; nothing is ever
 * removed or switched off automatically (Yoshi, Oct 23: a one-off Attio blip once dropped Keystone).
 * "No longer active" is set by hand in Supabase `customers.status` and is never overwritten here.
 */
export async function syncCustomers(env: Env, db: Db): Promise<CustomerRow[]> {
  const [attio, pages, existing] = await Promise.all([
    attioActiveCompanies(env),
    notionCustomerPages(env),
    db.select<CustomerRow>("customers", "select=*"),
  ]);
  const prev = new Map(existing.map((c) => [c.attio_record_id, c]));
  const active = new Set(attio.map((a) => a.id));

  const rows: CustomerRow[] = [];
  for (const a of attio) {
    const manualOff = prev.get(a.id)?.status === "No longer active";
    const status = manualOff ? "No longer active" : a.status;
    let pageId = pages.get(a.id) ?? prev.get(a.id)?.notion_page_id ?? null;
    if (!pageId) {
      pageId = await createPage(env, env.NOTION_CUSTOMERS_DS, {
        Name: prop.title(a.name),
        Status: prop.select(a.status),
        Domains: prop.text(a.domains.join(", ")),
        "Attio Record ID": prop.text(a.id),
        Attio: prop.url(`https://app.attio.com/your-workspace/company/${a.id}/overview`),
      });
    } else if (prev.get(a.id)?.status !== status) {
      await updatePage(env, pageId, { Status: prop.select(status) });
    }
    rows.push({
      attio_record_id: a.id,
      name: a.name,
      status,
      domains: a.domains,
      notion_page_id: pageId,
      pylon_account_id: prev.get(a.id)?.pylon_account_id ?? null,
    });
  }

  if (rows.length) await db.upsert("customers", rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })));
  // Accounts no longer Customer/Pilot in Attio keep their row and status untouched.
  const kept = existing.filter((c) => !active.has(c.attio_record_id));
  return [...rows, ...kept].filter((r) => r.status !== "No longer active");
}
