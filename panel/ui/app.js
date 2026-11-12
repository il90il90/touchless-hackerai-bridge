// Touchless bridge panel (#960): talks only to its own server (/api/…). No secrets are ever returned to this page.
"use strict";

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let current = null;       // last /api/state
let sessionInfo = { lockMinutes: 10, username: "" };
let waitingSignIn = false;
let logAfter = 0;
let activityAfter = 0;
const activityRows = [];

async function api(path, body) {
  const opts = body === undefined
    ? { headers: { Accept: "application/json" } }
    : { method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Request": "1" }, body: JSON.stringify(body) };
  const r = await fetch(path, { credentials: "same-origin", cache: "no-store", ...opts });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { showAuth(true, false); throw new Error(j.error || "Log in first."); }
  if (r.status === 423 && path !== "/api/unlock") { showLock(); throw new Error(j.error || "Locked."); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function msg(el, text, good) {
  el.textContent = text;
  el.className = `msg ${good ? "good" : "bad"}`;
  el.hidden = !text;
}

// ---- account (username + password) and lock ------------------------------------------------------------------

function showAuth(passwordSet, hasUsername) {
  $("lock").hidden = true;
  $("app").hidden = true;
  $("auth").hidden = false;
  $("auth-text").textContent = passwordSet
    ? "Log in to the bridge."
    : "First visit: choose a username and password for the bridge. HackerAI runs commands next to it, so it stays behind a login.";
  $("auth-button").textContent = passwordSet ? "Log in" : "Create account";
  $("auth-password").autocomplete = passwordSet ? "current-password" : "new-password";
  $("auth-password").minLength = passwordSet ? 1 : 8;
  // On setup, always offer a username; on login, show it only when the account has one.
  $("auth-username-row").hidden = passwordSet && !hasUsername;
  $("auth-form").dataset.mode = passwordSet ? "login" : "setup";
  ($("auth-username-row").hidden ? $("auth-password") : $("auth-username")).focus();
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = $("auth-form").dataset.mode;
  try {
    await api(mode === "login" ? "/api/login" : "/api/setup", { username: $("auth-username").value, password: $("auth-password").value });
    $("auth-password").value = "";
    $("auth-error").hidden = true;
    start();
  } catch (err) {
    $("auth-error").textContent = err.message;
    $("auth-error").hidden = false;
  }
});

function showLock() {
  $("app").hidden = true;
  $("auth").hidden = true;
  $("lock").hidden = false;
  $("lock-password").value = "";
  $("lock-error").hidden = true;
  $("lock-password").focus();
}

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/unlock", { password: $("lock-password").value });
    $("lock").hidden = true;
    $("lock-password").value = "";
    start();
  } catch (err) {
    $("lock-error").textContent = err.message;
    $("lock-error").hidden = false;
  }
});
$("lock-logout").addEventListener("click", async () => { await api("/api/logout", {}).catch(() => {}); location.reload(); });

$("logout").addEventListener("click", async () => {
  await api("/api/logout", {}).catch(() => {});
  location.reload();
});

$("account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/account", { username: $("acc-username").value, current: $("acc-current").value, password: $("acc-new").value });
    $("acc-current").value = ""; $("acc-new").value = "";
    msg($("account-msg"), `Saved${r.username ? ` — username "${r.username}"` : ""}.`, true);
  } catch (err) {
    msg($("account-msg"), err.message, false);
  }
});

async function loadNetInfo() {
  try {
    const n = await api("/api/netinfo");
    for (const el of document.querySelectorAll(".net-port")) el.textContent = String(n.port);
    $("net-current").textContent = n.currentUrl ? `You're on ${n.currentUrl}` : "";
    $("net-lan-on").hidden = !n.lanEnabled;
    $("net-lan-off").hidden = n.lanEnabled;
    const m = String(sessionInfo.lockMinutes ?? 10);
    for (const el of document.querySelectorAll("#net-lock, .net-lock")) el.textContent = m;
    if (document.activeElement !== $("acc-username") && !$("acc-username").value && sessionInfo.username) $("acc-username").value = sessionInfo.username;
  } catch { /* shown elsewhere */ }
}

// ---- tabs ----------------------------------------------------------------------------------------------------

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const b of document.querySelectorAll(".tab-body")) b.hidden = b.id !== `tab-${tab.dataset.tab}`;
    if (tab.dataset.tab === "console") { $("console-input").focus(); loadTools(); }
  });
}

// ---- state ---------------------------------------------------------------------------------------------------

const HACKERAI_STATES = {
  stopped: ["Stopped", ""],
  starting: ["Starting…", "warn"],
  authenticating: ["Signing in…", "warn"],
  connected: ["Connected", "ok"],
  reconnecting: ["Reconnecting…", "warn"],
  restarting: ["Restarting…", "warn"],
  stopping: ["Stopping…", "warn"],
  token_rejected: ["Token refused", "bad"],
  error: ["Problem", "bad"],
};

let loadedVersion = "";

function render(s) {
  // The panel was updated while this page was open: load the new page instead of mixing the two.
  if (loadedVersion && s.panelVersion && s.panelVersion !== loadedVersion) { location.reload(); return; }
  loadedVersion ||= s.panelVersion || "";
  current = s;
  const p = s.phone;
  const h = s.hackerai;

  // Phone
  const chipPhone = $("chip-phone");
  if (p.connected && !p.problem) {
    chipPhone.textContent = `Phone: ${p.device?.model || "connected"}`;
    chipPhone.className = "chip ok";
  } else {
    chipPhone.textContent = p.problem ? "Phone: connect again" : "Phone: not connected";
    chipPhone.className = `chip ${p.problem ? "bad" : ""}`;
  }
  $("phone-off").hidden = p.connected;
  $("phone-on").hidden = !p.connected;
  $("step-phone").classList.toggle("done", p.connected && !p.problem);
  if (p.connected) {
    waitingSignIn = false;
    $("phone-waiting").hidden = true;
    const d = p.device;
    const how = p.kind === "key" ? "API key" : scopeLabel(p.scope);
    $("phone-summary").textContent = `✓ Connected${d?.model ? ` to ${d.model}` : ""}${d?.android ? ` · Android ${d.android}` : ""} · ${how}`;
    $("phone-problem").textContent = p.problem;
    $("phone-problem").hidden = !p.problem;
    if (document.activeElement !== $("client-name")) $("client-name").value = p.clientName;
  } else if (!$("phone-url").value && p.url) {
    $("phone-url").value = p.url;
  }

  // HackerAI
  const [label, tone] = HACKERAI_STATES[h.state] ?? [h.state, ""];
  $("chip-hackerai").textContent = `HackerAI: ${h.tokenSet ? label : "not set up"}`;
  $("chip-hackerai").className = `chip ${h.tokenSet ? tone : ""}`;
  $("step-hackerai").classList.toggle("done", h.state === "connected");
  $("hackerai-status").textContent = h.tokenSet
    ? `${label}${h.detail ? ` — ${h.detail}` : ""}${h.state === "connected" ? `. In HackerAI, select the computer "${h.computer || h.name}".` : ""}`
    : "Not set up yet.";
  $("hackerai-save").textContent = h.tokenSet ? "Save and restart" : "Save and start";
  $("hackerai-command").placeholder = h.tokenSet ? "Token saved. Paste a new command only to replace it." : "npx @hackerai/local@latest --token …";
  $("hackerai-start").hidden = !h.tokenSet || ["connected", "starting", "authenticating", "restarting", "reconnecting"].includes(h.state);
  $("hackerai-stop").hidden = !h.tokenSet || ["stopped", "token_rejected"].includes(h.state);
  if (document.activeElement !== $("hackerai-name") && !$("hackerai-name").value) $("hackerai-name").value = h.name;

  // Instructions for HackerAI: the saved (or default) text, unless the owner is editing it right now
  $("instr-limit").textContent = String(s.instructions.limit);
  for (const box of document.querySelectorAll(".instr")) {
    const f = s.instructions[box.dataset.field];
    const area = box.querySelector("textarea");
    if (!box.dataset.dirty && document.activeElement !== area && area.value !== f.text) area.value = f.text;
    box.dataset.custom = f.custom ? "1" : "";
    updateInstr(box);
  }
  $("step-tell").classList.toggle("done", p.connected && h.state === "connected");
}

/** Counter, and Save / Reset shown only when they do something. */
function updateInstr(box) {
  const area = box.querySelector("textarea");
  const limit = current?.instructions.limit ?? 1500;
  const n = area.value.trim().length;
  const counter = box.querySelector(".counter");
  counter.textContent = `${n} / ${limit}`;
  counter.classList.toggle("over", n > limit);
  box.querySelector(".instr-save").hidden = !box.dataset.dirty;
  box.querySelector(".instr-reset").hidden = !box.dataset.custom && !box.dataset.dirty;
}

function scopeLabel(scope) {
  if (scope === "read") return "Read only";
  if (scope === "full" || scope === "standard") return "Full control";
  return "Signed in";
}

async function refresh() {
  try { render(await api("/api/state")); } catch { /* shown by api() on 401 */ }
}

// ---- phone ---------------------------------------------------------------------------------------------------

$("phone-connect").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  msg($("phone-msg"), "", true);
  // Open the tab now, inside the click, so the browser doesn't block it; point it at the sign-in page next.
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const { authorizeUrl } = await api("/api/touchless/connect", { url: $("phone-url").value });
    if (tab) tab.location.href = authorizeUrl;
    $("phone-signin-link").href = authorizeUrl;
    $("phone-waiting").hidden = false;
    waitingSignIn = true;
  } catch (err) {
    if (tab) tab.close();
    msg($("phone-msg"), err.message, false);
  } finally {
    button.disabled = false;
  }
});

$("phone-key").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/touchless/key", { url: $("key-url").value, key: $("key-value").value });
    $("key-value").value = "";
    render(r);
    msg($("phone-msg"), r.test?.ok ? "Key saved and the phone answered." : `Key saved, but: ${r.test?.error}`, !!r.test?.ok);
  } catch (err) {
    msg($("phone-msg"), err.message, false);
  }
});

$("phone-test").addEventListener("click", async () => {
  msg($("phone-msg"), "Asking the phone…", true);
  try {
    const { test } = await api("/api/touchless/test", {});
    msg($("phone-msg"), test.ok
      ? `The phone answered: ${test.device.model}${test.device.battery != null ? `, battery ${test.device.battery}%` : ""}.`
      : test.error, test.ok);
    refresh();
  } catch (err) {
    msg($("phone-msg"), err.message, false);
  }
});

$("phone-reconnect").addEventListener("click", () => {
  $("phone-off").hidden = false;
  $("phone-on").hidden = true;
  $("phone-url").value = current?.phone.url ?? "";
  $("phone-url").focus();
});

$("phone-disconnect").addEventListener("click", async () => {
  if (!confirm("Disconnect the phone? HackerAI can't reach it until you connect again.")) return;
  try {
    render(await api("/api/touchless/disconnect", {}));
    msg($("phone-msg"), "Disconnected. The connection was also removed on the phone's side.", true);
  } catch (err) {
    msg($("phone-msg"), err.message, false);
  }
});

$("phone-name").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    render(await api("/api/touchless/name", { name: $("client-name").value }));
    msg($("phone-msg"), "Saved. HackerAI uses the new name from its next connection.", true);
  } catch (err) {
    msg($("phone-msg"), err.message, false);
  }
});

// ---- HackerAI ------------------------------------------------------------------------------------------------

$("hackerai-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/hackerai", { command: $("hackerai-command").value, name: $("hackerai-name").value });
    $("hackerai-command").value = "";
    render(r);
    msg($("hackerai-msg"), "Saved. Starting the HackerAI client…", true);
  } catch (err) {
    msg($("hackerai-msg"), err.message, false);
  }
});

for (const [id, path] of [["hackerai-start", "/api/hackerai/start"], ["hackerai-stop", "/api/hackerai/stop"]]) {
  $(id).addEventListener("click", async () => {
    try {
      render(await api(path, {}));
      msg($("hackerai-msg"), "", true);
    } catch (err) {
      msg($("hackerai-msg"), err.message, false);
    }
  });
}

for (const box of document.querySelectorAll(".instr")) {
  const area = box.querySelector("textarea");
  const field = box.dataset.field;
  area.addEventListener("input", () => { box.dataset.dirty = "1"; updateInstr(box); });

  const copy = box.querySelector(".instr-copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(area.value.trim());
      copy.textContent = "Copied ✓";
    } catch {
      area.select();
      copy.textContent = "Press Ctrl+C";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 2000);
  });

  box.querySelector(".instr-save").addEventListener("click", async () => {
    try {
      const s = await api("/api/instructions", { field, text: area.value });
      delete box.dataset.dirty;
      render(s);
      msg($("instr-msg"), "Saved. Copy it into HackerAI again.", true);
    } catch (err) {
      msg($("instr-msg"), err.message, false);
    }
  });

  box.querySelector(".instr-reset").addEventListener("click", async () => {
    try {
      const s = await api("/api/instructions", { field, reset: true });
      delete box.dataset.dirty;
      area.value = s.instructions[field].text;
      render(s);
      msg($("instr-msg"), "Back to the default text.", true);
    } catch (err) {
      msg($("instr-msg"), err.message, false);
    }
  });
}

// ---- console -------------------------------------------------------------------------------------------------

async function runConsole(line) {
  const entry = document.createElement("div");
  entry.className = "entry";
  const head = document.createElement("div");
  head.className = "entry-cmd";
  head.textContent = `touchless ${line}  …`;
  const out = document.createElement("pre");
  entry.append(head, out);
  $("console-out").prepend(entry);
  try {
    const r = await api("/api/console", { line });
    head.textContent = `touchless ${line}${r.code ? `  (exit ${r.code})` : ""}`;
    head.classList.toggle("bad", r.code !== 0);
    out.textContent = [r.stdout, r.stderr].filter(Boolean).join("\n").trim() || "(no output)";
    for (const src of r.images) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "Image from the phone";
      entry.append(img);
    }
  } catch (err) {
    head.classList.add("bad");
    out.textContent = err.message;
  }
}

$("console-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const line = $("console-input").value.trim();
  if (!line) return;
  $("console-input").value = "";
  runConsole(line);
});

for (const b of document.querySelectorAll(".quick button")) {
  b.addEventListener("click", () => runConsole(b.dataset.cmd));
}

// ---- activity and log ----------------------------------------------------------------------------------------

async function pollActivity() {
  try {
    const { calls } = await api(`/api/activity?after=${activityAfter}`);
    for (const c of calls) {
      activityAfter = Math.max(activityAfter, c.seq);
      activityRows.unshift(c);
    }
    activityRows.splice(200);
    if (calls.length) drawActivity();
  } catch { /* next round */ }
}

function drawActivity() {
  const body = $("activity-rows");
  body.replaceChildren(...activityRows.map((c) => {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.tabIndex = 0;
    const cell = (text, cls) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    const result = c.ok ? "✓" : `✗ ${c.note || "error"}`;
    tr.append(
      cell(new Date(c.t).toLocaleTimeString()),
      cell(c.tool || c.method, "mono"),
      cell(result, c.ok ? "res-ok" : "res-bad"),
      cell(String(c.ms), "num"),
    );
    const open = () => showCallJson(c);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return tr;
  }));
  $("activity-empty").hidden = activityRows.length > 0;
}

// ---- JSON viewer modal ---------------------------------------------------------------------------------------

function showCallJson(c) {
  const title = `${c.tool || c.method} · ${new Date(c.t).toLocaleTimeString()} · ${c.ms} ms`;
  const parts = [];
  parts.push(section("Arguments", c.args ?? {}));
  if (c.result !== undefined) parts.push(section(c.ok ? "Result" : "Result (error)", c.result));
  else if (!c.ok) parts.push(section("Error", c.note || "failed"));
  openModal(title, parts.join(""), () => JSON.stringify({ tool: c.tool || c.method, args: c.args, result: c.result ?? c.note }, null, 2));
}

function section(label, value) {
  return `<div class="json-section"><div class="json-label">${escapeHtml(label)}</div><pre class="json">${jsonHighlight(value)}</pre></div>`;
}

/** Pretty-print a value as HTML with color classes. Every piece of text is escaped first. */
function jsonHighlight(value) {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) return '<span class="j-null">(none)</span>';
  return text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]))
    .replace(/("(\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, _esc, colon, bool) => {
      if (str !== undefined) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (bool !== undefined) return `<span class="j-bool">${m}</span>`;
      if (m === "null") return `<span class="j-null">null</span>`;
      return `<span class="j-num">${m}</span>`;
    });
}

let modalCopyText = () => "";
function openModal(title, bodyHtml, copyText) {
  $("json-title").textContent = title;
  $("json-body").innerHTML = bodyHtml;
  modalCopyText = copyText || (() => "");
  $("json-modal").hidden = false;
  $("json-close").focus();
}
function closeModal() { $("json-modal").hidden = true; }

for (const el of document.querySelectorAll("#json-modal [data-close]")) el.addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("json-modal").hidden) closeModal(); });
$("json-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(modalCopyText()); $("json-copy").textContent = "Copied ✓"; }
  catch { $("json-copy").textContent = "—"; }
  setTimeout(() => { $("json-copy").textContent = "Copy"; }, 1500);
});

// ---- tool browser --------------------------------------------------------------------------------------------

let allTools = null;
let toolsLoading = false;

async function loadTools(force) {
  if (toolsLoading || (allTools && !force)) return;
  toolsLoading = true;
  try {
    const { tools, note } = await api("/api/tools");
    allTools = tools || [];
    if (note && allTools.length === 0) $("tools-list").innerHTML = `<p class="muted">${escapeHtml(note)}</p>`;
    else drawTools();
  } catch (err) {
    $("tools-list").innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  } finally {
    toolsLoading = false;
  }
}

function drawTools() {
  if (!allTools) return;
  const q = $("tools-search").value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const matched = !words.length ? allTools : allTools.filter((t) => {
    const hay = `${t.name} ${t.brief}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const cap = 80;
  const shown = matched.slice(0, cap);
  $("tools-count").textContent = matched.length > cap
    ? `${matched.length} tools — showing ${cap}, narrow the search`
    : `${matched.length} tool${matched.length === 1 ? "" : "s"}`;
  $("tools-list").replaceChildren(...shown.map((t) => {
    const row = document.createElement("div");
    row.className = "tool-row";
    const head = document.createElement("button");
    head.className = "tool-pick";
    head.innerHTML = `<span class="tool-name">${escapeHtml(t.name)}</span>` +
      `<span class="tool-badge ${t.readOnly ? "ro" : "act"}">${t.readOnly ? "read" : "acts"}</span>` +
      `<span class="tool-desc">${escapeHtml(t.brief)}</span>`;
    head.title = "Put `call " + t.name + "` in the box above";
    head.addEventListener("click", () => useTool(t));
    const info = document.createElement("button");
    info.className = "tool-info";
    info.textContent = "i";
    info.title = "Show this tool's arguments";
    info.addEventListener("click", () => openModal(
      t.name,
      section("Signature", t.signature) +
        `<div class="json-section"><div class="json-label">Description</div><p class="modal-text">${escapeHtml(t.brief)}</p></div>` +
        (t.required.length ? section("Required arguments", t.required) : ""),
      () => t.signature,
    ));
    row.append(head, info);
    return row;
  }));
}

function useTool(t) {
  const input = $("console-input");
  input.value = `call ${t.name} `;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.tab === "console");
  for (const b of document.querySelectorAll(".tab-body")) b.hidden = b.id !== "tab-console";
  input.focus();
  input.scrollIntoView({ block: "center", behavior: "smooth" });
}

$("tools-search").addEventListener("input", drawTools);

async function pollLog() {
  try {
    const { lines } = await api(`/api/hackerai/log?after=${logAfter}`);
    if (!lines.length) return;
    const pre = $("log-out");
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    for (const l of lines) {
      logAfter = Math.max(logAfter, l.seq);
      pre.append(`${new Date(l.t).toLocaleTimeString()}  ${l.text}\n`);
    }
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch { /* next round */ }
}

// ---- start ---------------------------------------------------------------------------------------------------

async function loadSession() {
  try { sessionInfo = await api("/api/session"); } catch { /* keep defaults */ }
  return sessionInfo;
}

let timers = [];
function start() {
  $("auth").hidden = true;
  $("lock").hidden = true;
  $("app").hidden = false;
  timers.forEach(clearInterval);
  loadSession().then(loadNetInfo);
  refresh();
  pollActivity();
  pollLog();
  timers = [
    setInterval(refresh, waitingSignIn ? 1500 : 3000),
    setInterval(() => { if (waitingSignIn) refresh(); }, 1500),
    setInterval(pollActivity, 3000),
    setInterval(pollLog, 2000),
  ];
}

(async () => {
  try {
    const s = await loadSession();
    if (s.locked) showLock();
    else if (s.loggedIn) start();
    else showAuth(s.passwordSet, s.hasUsername);
  } catch (err) {
    document.body.textContent = `The bridge panel can't load: ${err.message}`;
  }
})();
