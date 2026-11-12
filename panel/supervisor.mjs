// Runs HackerAI's Remote Control client (@hackerai/local) for the bridge panel (#960): start, stop, restart after its
// one-hour idle exit, back off after failures, and keep its output (token removed) for the panel's log.

import { spawn } from "node:child_process";

const LOG_LINES = 600;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class Supervisor {
  /**
   * @param {object} o
   * @param {string} o.command  the client's executable (hackerai-local)
   * @param {string[]} [o.preArgs]  arguments before --token (a script for node, in tests)
   * @param {() => object} o.env  the environment for the client (no panel secrets)
   * @param {string} o.cwd
   * @param {number} [o.uid]  run the client as this user (the panel itself runs as root in the container)
   * @param {number} [o.gid]
   */
  constructor(o) {
    this.o = o;
    this.child = null;
    this.state = "stopped";
    this.detail = "";
    this.lines = [];
    this.seq = 0;
    this.failures = 0;
    this.wanted = false;
    this.timer = null;
    this.startedAt = 0;
    this.token = "";
  }

  status() {
    return { state: this.state, detail: this.detail, pid: this.child?.pid ?? null, since: this.startedAt || null,
      computer: this.computer ?? "" };
  }

  /** Lines kept from before a restart (the panel saves them), so the log survives it. */
  restore(lines) {
    if (!Array.isArray(lines)) return;
    this.lines = lines.slice(-LOG_LINES);
    this.seq = this.lines.reduce((m, l) => Math.max(m, Number(l.seq) || 0), 0);
  }

  /** Log lines after sequence number [after]. */
  log(after = 0) {
    return this.lines.filter((l) => l.seq > after);
  }

  start(token, name) {
    this.token = String(token ?? "");
    this.name = String(name ?? "");
    this.wanted = true;
    this.failures = 0;
    clearTimeout(this.timer);
    if (this.child) {
      this.restartAfterExit = true;
      this.#kill();
      return;
    }
    this.#spawn();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.child) {
      this.#kill();
    } else {
      this.#set("stopped", "");
    }
  }

  #spawn() {
    this.tokenRejected = false;
    this.#set("starting", "");
    this.startedAt = Date.now();
    const opts = { cwd: this.o.cwd, env: this.o.env(), stdio: ["ignore", "pipe", "pipe"], detached: true };
    if (Number.isInteger(this.o.uid)) opts.uid = this.o.uid;
    if (Number.isInteger(this.o.gid)) opts.gid = this.o.gid;
    let child;
    try {
      child = spawn(this.o.command, [...(this.o.preArgs ?? []), "--token", this.token, "--name", this.name], opts);
    } catch (e) {
      this.#line(`Could not start the HackerAI client: ${e.message}`, "err");
      this.#set("error", e.message);
      return;
    }
    this.child = child;
    const reader = (stream, kind) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          this.#onLine(buf.slice(0, i), kind);
          buf = buf.slice(i + 1);
        }
        if (buf.length > 8192) { this.#onLine(buf, kind); buf = ""; }
      });
      stream.on("end", () => { if (buf) this.#onLine(buf, kind); });
    };
    reader(child.stdout, "out");
    reader(child.stderr, "err");
    child.on("error", (e) => {
      this.#line(`The HackerAI client failed: ${e.message}`, "err");
    });
    child.on("exit", (code, signal) => this.#onExit(code, signal));
  }

  #onLine(raw, kind) {
    const text = this.#redact(raw.replace(ANSI, "").replace(/\r/g, "")).trimEnd();
    if (!text.trim()) return;
    this.#line(text, kind);
    if (/✓ Authenticated/.test(text)) this.#set("authenticating", "");
    else if (/Connected to command relay/.test(text)) { this.#set("connected", ""); this.failures = 0; }
    else if (/select this computer: (.+)$/.test(text)) this.computer = /select this computer: (.+)$/.exec(text)[1].trim();
    else if (/Token rejected|regenerate your token/i.test(text)) this.tokenRejected = true;
    else if (/Connection limit reached/i.test(text)) this.#set("error", "HackerAI has too many connections right now.");
    else if (/Disconnected from/i.test(text) && this.state === "connected") this.#set("reconnecting", "");
  }

  #onExit(code, signal) {
    const ranMs = Date.now() - this.startedAt;
    this.child = null;
    this.#line(`The HackerAI client exited (${signal ?? `code ${code}`}).`, code === 0 ? "out" : "err");
    if (this.restartAfterExit) {
      this.restartAfterExit = false;
      if (this.wanted) { this.#spawn(); return; }
    }
    if (!this.wanted) { this.#set("stopped", ""); return; }
    if (this.tokenRejected) {
      this.wanted = false;
      this.#set("token_rejected", "HackerAI refused the token. Copy a new command in HackerAI → Settings → Remote Control.");
      return;
    }
    // code 0 is its idle exit after an hour without commands: come back at once. A failure backs off.
    if (code !== 0) this.failures = ranMs > 60_000 ? 1 : this.failures + 1;
    const wait = code === 0 ? 2000 : Math.min(60_000, 5000 * 2 ** Math.max(0, this.failures - 1));
    this.#set("restarting", code === 0 ? "" : `Retrying in ${Math.round(wait / 1000)} s`);
    this.timer = setTimeout(() => { if (this.wanted && !this.child) this.#spawn(); }, wait);
  }

  #kill() {
    const pid = this.child?.pid;
    if (!pid) return;
    this.#set("stopping", "");
    // The client runs in its own process group; end the commands it started with it.
    const signal = (sig) => {
      try { process.kill(-pid, sig); } catch { try { this.child?.kill(sig); } catch { /* gone */ } }
    };
    signal("SIGTERM");
    setTimeout(() => { if (this.child?.pid === pid) signal("SIGKILL"); }, 5000).unref();
  }

  #set(state, detail) {
    this.state = state;
    this.detail = detail;
  }

  #line(text, kind) {
    this.lines.push({ seq: ++this.seq, t: Date.now(), kind, text: text.slice(0, 2000) });
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
  }

  #redact(text) {
    return this.token && this.token.length >= 8 ? text.split(this.token).join("[token]") : text;
  }
}

/** The token from what the owner pastes: the whole copied command or the token alone. */
export function parseHackerAiToken(input) {
  const s = String(input ?? "").trim();
  const flag = /--token(?:=|\s+)["']?([A-Za-z0-9_.-]{8,})/.exec(s);
  if (flag) return flag[1];
  if (/^[A-Za-z0-9_.-]{8,}$/.test(s)) return s;
  return "";
}
