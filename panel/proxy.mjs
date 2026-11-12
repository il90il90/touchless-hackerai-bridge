// The bridge's MCP proxy (#960): the agent's `touchless` CLI talks to http://127.0.0.1:<port>/mcp inside the
// container with no key; this adds the Touchless credential the panel keeps (refreshing the rotating sign-in tokens),
// forwards to the phone's address, and records what was called for the panel's Activity view.

import * as oauth from "./oauth.mjs";

const MAX_BODY = 4 * 1024 * 1024;
const ACTIVITY = 300;
const CALL_TIMEOUT_MS = 10 * 60_000;
/** Refresh a sign-in token this long before it expires (a test sets it above the token's lifetime). */
const REFRESH_MARGIN_MS = Number(process.env.BRIDGE_REFRESH_MARGIN_MS || 60_000);

export class Touchless {
  constructor(store) {
    this.store = store;
    this.refreshing = null;
    this.activity = [];
    this.seq = 0;
  }

  /** Calls kept from before a restart (the panel saves them). */
  restore(calls) {
    if (!Array.isArray(calls)) return;
    this.activity = calls.slice(-ACTIVITY);
    this.seq = this.activity.reduce((m, a) => Math.max(m, Number(a.seq) || 0), 0);
  }

  configured() {
    const t = this.store.touchless;
    return !!(t.url && t.auth && (t.auth.kind === "key" ? t.auth.key : t.auth.refreshToken || t.auth.accessToken));
  }

  /** The Authorization value for the next request, refreshing a sign-in token that is about to expire. */
  async bearer(force = false) {
    const auth = this.store.touchless.auth;
    if (!auth) return "";
    if (auth.kind === "key") return auth.key;
    if (!force && auth.accessToken && auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken;
    if (!auth.refreshToken) return auth.accessToken ?? "";
    // One refresh at a time: the refresh token rotates, so two at once would spend it twice.
    this.refreshing ??= (async () => {
      try {
        const cur = this.store.touchless.auth;
        const t = await oauth.refresh(cur.tokenEndpoint, cur.clientId, cur.refreshToken);
        this.store.update((d) => {
          Object.assign(d.touchless.auth, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt,
            scope: t.scope || d.touchless.auth.scope, problem: "" });
        });
        return t.accessToken;
      } catch (e) {
        if (e.code === "invalid_grant") {
          // Revoked on the phone or expired: the owner has to approve again.
          this.store.update((d) => { d.touchless.auth.problem = "The phone no longer accepts this connection. Connect again."; });
        }
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Forward one MCP POST body; returns { status, headers, body }. */
  async forward(body, sessionId) {
    const url = this.store.touchless.url;
    const send = async (token) => {
      const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      return fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    };
    let res = await send(await this.bearer());
    if (res.status === 401 && this.store.touchless.auth?.kind === "oauth") {
      res = await send(await this.bearer(true));
    }
    const text = await res.text();
    const out = { "Content-Type": res.headers.get("content-type") ?? "application/json" };
    const sid = res.headers.get("mcp-session-id");
    if (sid) out["Mcp-Session-Id"] = sid;
    return { status: res.status, headers: out, body: text };
  }

  /** One JSON-RPC request from the panel itself (connection test). */
  async rpc(method, params, sessionId) {
    const r = await this.forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }), sessionId);
    let j = null;
    try { j = JSON.parse(r.body); } catch { /* below */ }
    if (r.status >= 400 || !j) throw new Error(httpProblem(r.status, j));
    if (j.error) throw new Error(j.error.message ?? "Touchless returned an error");
    return { result: j.result, sessionId: r.headers["Mcp-Session-Id"] ?? "" };
  }

  /** The phone's model, to show it's really connected. Also names this AI on the phone. */
  async test(clientName) {
    const init = await this.rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "bridge-panel" },
    });
    const call = await this.rpc("tools/call", {
      name: "get_device_info", arguments: { agent_name: `${clientName} (bridge panel)` },
    }, init.sessionId);
    const text = (call.result?.content ?? []).find((c) => c.type === "text")?.text ?? "{}";
    if (call.result?.isError) throw new Error(text);
    let info = {};
    try { info = JSON.parse(text); } catch { /* keep empty */ }
    return {
      model: [info.manufacturer, info.model].filter(Boolean).join(" "),
      android: info.android_release ?? "",
      battery: info.battery_percent ?? null,
      server: init.result?.serverInfo?.version ?? "",
    };
  }

  /** The HTTP handler for the agent side (bound to the container's loopback only). */
  handler() {
    return async (req, res) => {
      if (req.method !== "POST" || !new URL(req.url, "http://x").pathname.startsWith("/mcp")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Only POST /mcp" }));
        return;
      }
      let body;
      try {
        body = await readRaw(req, MAX_BODY);
      } catch {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      if (!this.configured()) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "The phone isn't connected to the bridge yet. Connect it in the bridge panel." }));
        return;
      }
      const started = Date.now();
      const entry = this.#describe(body);
      try {
        const r = await this.forward(body, String(req.headers["mcp-session-id"] ?? ""));
        this.#record(entry, started, r);
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      } catch (e) {
        this.#record(entry, started, null, e);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `The bridge couldn't reach Touchless: ${e?.message ?? e}` }));
      }
    };
  }

  #describe(body) {
    try {
      const j = JSON.parse(body);
      const m = Array.isArray(j) ? j[0] : j;
      const p = m?.params ?? {};
      // The full arguments (the panel shows them as a JSON panel on click); narration is stripped by the relay anyway.
      const args = m?.method === "tools/call" && p.arguments && typeof p.arguments === "object" ? p.arguments : {};
      return { method: String(m?.method ?? ""), tool: m?.method === "tools/call" ? String(p.name ?? "") : "", args };
    } catch {
      return { method: "?", tool: "", args: {} };
    }
  }

  #record(entry, started, r, err) {
    // Only what someone looks at: tool calls and failures, not the CLI's hellos and list loads.
    let ok = !err && r && r.status < 400;
    let note = err ? String(err.message ?? err) : r && r.status >= 400 ? `HTTP ${r.status}` : "";
    let result; // the tool's own output, for the JSON panel (images dropped; never the base64)
    if (r && ok) {
      try {
        const j = JSON.parse(r.body);
        if (j.error) { ok = false; note = j.error.message ?? "error"; }
        else if (j.result?.isError) {
          ok = false;
          note = short((j.result.content ?? []).find((c) => c.type === "text")?.text ?? "tool error");
        }
        result = resultOf(j.result);
      } catch { /* an event stream: keep ok */ }
    }
    if (entry.method !== "tools/call" && ok) return;
    this.activity.push({
      seq: ++this.seq, t: started, ms: Date.now() - started,
      method: entry.method, tool: entry.tool, args: capObject(entry.args), ok, note, result,
    });
    if (this.activity.length > ACTIVITY) this.activity.splice(0, this.activity.length - ACTIVITY);
  }
}

/** A tool result turned into something small and safe to keep: text as text, an image as a note, never base64. */
function resultOf(result) {
  if (result == null) return undefined;
  const content = Array.isArray(result.content) ? result.content : null;
  if (content) {
    const parts = content.map((c) => {
      if (c?.type === "text") { try { return JSON.parse(c.text); } catch { return c.text; } }
      if (c?.type === "image") return `[image ${c.mimeType ?? ""}]`;
      return c;
    });
    return capObject(parts.length === 1 ? parts[0] : parts);
  }
  return capObject(result.structuredContent ?? result);
}

/** Keep a value only if it serializes small; otherwise a short preview, so one record can't bloat memory. */
function capObject(value, max = 8000) {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return undefined;
    return s.length <= max ? value : { _truncated: `${s.slice(0, max)}…` };
  } catch {
    return { _unserializable: String(value).slice(0, 200) };
  }
}

function httpProblem(status, j) {
  const detail = j?.error?.message ?? j?.error ?? "";
  if (status === 401) return "Touchless refused the bridge's credential. Connect again.";
  if (status === 409) return "No phone is connected to Touchless. Open Touchless on the phone.";
  return `Touchless answered HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

function short(s, max = 300) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
