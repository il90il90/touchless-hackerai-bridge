// The bridge panel's settings (#960): one JSON file in a directory only the panel's user can read. Secrets (the
// HackerAI token, Touchless tokens or key, the panel password hash) live only here and are never sent back to the
// browser or to the agent.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "bridge.json");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* not ours to change (tests) */ }
    this.data = load(this.file);
  }

  /** Change the settings with [fn] and save them atomically. */
  update(fn) {
    const next = structuredClone(this.data);
    fn(next);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.data = next;
  }

  get hackerai() { return this.data.hackerai ?? {}; }
  get touchless() { return this.data.touchless ?? {}; }

  // ---- panel account (username + password) and sessions ----------------------------------------------

  hasPassword() {
    return typeof this.data.panel?.passwordHash === "string";
  }

  /** The login username, or "" when the account is password-only (legacy, or set that way). */
  username() {
    return typeof this.data.panel?.username === "string" ? this.data.panel.username : "";
  }

  /** Set (or change) the account. Keeps existing sessions unless keepSessions is false. */
  setAccount(username, password, keepSessions = false) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, SCRYPT);
    this.update((d) => {
      d.panel = {
        ...(d.panel ?? {}),
        username: String(username ?? "").trim().slice(0, 60),
        passwordHash: `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`,
        sessions: keepSessions ? (d.panel?.sessions ?? []) : [],
      };
    });
  }

  checkPassword(password) {
    const stored = this.data.panel?.passwordHash;
    if (typeof stored !== "string" || typeof password !== "string") return false;
    const [, salt, hash] = stored.split("$");
    const want = Buffer.from(hash, "base64");
    let got;
    try { got = scryptSync(password, Buffer.from(salt, "base64"), want.length, SCRYPT); } catch { return false; }
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** The login check: password always, and the username too when one is set (case-insensitive). */
  checkLogin(username, password) {
    const want = this.username();
    if (want && String(username ?? "").trim().toLowerCase() !== want.toLowerCase()) return false;
    return this.checkPassword(password);
  }

  /** A new browser session; only its hash is stored. `at` is the last-active time, for the idle lock. */
  newSession() {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.update((d) => {
      const live = (d.panel?.sessions ?? []).filter((s) => s.exp > now).slice(-19);
      d.panel = { ...(d.panel ?? {}), sessions: [...live, { hash: sha256(token), exp: now + SESSION_DAYS * 86400_000, at: now }] };
    });
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  #session(token) {
    if (!token) return null;
    const h = sha256(token);
    const now = Date.now();
    return (this.data.panel?.sessions ?? []).find((s) => s.exp > now && safeEqual(s.hash, h)) ?? null;
  }

  validSession(token) {
    return this.#session(token) !== null;
  }

  /** True when the session is valid but idle past [lockMs]. A session from before this feature (no `at`) counts as
   *  active until its next request sets one, so upgrading the bridge doesn't lock everyone out at once. */
  sessionLocked(token, lockMs) {
    const s = this.#session(token);
    if (!s || !s.at) return false;
    return Date.now() - Number(s.at) > lockMs;
  }

  /** Mark a session active now (resets the idle timer); used on each authed request and on unlock. */
  touchSession(token) {
    if (!token) return;
    const h = sha256(token);
    this.update((d) => {
      const s = (d.panel?.sessions ?? []).find((x) => x.hash === h);
      if (s) s.at = Date.now();
    });
  }

  endSession(token) {
    if (!token) return;
    const h = sha256(token);
    this.update((d) => {
      if (d.panel?.sessions) d.panel.sessions = d.panel.sessions.filter((s) => s.hash !== h);
    });
  }
}

function load(file) {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

export function sha256(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
