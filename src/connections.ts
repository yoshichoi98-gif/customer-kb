// Per-person sign-ins for Google Chat (Google) and Teams chats (Microsoft). Gmail is not
// requested (switched off Oct 9 for privacy; customer email is to come from Pylon instead).
//
// Each ops person signs in once on /connect. Their refresh token is encrypted (AES-GCM, key in
// the TOKEN_ENC_KEY secret) and stored in Supabase `source_state` under "conn:<provider>:<email>",
// so a database reader alone can't use it. The engine only ever reads the accounts of people who
// signed in, and anyone can disconnect from the same page.

import type { Env } from "./env.ts";
import type { Db } from "./db.ts";

export type Provider = "google" | "microsoft";

export interface Connection {
  provider: Provider;
  email: string;
  name?: string;
  token_enc: string; // encrypted refresh token
  connected_at: string;
  last_error?: string | null;
}

const BASE = "https://customer-kb.example.workers.dev";
export const REDIRECT = { google: `${BASE}/connect/google/callback`, microsoft: `${BASE}/connect/microsoft/callback` };
const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  // Turns the "users/123" ids Google Chat gives us into emails, for DMs with customers.
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
].join(" ");
const MS_SCOPES = "offline_access User.Read Chat.Read";

// ---------- encryption ----------

async function key(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY.trim()), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(plain)));
  const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, iv.length);
  return btoa(String.fromCharCode(...all));
}
async function decrypt(env: Env, enc: string): Promise<string> {
  const all = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await key(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------- storage ----------

export async function listConnections(db: Db, provider?: Provider): Promise<Connection[]> {
  const prefix = provider ? `conn:${provider}:` : "conn:";
  const rows = await db.select<{ data: Connection }>("source_state", `source=like.${encodeURIComponent(prefix)}*&select=data`);
  return rows.map((r) => r.data).filter((c) => c && c.token_enc);
}

async function saveConnection(db: Db, c: Connection): Promise<void> {
  await db.setState(`conn:${c.provider}:${c.email}`, c);
}

/** Disconnect: for Google, also cancel the app's access in the person's Google account (revoking
 *  the refresh token revokes every permission granted, including the old Gmail one). The next
 *  Connect then grants only the permissions the sign-in asks for today. */
export async function removeConnection(env: Env, db: Db, provider: Provider, email: string): Promise<void> {
  const c = (await db.getState<Connection>(`conn:${provider}:${email}`));
  if (provider === "google" && c?.token_enc) {
    try {
      const token = await decrypt(env, c.token_enc);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    } catch { /* already revoked or unreadable: still remove it below */ }
  }
  await db.delete("source_state", `source=eq.${encodeURIComponent(`conn:${provider}:${email}`)}`);
}

export async function markError(db: Db, c: Connection, error: string | null): Promise<void> {
  await saveConnection(db, { ...c, last_error: error });
}

// ---------- sign-in flow ----------

function rand(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, "");
}

export async function startConnect(env: Env, db: Db, provider: Provider): Promise<string> {
  const state = rand();
  await db.setState(`oauth_state:${state}`, { provider, expires: Date.now() + 15 * 60_000 });
  if (provider === "google") {
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID.trim(), redirect_uri: REDIRECT.google, response_type: "code",
      // No include_granted_scopes: a reconnect grants exactly these scopes, so Gmail access from
      // an earlier sign-in isn't carried over.
      scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent",
      hd: "example.com", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: env.MS_CLIENT_ID.trim(), redirect_uri: REDIRECT.microsoft, response_type: "code",
    scope: MS_SCOPES, response_mode: "query", prompt: "select_account", state,
  });
  return `https://login.microsoftonline.com/${env.MS_TENANT_ID.trim()}/oauth2/v2.0/authorize?${q}`;
}

async function tokenRequest(url: string, body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  return res.json();
}

function tokenUrl(env: Env, provider: Provider): string {
  return provider === "google" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${env.MS_TENANT_ID.trim()}/oauth2/v2.0/token`;
}
function clientCreds(env: Env, provider: Provider): { client_id: string; client_secret: string } {
  return provider === "google"
    ? { client_id: env.GOOGLE_CLIENT_ID.trim(), client_secret: env.GOOGLE_CLIENT_SECRET.trim() }
    : { client_id: env.MS_CLIENT_ID.trim(), client_secret: env.MS_CLIENT_SECRET.trim() };
}

/** Handle the redirect back from Google/Microsoft. Returns a message for the person (+ who they are on success). */
export async function finishConnect(env: Env, db: Db, provider: Provider, code: string, state: string): Promise<{ message: string; email?: string }> {
  const r = await finishConnectInner(env, db, provider, code, state);
  return typeof r === "string" ? { message: r } : r;
}

async function finishConnectInner(env: Env, db: Db, provider: Provider, code: string, state: string): Promise<string | { message: string; email: string }> {
  const st = await db.getState<{ provider: Provider; expires: number }>(`oauth_state:${state}`);
  await db.delete("source_state", `source=eq.${encodeURIComponent(`oauth_state:${state}`)}`);
  if (!st || st.provider !== provider || Date.now() > st.expires) return "This sign-in link expired. Go back to the Connect page and try again.";

  const t = await tokenRequest(tokenUrl(env, provider), {
    grant_type: "authorization_code", code, redirect_uri: REDIRECT[provider], ...clientCreds(env, provider),
    ...(provider === "microsoft" ? { scope: MS_SCOPES } : {}),
  });
  if (!t.access_token) return `Sign-in failed: ${t.error_description ?? t.error ?? "no access token"}`;
  if (!t.refresh_token) return "Sign-in worked but no long-term access was granted, so it would stop working within an hour. Tell Yoshi.";

  let email = "", name = "";
  if (provider === "google") {
    const u = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json() as Promise<{ email?: string; name?: string }>);
    email = (u.email ?? "").toLowerCase(); name = u.name ?? "";
  } else {
    const u = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json() as Promise<{ mail?: string; userPrincipalName?: string; displayName?: string }>);
    email = (u.mail ?? u.userPrincipalName ?? "").toLowerCase(); name = u.displayName ?? "";
  }
  if (!email.endsWith("@example.com")) return `Signed in as ${email || "an unknown account"}. Please use your @example.com account.`;

  await saveConnection(db, { provider, email, name, token_enc: await encrypt(env, t.refresh_token), connected_at: new Date().toISOString(), last_error: null });
  return { message: `Connected ${provider === "google" ? "Google Chat" : "Teams chats"} for ${email}.`, email };
}

/** Fresh access token for a stored connection (refresh tokens may rotate; the new one is saved). */
export async function accessToken(env: Env, db: Db, c: Connection): Promise<string> {
  const refresh = await decrypt(env, c.token_enc);
  const t = await tokenRequest(tokenUrl(env, c.provider), {
    grant_type: "refresh_token", refresh_token: refresh, ...clientCreds(env, c.provider),
    ...(c.provider === "microsoft" ? { scope: MS_SCOPES } : {}),
  });
  if (!t.access_token) {
    const msg = `sign-in no longer works (${t.error ?? "unknown"}); ${c.email} needs to reconnect`;
    await markError(db, c, msg);
    throw new Error(msg);
  }
  if (t.refresh_token && t.refresh_token !== refresh) await saveConnection(db, { ...c, token_enc: await encrypt(env, t.refresh_token), last_error: null });
  else if (c.last_error) await markError(db, c, null);
  return t.access_token;
}

// ---------- "who is this" cookie for the Connect page ----------
// After someone signs in, their browser gets a signed cookie with their email (30 days), so the
// Connect page can show and disconnect ONLY their own connections. Signed with an HMAC key
// derived from TOKEN_ENC_KEY, so it can't be forged by editing the cookie.

const COOKIE = "ckb_who";

async function hmacKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.TOKEN_ENC_KEY.trim()), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function whoCookie(env: Env, email: string): Promise<string> {
  const payload = `${email}|${Date.now() + 30 * 86400_000}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload)));
  const value = btoa(`${payload}|${btoa(String.fromCharCode(...sig))}`);
  return `${COOKIE}=${value}; Path=/connect; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export async function whoIs(env: Env, cookieHeader: string | null): Promise<string | null> {
  const m = (cookieHeader ?? "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;
  try {
    const [email, exp, sigB64] = atob(m[1]).split("|");
    if (!email || Date.now() > Number(exp)) return null;
    const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), sig, new TextEncoder().encode(`${email}|${exp}`));
    return ok ? email : null;
  } catch { return null; }
}
