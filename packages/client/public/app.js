import { io } from "/socket.io.esm.min.js";
import {
  Folder as FtFolder,
  File as FtFile,
} from "https://cdn.jsdelivr.net/npm/@webreflection/file-tree@0.1.5/prod.js";

const $ = (id) => document.getElementById(id);

const els = {
  gate: $("gate"),
  name: $("name"),
  join: $("join"),
  newSession: $("newSession"),
  reloadSessions: $("reloadSessions"),
  sessionPanel: $("sessionPanel"),
  sessionList: $("sessionList"),
  gateErr: $("gateErr"),
  header: $("header"),
  who: $("who"),
  status: $("status"),
  transcript: $("transcript"),
  prompt: $("prompt"),
  send: $("send"),
  fileList: $("fileList"),
  refreshFiles: $("refreshFiles"),
  viewerPath: $("viewerPath"),
  viewerBody: $("viewerBody"),
};

let sock = null;
let me = null;            // { user_id, session_id, capability, ... }
let currentUserId = null;
let currentAssistantEl = null;
let currentFile = null;

const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.header.classList.remove("connected", "error");
  if (kind) els.header.classList.add(kind);
}

// Render markdown into the body. Falls back to plain text if the markdown
// library failed to load (e.g. offline LAN with no CDN reachability). The
// raw text is also stashed on the element so streaming chunks can re-render
// the whole bubble from accumulated source.
function renderMarkdownInto(el, raw) {
  el.dataset.raw = raw;
  const m = window.marked;
  const p = window.DOMPurify;
  if (m && p && typeof m.parse === "function" && typeof p.sanitize === "function") {
    const html = m.parse(raw, { breaks: true, gfm: true });
    el.innerHTML = p.sanitize(html);
  } else {
    el.textContent = raw;
  }
}

function append({ kind, who, text }) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  if (who) {
    const w = document.createElement("div");
    w.className = "who";
    w.textContent = who;
    div.appendChild(w);
  }
  const body = document.createElement("div");
  body.className = "body";
  if (kind === "user" || kind === "assistant") {
    renderMarkdownInto(body, text ?? "");
  } else {
    body.textContent = text ?? "";
  }
  div.appendChild(body);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return body;
}

function appendSystem(text) {
  append({ kind: "system", text });
}

const toolTilesById = new Map(); // tool_use_id -> <details> element

function parseToolUse(t) {
  // [tool_use:ID:NAME] summary
  const m = t.match(/^\[tool_use:([^:]*):([^\]]+)\]\s?(.*)$/s);
  if (!m) return null;
  return { id: m[1], name: m[2], summary: m[3] ?? "" };
}

function parseToolResult(t) {
  // [tool_result:ID:NAME:ok|err]\nBODY
  const nl = t.indexOf("\n");
  const header = nl === -1 ? t : t.slice(0, nl);
  const body = nl === -1 ? "" : t.slice(nl + 1);
  const m = header.match(/^\[tool_result:([^:]*):([^:]+):(ok|err)\]$/);
  if (!m) return null;
  return { id: m[1], name: m[2], ok: m[3] === "ok", body };
}

function appendToolUse(raw) {
  finishAssistantBubble();
  const parsed = parseToolUse(raw);
  if (!parsed) {
    appendSystem(raw);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "msg system";
  const details = document.createElement("details");
  details.className = "tool";
  const summary = document.createElement("summary");
  summary.innerHTML =
    `<span class="tool-name">⚙ ${escapeHtml(parsed.name)}</span>` +
    (parsed.summary ? `<span class="tool-arg"> ${escapeHtml(parsed.summary)}</span>` : "") +
    `<span class="tool-status pending">pending…</span>`;
  details.appendChild(summary);
  const bodyEl = document.createElement("pre");
  bodyEl.className = "tool-body";
  bodyEl.textContent = "(waiting for result…)";
  details.appendChild(bodyEl);
  wrap.appendChild(details);
  els.transcript.appendChild(wrap);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (parsed.id) toolTilesById.set(parsed.id, details);
}

function appendToolResult(raw) {
  finishAssistantBubble();
  const parsed = parseToolResult(raw);
  if (!parsed) {
    appendSystem(raw);
    return;
  }
  let details = parsed.id ? toolTilesById.get(parsed.id) : null;
  if (!details) {
    // No matching tool_use tile (rare); create a standalone one.
    const wrap = document.createElement("div");
    wrap.className = "msg system";
    details = document.createElement("details");
    details.className = "tool";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(parsed.name)}</span>`;
    details.appendChild(summary);
    const bodyEl = document.createElement("pre");
    bodyEl.className = "tool-body";
    details.appendChild(bodyEl);
    wrap.appendChild(details);
    els.transcript.appendChild(wrap);
    if (parsed.id) toolTilesById.set(parsed.id, details);
  }
  const status = details.querySelector(".tool-status");
  if (status) {
    status.className = `tool-status ${parsed.ok ? "ok" : "err"}`;
    status.textContent = parsed.ok ? "ok" : "error";
  }
  const bodyEl = details.querySelector(".tool-body");
  if (bodyEl) bodyEl.textContent = parsed.body || (parsed.ok ? "(no output)" : "(no output)");
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function startAssistantBubble() {
  currentAssistantEl = append({ kind: "assistant", who: "assistant", text: "" });
}

function appendToAssistant(chunk) {
  if (!currentAssistantEl) startAssistantBubble();
  const next = (currentAssistantEl.dataset.raw ?? "") + chunk;
  renderMarkdownInto(currentAssistantEl, next);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function finishAssistantBubble() {
  currentAssistantEl = null;
}

// --- gate ---------------------------------------------------------------

els.name.addEventListener("input", () => {
  els.gateErr.textContent = "";
});
els.name.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.join.click();
});

els.join.addEventListener("click", async () => {
  await continueWithName();
});
els.reloadSessions.addEventListener("click", async () => {
  if (currentUserId) await loadSessions(currentUserId);
});
els.newSession.addEventListener("click", async () => {
  if (currentUserId) await joinSession({ userId: currentUserId, newSession: true });
});

async function continueWithName() {
  const raw = els.name.value.trim();
  if (!NAME_RE.test(raw)) {
    els.gateErr.textContent = "name must be 1-32 chars: letters, digits, _, -";
    return;
  }
  currentUserId = `user_${raw}`;
  els.join.disabled = true;
  els.gateErr.textContent = "";
  try {
    await loadSessions(currentUserId);
    els.sessionPanel.classList.remove("hidden");
  } catch (e) {
    els.gateErr.textContent = e.message ?? String(e);
  } finally {
    els.join.disabled = false;
  }
}

async function loadSessions(userId) {
  els.gateErr.textContent = "";
  els.sessionList.innerHTML = `<div class="session-meta">loading sessions...</div>`;
  const r = await fetch(`/api/sessions?user_id=${encodeURIComponent(userId)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `sessions ${r.status}`);
  renderSessions(userId, data.sessions ?? []);
}

function renderSessions(userId, sessions) {
  els.sessionList.innerHTML = "";
  if (!sessions.length) {
    els.sessionList.innerHTML = `<div class="session-meta">no active sessions</div>`;
    return;
  }
  const chatMap = readChatMap(userId);
  for (const s of sessions) {
    const knownChats = chatMap[s.session_id] ?? [];
    const lastChat = s.last_chat_id ?? knownChats[0] ?? null;
    const row = document.createElement("div");
    row.className = "session-row";
    const meta = [
      `owner ${s.owner_user_id}`,
      s.status,
      s.updated_at ? `updated ${new Date(s.updated_at).toLocaleTimeString()}` : "",
    ].filter(Boolean).join(" · ");
    row.innerHTML =
      `<div class="session-main"><span class="session-id">${escapeHtml(s.session_id)}</span></div>` +
      `<div class="session-meta">${escapeHtml(meta)}</div>`;
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (lastChat) {
      const resume = document.createElement("button");
      resume.textContent = "resume chat";
      resume.addEventListener("click", () =>
        joinSession({ userId, sessionId: s.session_id, chatId: lastChat }),
      );
      actions.appendChild(resume);
      const newChat = document.createElement("button");
      newChat.className = "secondary";
      newChat.textContent = "start another chat";
      newChat.addEventListener("click", () =>
        joinSession({ userId, sessionId: s.session_id, newChat: true }),
      );
      actions.appendChild(newChat);
    } else {
      const start = document.createElement("button");
      start.textContent = "start chat";
      start.addEventListener("click", () =>
        joinSession({ userId, sessionId: s.session_id, newChat: true }),
      );
      actions.appendChild(start);
    }
    row.appendChild(actions);
    els.sessionList.appendChild(row);
  }
}

async function joinSession({ userId, sessionId, chatId, newChat, newSession }) {
  els.gateErr.textContent = "";
  const body = {
    user_id: userId,
    ...(newSession ? {} : { session_id: sessionId }),
    ...(chatId ? { chat_id: chatId } : {}),
    ...(newChat || newSession ? { new_chat: true } : {}),
  };
  const r = await fetch("/api/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    els.gateErr.textContent = data.error ?? `join failed (${r.status})`;
    return;
  }
  rememberChat(userId, data.session_id, data.chat_id);
  me = data;
  els.gate.classList.add("hidden");
  els.who.textContent = `${me.user_id} · ${me.session_id} · ${me.chat_id}`;
  connect();
}

function chatStoreKey(userId) {
  return `collab:chats:${userId}`;
}

function readChatMap(userId) {
  try {
    return JSON.parse(localStorage.getItem(chatStoreKey(userId)) ?? "{}");
  } catch {
    return {};
  }
}

function rememberChat(userId, sessionId, chatId) {
  if (!chatId) return;
  const map = readChatMap(userId);
  const list = (map[sessionId] ?? []).filter((id) => id !== chatId);
  map[sessionId] = [chatId, ...list].slice(0, 10);
  localStorage.setItem(chatStoreKey(userId), JSON.stringify(map));
}

// --- socket -------------------------------------------------------------

function connect() {
  const relayUrl = `${location.protocol}//${location.hostname}:${me.relay_port}`;
  sock = io(relayUrl, {
    transports: ["websocket"],
    auth: { kind: "client", token: me.invite_token, chat_id: me.chat_id },
    reconnection: true,
  });

  sock.on("connect", () => {
    setStatus(`connected (${sock.id.slice(0, 6)})`, "connected");
    els.send.disabled = false;
    appendSystem(`joined as ${me.user_id}`);
    refreshFiles();
  });
  sock.on("connect_error", (e) => {
    setStatus(`connect error: ${e.message}`, "error");
    els.send.disabled = true;
  });
  sock.on("disconnect", (r) => {
    setStatus(`disconnected (${r})`, "error");
    els.send.disabled = true;
  });

  sock.on("event", (ev) => {
    switch (ev.type) {
      case "agent.token": {
        if (!isCurrentChatEvent(ev)) return;
        dispatchAgentChunk(ev.data ?? "");
        break;
      }
      case "files.changed":
        handleFilesChanged(ev.changes ?? []);
        break;
      case "chat.message":
        if (!isCurrentChatEvent(ev)) return;
        append({ kind: "user", who: ev.user_id, text: ev.text });
        break;
      case "command.output":
        appendSystem(`cmd[${ev.stream}]: ${ev.data}`);
        break;
      case "publish.status":
        appendSystem(`publish[${ev.phase}] ok=${ev.ok}`);
        break;
      case "owner.changed":
        appendSystem(`owner is now ${ev.new_owner} (epoch ${ev.epoch})`);
        break;
      case "session.ended":
        appendSystem(`session ended: ${ev.reason ?? ""}`);
        els.send.disabled = true;
        break;
      case "presence.update":
        appendSystem(`${ev.user_id} ${ev.online ? "online" : "offline"}`);
        break;
      case "error":
        if (!isCurrentChatEvent(ev)) return;
        appendSystem(`error ${ev.code}: ${ev.message}`);
        finishAssistantBubble();
        break;
      default:
        appendSystem(JSON.stringify(ev));
    }
  });

  sock.on("replay", (bundle) => {
    resetTranscript();
    if (bundle?.chat?.length) {
      for (const c of bundle.chat) {
        if (c.user_id === "agent") {
          // Stored as JSON array of token chunks; replay through the same
          // dispatcher used live so tool tiles and markdown both come back.
          let chunks = null;
          try { chunks = JSON.parse(c.text); } catch { chunks = null; }
          if (Array.isArray(chunks)) {
            startAssistantBubble();
            for (const chunk of chunks) dispatchAgentChunk(String(chunk));
            finishAssistantBubble();
          } else {
            append({ kind: "assistant", who: "assistant", text: c.text });
          }
        } else {
          append({ kind: "user", who: c.user_id, text: c.text });
        }
      }
    }
  });
}

// Shared between live agent.token handling and replay of stored assistant
// rows. Knows about the markers the daemon embeds in the token stream:
// [tool_use:…], [tool_result:…], [checkpoint …], [done], plus the legacy
// [edit …] / [cmd …] / [tool …] strings emitted by the scripted agent.
function dispatchAgentChunk(t) {
  if (!t) return;
  if (t.startsWith("[checkpoint")) {
    appendSystem(t);
    finishAssistantBubble();
  } else if (t === "[done]") {
    finishAssistantBubble();
  } else if (t.startsWith("[tool_use:")) {
    appendToolUse(t);
  } else if (t.startsWith("[tool_result:")) {
    appendToolResult(t);
  } else if (
    t.startsWith("[edit ") ||
    t.startsWith("[cmd ") ||
    t.startsWith("[tool ")
  ) {
    appendSystem(t);
  } else {
    appendToAssistant(t);
  }
}

function isCurrentChatEvent(ev) {
  const chatId = ev.chat_id ?? "default";
  return chatId === (me?.chat_id ?? "default");
}

function resetTranscript() {
  els.transcript.innerHTML = "";
  currentAssistantEl = null;
  toolTilesById.clear();
}

// --- prompt ---------------------------------------------------------------

function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text || !sock?.connected) return;
  append({ kind: "user", who: me.user_id, text });
  startAssistantBubble();
  sock.emit("event", {
    type: "agent.prompt",
    session_id: me.session_id,
    chat_id: me.chat_id,
    prompt_id: `p_${Date.now()}`,
    capability: me.capability,
    text,
  });
  els.prompt.value = "";
}

els.send.addEventListener("click", sendPrompt);
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// --- file pane ----------------------------------------------------------

async function refreshFiles() {
  if (!me) return;
  try {
    const r = await fetch(`/api/files?session_id=${encodeURIComponent(me.session_id)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `files ${r.status}`);
    renderFiles(data.files ?? []);
  } catch (e) {
    els.fileList.innerHTML = `<div class="empty">files error: ${escapeHtml(e.message ?? e)}</div>`;
  }
}

function handleFilesChanged(changes) {
  if (!changes.length) return;
  refreshFiles();
  if (currentFile) {
    const hit = changes.find((c) => c.path === currentFile);
    if (hit) {
      if (hit.kind === "unlink") {
        currentFile = null;
        els.viewerPath.textContent = "no file selected";
        els.viewerBody.innerHTML = `<div class="empty">file removed</div>`;
      } else {
        loadFile(currentFile);
      }
    }
  }
}

// Group the flat path list from /api/files into nested Folder + File objects
// for @webreflection/file-tree. Folders show with the disclosure triangle and
// folders are kept sorted; the component handles open/close + keyboard nav.
function buildFileTree(files) {
  const folders = new Map(); // posix path -> Folder
  const roots = [];
  const folderAt = (path, name) => {
    let f = folders.get(path);
    if (!f) {
      f = new FtFolder(name);
      folders.set(path, f);
    }
    return f;
  };
  for (const f of files) {
    const parts = f.path.split("/");
    const name = parts.pop();
    let parent = null;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = folders.has(prefix);
      const folder = folderAt(prefix, part);
      if (!existing) {
        if (parent) parent.append(folder);
        else roots.push(folder);
      }
      parent = folder;
    }
    // file-tree derives the displayed byte count from the actual Blob size,
    // so pass a zero-filled buffer of the right size (clamped to keep huge
    // files from inflating the UI's memory footprint).
    const bytes = Math.max(0, Math.min(f.size ?? 0, 16 * 1024 * 1024));
    const file = new FtFile([new Uint8Array(bytes)], name);
    if (parent) parent.append(file);
    else roots.push(file);
  }
  return roots;
}

let fileTreeEl = null;

function renderFiles(files) {
  els.fileList.innerHTML = "";
  if (files.length === 0) {
    els.fileList.innerHTML = `<div class="empty" style="padding:10px 12px;color:#6c7280;font-style:italic;">no visible files</div>`;
    fileTreeEl = null;
    return;
  }
  fileTreeEl = document.createElement("file-tree");
  els.fileList.appendChild(fileTreeEl);
  fileTreeEl.append(...buildFileTree(files));
  fileTreeEl.addEventListener("click", (e) => {
    const detail = e.detail;
    if (!detail || detail.folder) return; // folder clicks toggle open/close
    loadFile(detail.path);
  });
}

async function loadFile(path) {
  currentFile = path;
  els.viewerPath.textContent = path;
  els.viewerBody.innerHTML = `<div class="empty">loading…</div>`;
  try {
    const r = await fetch(
      `/api/file?session_id=${encodeURIComponent(me.session_id)}&path=${encodeURIComponent(path)}`,
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? `file ${r.status}`);
    const pre = document.createElement("pre");
    pre.textContent = data.content + (data.truncated ? "\n\n… (truncated)" : "");
    els.viewerBody.innerHTML = "";
    els.viewerBody.appendChild(pre);
  } catch (e) {
    els.viewerBody.innerHTML = `<div class="empty">error: ${escapeHtml(e.message ?? e)}</div>`;
  }
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

els.refreshFiles.addEventListener("click", refreshFiles);
