// Touchless secure sign-in for the bridge panel (#960): the standard MCP OAuth flow the relay offers
// (docs/SECURE_CONNECTION.md). The owner pastes the phone's secure address, the panel registers itself, opens the
// relay's sign-in page, the owner approves on the phone, and the panel keeps the rotating tokens.

import { createHash, randomBytes } from "node:crypto";

const TIMEOUT_MS = 20_000;

/** The phone's secure address, checked. A classic link (…?token=) carries the device token: refused. */
export function checkMcpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("That isn't a web address. Paste the secure address from Touchless → Settings → AI connection.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("The address must start with https://.");
  if (u.username || u.password || u.searchParams.has("token")) {
    throw new Error("That's the classic link with the phone's token in it. Use the secure address (…/mcp/…) instead.");
  }
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** Where to sign in for [mcpUrl]: the protected-resource metadata names the server, its metadata the endpoints. */
export async function discover(mcpUrl) {
  const u = new URL(mcpUrl);
  let server = u.origin;
  try {
    const r = await get(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.authorization_servers) && typeof j.authorization_servers[0] === "string") {
        server = j.authorization_servers[0].replace(/\/$/, "");
      }
    }
  } catch { /* fall back to the address's own origin */ }
  let r;
  try {
    r = await get(`${server}/.well-known/oauth-authorization-server`);
  } catch (e) {
    throw new Error(`Can't reach ${new URL(server).host}: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (!r.ok) throw new Error(`${new URL(server).host} doesn't offer Touchless sign-in (HTTP ${r.status}).`);
  const m = await r.json();
  if (!m.authorization_endpoint || !m.token_endpoint || !m.registration_endpoint) {
    throw new Error(`${new URL(server).host} doesn't offer Touchless sign-in.`);
  }
  return {
    authorize: m.authorization_endpoint,
    token: m.token_endpoint,
    register: m.registration_endpoint,
    revoke: m.revocation_endpoint ?? `${server}/oauth/revoke`,
  };
}

/** Dynamic client registration: the phone's approval screen shows [name] and the redirect's host. */
export async function register(meta, name, redirectUri) {
  const r = await fetch(meta.register, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.client_id) throw new Error(`Registration failed: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`);
  return j.client_id;
}

/** The sign-in page address, with PKCE; [pending] is what the callback needs to finish. */
export function authorizeUrl(meta, { clientId, redirectUri, resource }) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(18).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "full",
    resource,
  });
  return { url: `${meta.authorize}?${q}`, pending: { state, verifier, clientId, redirectUri, resource, meta } };
}

export async function exchange(pending, code) {
  return tokenRequest(pending.meta.token, {
    grant_type: "authorization_code",
    code,
    code_verifier: pending.verifier,
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
  });
}

export async function refresh(tokenEndpoint, clientId, refreshToken) {
  return tokenRequest(tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
}

export async function revoke(endpoint, token) {
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { /* the phone can always remove the connection itself */ }
}

class TokenError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function tokenRequest(endpoint, form) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new TokenError(j.error_description ?? j.error ?? `HTTP ${r.status}`, j.error ?? `http_${r.status}`);
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? form.refresh_token ?? "",
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
    scope: typeof j.scope === "string" ? j.scope : "",
  };
}

function get(url) {
  return fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}
