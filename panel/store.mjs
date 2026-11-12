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

  // ---- panel password and sessions -------------------------------------------------------------------

  hasPassword() {
    return typeof this.data.panel?.passwordHash === "string";
  }

  setPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, SCRYPT);
    this.update((d) => {
      d.panel = { ...(d.panel ?? {}), passwordHash: `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`, sessions: [] };
    });
  }

  checkPassword(password) {
    const stored = this.data.panel?.passwordHash;
    if (typeof stored !== "string" || typeof password !== "string") return false;
    const [, salt, hash] = stored.split("$");
    const want = Buffer.from(hash, "base64");
    const got = scryptSync(password, Buffer.from(salt, "base64"), want.length, SCRYPT);
    return timingSafeEqual(want, got);
  }

  /** A new browser session; only its hash is stored. */
  newSession() {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.update((d) => {
      const live = (d.panel?.sessions ?? []).filter((s) => s.exp > now).slice(-19);
      d.panel = { ...(d.panel ?? {}), sessions: [...live, { hash: sha256(token), exp: now + SESSION_DAYS * 86400_000 }] };
    });
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  validSession(token) {
    if (!token) return false;
    const h = sha256(token);
    const now = Date.now();
    return (this.data.panel?.sessions ?? []).some((s) => s.exp > now && safeEqual(s.hash, h));
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
