// Supabase (Postgres) access through its REST layer (PostgREST). Plain fetch, no SDK: the
// engine only needs select / upsert / update, and the service key bypasses row-level security.

import type { Env } from "./env.ts";

export interface CustomerRow {
  attio_record_id: string;
  name: string;
  status: string;
  domains: string[];
  notion_page_id: string | null;
  pylon_account_id: string | null;
}

export interface ConversationRow {
  id: string;
  source: string;
  source_id: string;
  customer_id: string | null;
  title: string | null;
  occurred_at: string;
  participants: { name?: string; email?: string }[];
  url: string | null;
  raw_text: string;
  raw_json?: unknown;
  summary?: string | null;
  extraction?: unknown;
  kind?: string;
  thread_id?: string | null;
  state?: string;
  skip_reason?: string | null;
  error?: string | null;
  attempts?: number;
  extracted_at?: string | null;
}

export interface InsightRow {
  id?: number;
  conversation_id: string;
  customer_id: string | null;
  type: string;
  text: string;
  who: string | null;
  owner_side: string | null;
  quote: string | null;
  quote_time: string | null;
  status: string;
  occurred_at: string;
  notion_page_id?: string | null;
}

export class Db {
  constructor(private env: Env) {}

  private async req<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const key = this.env.SUPABASE_SERVICE_KEY;
    const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
    // Legacy service_role keys are JWTs and also go in Authorization. The newer "sb_secret_"
    // keys are not JWTs and are rejected there, so they travel in the apikey header only.
    if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
    if (init.prefer) headers.Prefer = init.prefer;
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  select<T>(table: string, query: string): Promise<T[]> {
    return this.req<T[]>(`${table}?${query}`);
  }

  /** Insert or merge on the primary key. */
  upsert<T>(table: string, rows: T | T[], onConflict?: string): Promise<void> {
    const q = onConflict ? `?on_conflict=${onConflict}` : "";
    return this.req<void>(`${table}${q}`, {
      method: "POST",
      body: JSON.stringify(rows),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }

  /** Insert only rows whose key doesn't exist yet; existing rows are left untouched. */
  insertNew<T>(table: string, rows: T[], onConflict: string): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return this.req<void>(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      body: JSON.stringify(rows),
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }

  /** Insert, skipping rows whose key already exists; returns only the rows actually inserted. */
  insertNewReturning<T>(table: string, rows: T[], onConflict: string): Promise<T[]> {
    if (rows.length === 0) return Promise.resolve([]);
    return this.req<T[]>(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      body: JSON.stringify(rows),
      prefer: "resolution=ignore-duplicates,return=representation",
    });
  }

  insertReturning<T>(table: string, rows: T[]): Promise<T[]> {
    if (rows.length === 0) return Promise.resolve([]);
    return this.req<T[]>(table, { method: "POST", body: JSON.stringify(rows), prefer: "return=representation" });
  }

  update(table: string, filter: string, patch: Record<string, unknown>): Promise<void> {
    return this.req<void>(`${table}?${filter}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
      prefer: "return=minimal",
    });
  }

  delete(table: string, filter: string): Promise<void> {
    return this.req<void>(`${table}?${filter}`, { method: "DELETE", prefer: "return=minimal" });
  }

  async getState<T>(source: string): Promise<T | null> {
    const rows = await this.select<{ data: T }>("source_state", `source=eq.${encodeURIComponent(source)}&select=data`);
    return rows[0]?.data ?? null;
  }

  setState(source: string, data: unknown): Promise<void> {
    return this.upsert("source_state", { source, data, updated_at: new Date().toISOString() });
  }
}

export interface MessageRow {
  id: string;
  source: string;
  thread_id: string;
  thread_title: string | null;
  thread_url: string | null;
  sent_at: string;
  author_name: string | null;
  author_email: string | null;
  text: string;
  account_domains: string[];
}
