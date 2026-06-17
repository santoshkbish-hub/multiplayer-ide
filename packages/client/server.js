import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUB = resolve(__dirname, "public");
const REPO_ROOT = resolve(__dirname, "..", "..");
const SOCKET_IO_CLIENT = resolve(
  __dirname,
  "..", "..",
  "node_modules", "socket.io-client", "dist", "socket.io.esm.min.js",
);

// Repo-root HTML documents that the client server also exposes (so the LAN
// landing page can link to them as siblings of the IDE).
const DOC_PAGES = new Map([
  ["/flows.html",  resolve(REPO_ROOT, "flows.html")],
  ["/design.html", resolve(REPO_ROOT, "design.html")],
]);

const PORT = Number(process.env.CLIENT_PORT ?? 5173);
const ADMIN_URL = process.env.COLLAB_ADMIN_URL ?? "http://127.0.0.1:4100";
const ADMIN_TOKEN = process.env.COLLAB_ADMIN_TOKEN ?? process.env.COLLAB_HOST_TOKEN;
const RELAY_PORT = Number(process.env.COLLAB_RELAY_PORT ?? 4000);

if (!ADMIN_TOKEN) {
  console.error("COLLAB_HOST_TOKEN (or COLLAB_ADMIN_TOKEN) required");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".map":  "application/json",
};

// chat ownership is intentionally one user per chat. Multiple chats can target
// the same daemon session/container, but a chat_id is claimed by one user.
const chatOwners = new Map(); // `${session_id}:${chat_id}` -> user_id
const lastChatByUserSession = new Map(); // `${user_id}:${session_id}` -> chat_id

async function adminPost(path, body) {
  const r = await fetch(`${ADMIN_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : "",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`admin ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function adminGet(path) {
  const r = await fetch(`${ADMIN_URL}${path}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`admin ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function provisionUser(userId) {
  const created = await adminPost("/sessions", { owner_user_id: userId });
  return joinSessionChat(userId, created.session_id, { newChat: true });
}

function newChatId() {
  return `chat_${randomUUID()}`;
}

async function joinSessionChat(userId, sessionId, opts = {}) {
  const chatId = opts.newChat || !opts.chatId ? newChatId() : opts.chatId;
  const key = `${sessionId}:${chatId}`;
  const owner = chatOwners.get(key);
  if (owner && owner !== userId) {
    throw new Error(`chat ${chatId} is already owned by ${owner}`);
  }
  chatOwners.set(key, userId);
  lastChatByUserSession.set(`${userId}:${sessionId}`, chatId);
  const invite = await adminPost(`/sessions/${sessionId}/invites`, {
    user_id: userId,
    role: "owner",
    chat_id: chatId,
  });
  return {
    session_id: sessionId,
    chat_id: chatId,
    invite_token: invite.invite_token,
    capability: invite.capability,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c.toString("utf8")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/join") {
      const body = await readBody(req);
      const { user_id, session_id, chat_id, new_chat } = body ? JSON.parse(body) : {};
      if (typeof user_id !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(user_id)) {
        return json(res, 400, { error: "user_id must be 1-32 chars [a-zA-Z0-9_-]" });
      }
      const prov = typeof session_id === "string" && session_id
        ? await joinSessionChat(user_id, session_id, {
            ...(typeof chat_id === "string" && chat_id ? { chatId: chat_id } : {}),
            newChat: Boolean(new_chat),
          })
        : await provisionUser(user_id);
      return json(res, 200, { ...prov, user_id, relay_port: RELAY_PORT });
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const userId = url.searchParams.get("user_id") ?? "";
      const out = await adminGet("/sessions");
      const sessions = (out.sessions ?? []).map((s) => ({
        ...s,
        last_chat_id: userId ? lastChatByUserSession.get(`${userId}:${s.session_id}`) : undefined,
      }));
      return json(res, 200, { sessions, relay_port: RELAY_PORT });
    }

    if (req.method === "GET" && url.pathname === "/api/files") {
      const sid = url.searchParams.get("session_id");
      if (!sid) return json(res, 400, { error: "session_id required" });
      const out = await adminGet(`/sessions/${encodeURIComponent(sid)}/files`);
      return json(res, 200, out);
    }

    if (req.method === "GET" && url.pathname === "/api/file") {
      const sid = url.searchParams.get("session_id");
      const p = url.searchParams.get("path");
      if (!sid || !p) return json(res, 400, { error: "session_id and path required" });
      const out = await adminGet(
        `/sessions/${encodeURIComponent(sid)}/file?path=${encodeURIComponent(p)}`,
      );
      return json(res, 200, out);
    }

    let pathname = url.pathname;
    if (pathname === "/") pathname = "/index.html";

    let filePath;
    if (pathname === "/socket.io.esm.min.js") {
      filePath = SOCKET_IO_CLIENT;
    } else if (DOC_PAGES.has(pathname)) {
      filePath = DOC_PAGES.get(pathname);
    } else {
      filePath = join(PUB, pathname);
      if (!filePath.startsWith(PUB)) {
        res.writeHead(403).end("forbidden");
        return;
      }
    }
    await stat(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (e?.code === "ENOENT") {
      res.writeHead(404).end("not found");
    } else {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({ error: String(e?.message ?? e) }),
      );
    }
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`client http://0.0.0.0:${PORT} (LAN-accessible)`);
});
