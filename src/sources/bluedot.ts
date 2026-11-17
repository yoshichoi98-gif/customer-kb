// BlueDot calls, read through BlueDot's MCP server - the same door Claude uses.
//
// BlueDot has no plain REST API, and its webhooks only cover the person who set them up unless
// support enables team-level webhooks. The MCP server, though, accepts standard OAuth with
// dynamic client registration and refresh tokens, and every team call is
// shared to the workspace. So one person signs in once (/connect/bluedot) and the engine can
// read every customer call with its full transcript, unattended.
//
// The sign-in belongs to that person: if their BlueDot account is removed, re-connect as
// someone else.

import type { Db } from "../db.ts";
import type { Conversation, Source } from "./types.ts";

const AUTH = "https://signin.bluedothq.com/oauth2";
const MCP_URL = "https://app.bluedothq.com/api/v1/mcp";
const SCOPE = "openid profile email offline_access";

interface BluedotState {
  client_id?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  connected_as?: string;
  redirect_client?: boolean;
  pending?: { state: string; verifier: string; expires_at: number };
}

async function form<T>(url: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data: T;
  try { data = JSON.parse(text) as T; } catch { data = { raw: text } as T; }
  return { ok: res.ok, status: res.status, data };
}

// ---------- sign-in (authorization code + PKCE, the same flow Claude uses) ----------
//
// BlueDot rejected the device-code flow ("Activation denied"), so sign-in is a normal redirect:
// /connect/bluedot sends the person to BlueDot, BlueDot sends them back to /connect/bluedot/callback.

const REDIRECT_URI = "https://customer-kb.example.workers.dev/connect/bluedot/callback";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ensureClient(db: Db, st: BluedotState): Promise<string> {
  if (st.client_id) return st.client_id;
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Alleviate Customer Knowledge Bank",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`bluedot client registration -> ${res.status} ${await res.text()}`);
  const { client_id } = (await res.json()) as { client_id: string };
  st.client_id = client_id;
  await db.setState("bluedot", st);
  return client_id;
}

/** Start sign-in: returns the BlueDot URL to send the person to. */
export async function startBluedotConnect(db: Db): Promise<string> {
  const st = (await db.getState<BluedotState>("bluedot")) ?? {};
  // A client registered for the old device-code flow can't do redirects; register fresh.
  if (st.client_id && !st.redirect_client) delete st.client_id;
  const clientId = await ensureClient(db, st);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  st.redirect_client = true;
  st.pending = { state, verifier, expires_at: Date.now() + 15 * 60_000 };
  await db.setState("bluedot", st);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
  });
  return `${AUTH}/authorize?${q}`;
}

/** BlueDot redirected back with ?code&state: swap the code for tokens. */
export async function finishBluedotConnect(db: Db, code: string, state: string): Promise<string> {
  const st = (await db.getState<BluedotState>("bluedot")) ?? {};
  if (!st.pending || !st.client_id || st.pending.state !== state) return "This sign-in link is stale. Start again from /connect/bluedot.";
  if (Date.now() > st.pending.expires_at) return "Sign-in took too long. Start again from /connect/bluedot.";
  const r = await form<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>(`${AUTH}/token`, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: st.client_id,
    code_verifier: st.pending.verifier,
    resource: MCP_URL,
  });
  if (!r.ok || !r.data.access_token) return `BlueDot sign-in failed: ${JSON.stringify(r.data)}`;
  st.access_token = r.data.access_token;
  st.refresh_token = r.data.refresh_token ?? st.refresh_token;
  st.expires_at = Date.now() + (r.data.expires_in ?? 3600) * 1000;
  delete st.pending;
  await db.setState("bluedot", st);
  if (!st.refresh_token) return "Connected, but BlueDot gave no refresh token, so the connection will expire. Tell Yoshi.";
  try {
    const me = await new McpClient(db).call<{ email?: string; user?: { email?: string } }>("get_current_user", {});
    st.connected_as = me.email ?? me.user?.email;
    await db.setState("bluedot", st);
  } catch { /* identity is nice-to-have */ }
  return `Connected${st.connected_as ? ` as ${st.connected_as}` : ""}. You can close this page.`;
}

async function accessToken(db: Db): Promise<string> {
  const st = (await db.getState<BluedotState>("bluedot")) ?? {};
  if (!st.refresh_token || !st.client_id) throw new Error("BlueDot is not connected. Open /connect/bluedot to sign in.");
  if (st.access_token && st.expires_at && Date.now() < st.expires_at - 120_000) return st.access_token;
  const r = await form<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>(`${AUTH}/token`, {
    grant_type: "refresh_token",
    refresh_token: st.refresh_token,
    client_id: st.client_id,
  });
  if (!r.ok || !r.data.access_token) throw new Error(`BlueDot sign-in expired (${JSON.stringify(r.data)}). Re-connect at /connect/bluedot.`);
  st.access_token = r.data.access_token;
  st.refresh_token = r.data.refresh_token ?? st.refresh_token; // refresh tokens may rotate
  st.expires_at = Date.now() + (r.data.expires_in ?? 3600) * 1000;
  await db.setState("bluedot", st);
  return st.access_token;
}

// ---------- minimal MCP client (streamable HTTP) ----------

class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private db: Db) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const token = await accessToken(this.db);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: this.nextId++, method, params };
    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    if (notify) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`bluedot mcp ${method} -> ${res.status} ${text.slice(0, 300)}`);
    // Either a plain JSON-RPC response or an SSE stream whose data lines carry it.
    const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? "{}"
      : text;
    const msg = JSON.parse(payload) as { result?: unknown; error?: { message: string } };
    if (msg.error) throw new Error(`bluedot mcp ${method}: ${msg.error.message}`);
    return msg.result;
  }

  private async init(): Promise<void> {
    if (this.sessionId) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "customer-kb", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", {}, true);
  }

  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    await this.init();
    const result = (await this.rpc("tools/call", { name: tool, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    if (result.isError) throw new Error(`bluedot ${tool}: ${result.content?.map((c) => c.text).join(" ")}`);
    if (result.structuredContent) return result.structuredContent as T;
    const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
    return JSON.parse(text) as T;
  }
}

// ---------- transcript formatting ----------

interface Word { start: number; text: string; speakerTag?: string }

function stamp(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Word-level transcript -> "[mm:ss] Speaker: sentence..." turns. */
export function toTurns(words: Word[]): string {
  const lines: string[] = [];
  let speaker = "", start = 0, buf: string[] = [];
  const flush = () => { if (buf.length) lines.push(`[${stamp(start)}] ${speaker || "Unknown"}: ${buf.join(" ")}`); buf = []; };
  for (const w of words) {
    const sp = w.speakerTag ?? "";
    // New turn on speaker change. Long monologues are split for fresh timestamps, but only at a
    // sentence end, so a quote never straddles two lines.
    const sentenceEnded = buf.length > 0 && /[.?!]$/.test(buf[buf.length - 1]);
    if (sp !== speaker || (buf.length >= 60 && sentenceEnded)) { flush(); speaker = sp; start = w.start; }
    buf.push(w.text);
  }
  flush();
  return lines.join("\n");
}

// ---------- the source ----------

// tenancy: "workspace" = shared with the team; "user" = the recorder marked it private.
interface MeetingListItem { id: string; title: string; meetingTime: string; url: string; tenancy?: string; collectionId?: string }
interface Meeting {
  id: string; title: string; meetingTime: string; url: string;
  uploadedBy?: { email?: string };
  meetingParticipants?: { email?: string }[];
  transcription?: Word[] | string;
  summary?: unknown;
}

export function bluedotSource(db: Db): Source {
  return {
    name: "bluedot",
    async enabled() {
      const st = await db.getState<BluedotState>("bluedot");
      return Boolean(st?.refresh_token);
    },
    async fetch(since, until, known) {
      const mcp = new McpClient(db);
      const items: MeetingListItem[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await mcp.call<{ items: MeetingListItem[]; pagination?: { hasNext?: boolean } }>("list_meetings", {
          uploadedFrom: since.toISOString().replace(/\.\d{3}Z$/, "Z"),
          uploadedTo: until.toISOString().replace(/\.\d{3}Z$/, "Z"),
          pageSize: 16,
          pageNumber: page,
        });
        items.push(...(r.items ?? []));
        if (!r.pagination?.hasNext) break;
      }

      // Folder names (e.g. "Hiring Interviews"), so the engine can leave interviews out.
      const folders = new Map<string, string>();
      try {
        const r = await mcp.call<{ collections?: { id: string; name: string }[] }>("list_collections", {});
        for (const c of r.collections ?? []) folders.set(c.id, c.name);
      } catch { /* folders are a hint only */ }

      const out: Conversation[] = [];
      for (const it of items) {
        if (known.has(it.id)) continue;
        // Private recordings are never saved or read (Yoshi, Oct 27). The sign-in can see the
        // signed-in person's own private calls, so this filter is what keeps them out.
        if (it.tenancy && it.tenancy !== "workspace") continue;
        const m = await mcp.call<Meeting>("get_meeting", { videoId: it.id });
        const words = Array.isArray(m.transcription) ? m.transcription : [];
        const transcript = words.length ? toTurns(words) : typeof m.transcription === "string" ? m.transcription : "";
        if (!transcript.trim()) continue; // still transcribing (or empty); retried on a later tick
        const participants = (m.meetingParticipants ?? []).map((p) => ({ email: (p.email ?? "").toLowerCase() })).filter((p) => p.email);
        out.push({
          source: "bluedot",
          sourceId: m.id,
          title: m.title,
          occurredAt: m.meetingTime,
          participants,
          url: m.url ?? `https://app.bluedothq.com/preview/${m.id}`,
          rawText: transcript,
          // Keep BlueDot's own summary only as a table of contents; never quoted as fact.
          rawJson: { uploadedBy: m.uploadedBy?.email ?? null, summary: m.summary ?? null, folder: (it.collectionId && folders.get(it.collectionId)) || null },
        });
      }
      return { conversations: out, messages: [] };
    },
  };
}
