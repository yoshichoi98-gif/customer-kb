// Customer Account Knowledge Bank engine (Cloudflare Worker).
//
// Cron: every 15 minutes -> tick() (see pipeline.ts).
//
// Routes (all but /health need ?token=<ADMIN_TOKEN>):
//   GET /health                    is it up
//   GET /status                    archive + run state, which sources are connected
//   GET /run                       run a tick now (add &ingest=1 to force a source pull,
//                                  &report=1 to force this week's report). Linked from the
//                                  Notion Prompts page as the "run now" button.
//   GET /connect/bluedot           one-time BlueDot sign-in (redirects to BlueDot and back)

import type { Env } from "./env.ts";
import { Db } from "./db.ts";
import { tick } from "./pipeline.ts";
import { loadPrompts } from "./prompts.ts";
import { notion } from "./notion.ts";
import { finishBluedotConnect, startBluedotConnect } from "./sources/bluedot.ts";
import { finishConnect, listConnections, removeConnection, startConnect, whoCookie, whoIs, type Provider } from "./connections.ts";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tickWithRequests(env).then((r) => console.log("[tick]", JSON.stringify(r))).catch((e) => console.error("[tick] failed", e)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "customer-kb" });
    if (url.pathname === "/connect/bluedot/callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return html(`<h2>BlueDot sign-in was not completed</h2><p>${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "No code returned."}</p>`);
      return html(`<h2>${await finishBluedotConnect(new Db(env), code, state)}</h2>`);
    }
    // ---- "Connect your accounts" (team-facing; protected by CONNECT_TOKEN, not the admin password)
    if (url.pathname === "/connect/google/callback" || url.pathname === "/connect/microsoft/callback") {
      const provider: Provider = url.pathname.includes("google") ? "google" : "microsoft";
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state) return html(`<h2>Sign-in was not completed</h2><p>${escHtml(url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "No code returned.")}</p>`);
      const r = await finishConnect(env, new Db(env), provider, code, state);
      const back = env.CONNECT_TOKEN ? `<p><a href="/connect?k=${encodeURIComponent(env.CONNECT_TOKEN.trim())}">Back to Connect your accounts</a></p>` : "";
      const res = html(`<h2>${escHtml(r.message)}</h2>${back}`);
      if (r.email) res.headers.append("Set-Cookie", await whoCookie(env, r.email));
      return res;
    }
    if (url.pathname === "/connect" || url.pathname === "/connect/google" || url.pathname === "/connect/microsoft" || url.pathname === "/connect/disconnect") {
      const k = url.searchParams.get("k");
      if (!env.CONNECT_TOKEN || k !== env.CONNECT_TOKEN.trim()) return new Response("This link is missing its access code. Ask Yoshi for the Connect link.", { status: 403 });
      const db = new Db(env);
      if (url.pathname === "/connect/google") return Response.redirect(await startConnect(env, db, "google"), 302);
      if (url.pathname === "/connect/microsoft") return Response.redirect(await startConnect(env, db, "microsoft"), 302);
      const me = await whoIs(env, request.headers.get("Cookie"));
      if (url.pathname === "/connect/disconnect") {
        // Only your own connection, identified by your sign-in cookie.
        const provider = url.searchParams.get("provider") as Provider;
        if (me && (provider === "google" || provider === "microsoft")) await removeConnection(env, db, provider, me);
        return Response.redirect(`${url.origin}/connect?k=${encodeURIComponent(k)}`, 302);
      }
      return html(await connectPage(db, k, me));
    }

    if (!env.ADMIN_TOKEN || url.searchParams.get("token") !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });
    const db = new Db(env);
    const t = encodeURIComponent(env.ADMIN_TOKEN);

    if (url.pathname === "/status") {
      const [conv, runs, bluedot, lastTick] = await Promise.all([
        db.select<{ state: string; source: string }>("conversations", "select=state,source"),
        db.select("runs", "select=*&order=week_of.desc&limit=5"),
        db.getState<{ refresh_token?: string; connected_as?: string }>("bluedot"),
        db.getState("last_tick"),
      ]);
      const counts: Record<string, number> = {};
      for (const c of conv) counts[`${c.source}:${c.state}`] = (counts[`${c.source}:${c.state}`] ?? 0) + 1;
      return json({
        last_tick: lastTick,
        conversations: counts,
        recent_runs: runs,
        sources: { bluedot: bluedot?.refresh_token ? `connected (${bluedot.connected_as ?? "unknown user"})` : "not connected", pylon: env.PYLON_API_TOKEN ? "connected" : "not connected", email: "not connected", teams: "not connected", google_chat: "not connected" },
        slack: env.SLACK_BOT_TOKEN ? "configured" : "not configured",
      });
    }

    if (url.pathname === "/check") {
      // Can the engine reach Notion (Prompts page + Customers table)?
      // Shape only, never the value: helps spot a wrong clipboard paste.
      const shape = (v?: string) => { const t = (v ?? "").trim(); return t ? `${t.slice(0, 4)}... (${t.length} chars${/\s/.test(t) ? ", contains spaces: probably not a key" : ""})` : "not set"; };
      const out: Record<string, string> = { notion_token_shape: shape(env.NOTION_TOKEN), anthropic_key_shape: shape(env.ANTHROPIC_API_KEY) };
      try {
        const p = await loadPrompts(env);
        out.prompts_page = `ok (${p.standingQuestions.length} standing questions)`;
      } catch (e) { out.prompts_page = `error: ${e instanceof Error ? e.message : e}`; }
      try {
        await notion(env, `/data_sources/${env.NOTION_CUSTOMERS_DS}/query`, "POST", { page_size: 1 });
        out.customers_table = "ok";
      } catch (e) { out.customers_table = `error: ${e instanceof Error ? e.message : e}`; }
      out.attio_token_shape = shape(env.ATTIO_API_KEY);
      try {
        const r = await fetch("https://api.attio.com/v2/objects/companies/records/query", {
          method: "POST",
          headers: { Authorization: `Bearer ${(env.ATTIO_API_KEY ?? "").trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ filter: { $or: [{ account_status: "Customer" }, { account_status: "Pilot" }] }, limit: 500 }),
        });
        out.attio = r.ok ? `ok (${((await r.json()) as { data: unknown[] }).data.length} Customer/Pilot companies)` : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.attio = `error: ${e instanceof Error ? e.message : e}`; }
      try {
        const r = await fetch("https://api.attio.com/v2/objects/people/records/query", {
          method: "POST",
          headers: { Authorization: `Bearer ${(env.ATTIO_API_KEY ?? "").trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ filter: { $or: [{ email_addresses: { email_domain: { $eq: "sample-research.example" } } }] }, limit: 50 }),
        });
        out.attio_people_by_domain = r.ok ? `ok (${((await r.json()) as { data: unknown[] }).data.length} SampleCo people)` : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.attio_people_by_domain = `error: ${e instanceof Error ? e.message : e}`; }
      out.google_client = shape(env.GOOGLE_CLIENT_ID);
      out.microsoft_client = shape(env.MS_CLIENT_ID);
      out.slack_token_shape = shape(env.SLACK_BOT_TOKEN);
      try {
        const r = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${(env.SLACK_BOT_TOKEN ?? "").trim()}` } });
        const d = (await r.json()) as { ok: boolean; user?: string; team?: string; error?: string };
        out.slack = d.ok ? `ok (bot "${d.user}" in ${d.team}); channel ${env.SLACK_CHANNEL_ID ? "set" : "not set"}; scopes: ${r.headers.get("x-oauth-scopes") ?? "?"}` : `error: ${d.error}`;
        // Read-only: can the bot see the deploy channels? (doesn't join or read messages)
        const l = (await (await fetch("https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=1000", {
          headers: { Authorization: `Bearer ${(env.SLACK_BOT_TOKEN ?? "").trim()}` } })).json()) as { ok: boolean; error?: string; channels?: { name: string; is_member?: boolean }[] };
        const dep = (l.channels ?? []).filter((c) => /-deploy$/.test(c.name));
        out.slack_deploy_channels = l.ok ? `${dep.length} found, bot already in ${dep.filter((c) => c.is_member).length}` : `error: ${l.error}`;
      } catch (e) { out.slack = `error: ${e instanceof Error ? e.message : e}`; }
      out.pylon_token_shape = shape(env.PYLON_API_TOKEN);
      try {
        const r = await fetch("https://api.usepylon.com/me", { headers: { Authorization: `Bearer ${(env.PYLON_API_TOKEN ?? "").trim()}` } });
        out.pylon = r.ok ? "ok" : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.pylon = `error: ${e instanceof Error ? e.message : e}`; }
      return json(out);
    }

    if (url.pathname === "/run" && url.searchParams.get("now") === "1") {
      // Runs inside this request and returns the result (for testing; the browser waits).
      const read = url.searchParams.get("read");
      return json(await tick(env, {
        manual: true,
        forceIngest: url.searchParams.get("ingest") !== "0",
        forceReport: url.searchParams.get("report") === "1",
        readLimit: read ? Number(read) : undefined,
        only: url.searchParams.get("only") ?? undefined, // e.g. only=teams
      }));
    }

    if (url.pathname === "/pause" || url.pathname === "/resume") {
      const control = (await db.getState<Record<string, unknown>>("control")) ?? {};
      await db.setState("control", { ...control, paused: url.pathname === "/pause" });
      return json({ automatic_runs: url.pathname === "/pause" ? "paused" : "running" });
    }

    if (url.pathname === "/run") {
      // A request-triggered Worker only gets ~30s of background time after it responds, which a
      // real run would exceed. So the link queues the run; the next 15-minute tick (which has
      // the full time budget) picks it up.
      await db.setState("run_request", {
        forceIngest: true,
        forceReport: url.searchParams.get("report") === "1",
        at: new Date().toISOString(),
      });
      return html(`<h2>Run queued</h2><p>It starts within 15 minutes and works in the background. Progress: <a href="/status?token=${t}">status</a>.</p>`);
    }

    if (url.pathname === "/connect/bluedot") {
      return Response.redirect(await startBluedotConnect(db), 302);
    }

    return new Response("not found", { status: 404 });
  },
};

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function connectPage(db: Db, k: string, me: string | null): Promise<string> {
  const kq = encodeURIComponent(k);
  const mine = me ? (await listConnections(db)).filter((c) => c.email === me) : [];
  const row = (provider: Provider, label: string) => {
    const c = mine.find((x) => x.provider === provider);
    const status = !me ? "" : c
      ? `<p>${c.last_error ? `<b style="color:#b00">Your connection needs reconnecting.</b>` : "✅ Connected"} as ${escHtml(c.email)} · <a href="/connect/disconnect?k=${kq}&provider=${provider}" onclick="return confirm('Disconnect your ${provider === "google" ? "Google" : "Microsoft"} account?')">Disconnect</a></p>`
      : "<p>Not connected.</p>";
    return `<h3>${label}</h3>${status}<p><a href="/connect/${provider}?k=${kq}" style="display:inline-block;padding:10px 16px;background:#1a73e8;color:#fff;border-radius:6px;text-decoration:none">${c ? "Reconnect" : "Connect"} ${provider === "google" ? "Google" : "Microsoft"}</a></p>`;
  };
  return `<h2>Connect your accounts</h2>
<p>This lets the Customer Knowledge Bank include your <b>customer</b> conversations in each customer's weekly summary and Account Brief.</p>
<ul>
<li><b>Read-only.</b> It can never send, delete or change anything.</li>
<li><b>Customer conversations only.</b> It checks who a chat is with and skips anything without a customer in it. Internal and personal chats are never opened or stored. <b>Your email is not read.</b></li>
<li><b>Only you.</b> It reads only your own account. This page shows only your own connections, and you can disconnect here any time.</li>
</ul>
${me ? `<p>Signed in as <b>${escHtml(me)}</b>.</p>` : `<p><i>Connect one account below to see your status here.</i></p>`}
${row("google", "Google: Google Chat")}
${row("microsoft", "Microsoft: Teams chats")}
<p style="color:#666;font-size:.9em">Sign in with your @example.com account.</p>`;
}

/** A cron tick, plus any "run now" request queued from the /run link. */
async function tickWithRequests(env: Env) {
  const db = new Db(env);
  const req = await db.getState<{ forceIngest?: boolean; forceReport?: boolean; at?: string } | null>("run_request");
  if (req?.at) await db.setState("run_request", {});
  return tick(env, { forceIngest: Boolean(req?.forceIngest), forceReport: Boolean(req?.forceReport) });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });
}
function html(body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">${body}</body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
