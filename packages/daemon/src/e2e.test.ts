import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import { startRelay, type RelayHandle } from "@collab/relay";
import type {
  AgentToken,
  Capability,
  ChatMessage,
  OwnerChanged,
  PermissionPolicy,
  PublishStatus,
  SessionEnded,
  WireEvent,
} from "@collab/shared";
import { git } from "./git/manager.js";
import { Orchestrator } from "./orchestrator.js";
import type { DaemonConfig } from "./config.js";
import { DEFAULT_CONTAINER_IMAGE } from "./container/types.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-e2e-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@local"]);
  mustGit(root, ["config", "user.name", "test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/foo.ts"), "export const foo = 1;\n");
  writeFileSync(join(root, ".env"), "SECRET=1");
  mustGit(root, ["add", "-A"]);
  mustGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

interface AdminFetch {
  (path: string, body?: unknown): Promise<unknown>;
}

function makeAdminFetch(port: number, token: string): AdminFetch {
  return async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : "",
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`admin ${path} ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

function waitFor<T = WireEvent>(
  sock: ClientSocket,
  predicate: (ev: WireEvent) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off("event", on);
      reject(new Error("timeout waiting for event"));
    }, timeoutMs);
    const on = (ev: WireEvent) => {
      if (predicate(ev)) {
        clearTimeout(t);
        sock.off("event", on);
        resolve(ev as unknown as T);
      }
    };
    sock.on("event", on);
  });
}

function collectTokens(sock: ClientSocket, prompt_id: string, timeoutMs = 3000): Promise<AgentToken[]> {
  return new Promise((resolve, reject) => {
    const acc: AgentToken[] = [];
    const t = setTimeout(() => {
      sock.off("event", on);
      reject(new Error(`timeout collecting tokens; got ${acc.length}`));
    }, timeoutMs);
    const on = (ev: WireEvent) => {
      if (ev.type === "agent.token" && ev.prompt_id === prompt_id) {
        acc.push(ev);
        if (ev.data.startsWith("[checkpoint")) {
          clearTimeout(t);
          sock.off("event", on);
          resolve(acc);
        }
      }
    };
    sock.on("event", on);
  });
}

describe("end-to-end orchestrator", () => {
  let repo: string;
  let dataDir: string;
  let relay: RelayHandle;
  let orch: Orchestrator;
  let adminPort: number;
  let admin: AdminFetch;
  const HOST_TOKEN = "host-secret-e2e";

  beforeAll(async () => {
    repo = makeRepo();
    dataDir = mkdtempSync(join(tmpdir(), "collab-e2e-data-"));

    relay = await startRelay({ port: 0, hostToken: HOST_TOKEN });

    const config: DaemonConfig = {
      repoRoot: repo,
      worktreesRoot: join(dataDir, "worktrees"),
      relayUrl: `http://127.0.0.1:${relay.port}`,
      hostToken: HOST_TOKEN,
      adminToken: HOST_TOKEN,
      adminPort: 0,
      secretPath: join(dataDir, "secret"),
      dbPath: join(dataDir, "db.sqlite"),
      containerImage: DEFAULT_CONTAINER_IMAGE,
      createContainers: false, // keep e2e fast; container live tests cover the boundary
      agent: "scripted", // tests use the deterministic scripted runner, not the SDK
      idleMs: 60 * 60 * 1000, // 1h — disable idle teardown for the duration of e2e
    };
    orch = new Orchestrator(config);
    const r = await orch.start();
    adminPort = r.adminPort;
    admin = makeAdminFetch(adminPort, HOST_TOKEN);
  }, 30_000);

  afterAll(async () => {
    await orch?.stop();
    await relay?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated admin requests", async () => {
    const r = await fetch(`http://127.0.0.1:${adminPort}/sessions`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("creates a session, issues an invite + capability, and drives an agent prompt end-to-end", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: ["npm test"],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
      branch_name: string;
      worktree_path: string;
    };
    expect(created.session_id).toMatch(/^sess_/);

    const invite = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };

    const client: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: invite.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });

    try {
      // chat round-trip
      const chatBack = waitFor<ChatMessage>(client, (ev) => ev.type === "chat.message");
      const chat: ChatMessage = {
        type: "chat.message",
        session_id: created.session_id,
        user_id: "alice",
        text: "hello",
      };
      client.emit("event", chat);
      const got = await chatBack;
      expect(got.text).toBe("hello");

      // agent.prompt → scripted edit → expect tokens + checkpoint
      const promptId = `p_${Date.now()}`;
      const collect = collectTokens(client, promptId);
      client.emit("event", {
        type: "agent.prompt",
        session_id: created.session_id,
        prompt_id: promptId,
        capability: invite.capability,
        text: JSON.stringify({
          actions: [
            { type: "say", text: "editing foo" },
            { type: "edit", path: "src/foo.ts", content: "export const foo = 777;\n" },
          ],
        }),
      });
      const toks = await collect;
      expect(toks.some((t) => t.data === "editing foo")).toBe(true);
      // `kind:"edit"`/`kind:"command"` are internal-only now (the SDK path
      // shows them as tool_use/tool_result tiles; the scripted path used to
      // turn them into `[edit …]` strings but the UI value is gone). We
      // verify the behavior via the file landing on disk and the checkpoint.
      expect(toks.at(-1)?.data.startsWith("[checkpoint")).toBe(true);

      // edit landed on disk in the worktree
      expect(readFileSync(join(created.worktree_path, "src/foo.ts"), "utf8")).toContain("foo = 777");
    } finally {
      client.disconnect();
    }
  }, 20_000);

  it("publish streams phase events and the merge lands on main", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: [],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
      branch_name: string;
      worktree_path: string;
    };
    const inv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };

    const client: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: inv.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });

    try {
      const promptId = `p_${Date.now()}_pub`;
      const collect = collectTokens(client, promptId);
      client.emit("event", {
        type: "agent.prompt",
        session_id: created.session_id,
        prompt_id: promptId,
        capability: inv.capability,
        text: JSON.stringify({
          actions: [
            { type: "edit", path: "src/foo.ts", content: "export const foo = 42;\n" },
          ],
        }),
      });
      await collect;

      // Now publish — expect a stream of publish.status events with phase=start, sync, validate, merge, done.
      const phases: PublishStatus[] = [];
      const donePromise = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`pub timeout; got ${phases.map((p) => p.phase).join(",")}`)), 5000);
        const on = (ev: WireEvent) => {
          if (ev.type !== "publish.status" || ev.session_id !== created.session_id) return;
          phases.push(ev);
          if (ev.phase === "done" || ev.phase === "failed") {
            clearTimeout(t);
            client.off("event", on);
            resolve();
          }
        };
        client.on("event", on);
      });
      await admin(`/sessions/${created.session_id}/publish`);
      await donePromise;

      const names = phases.map((p) => p.phase);
      expect(names).toContain("start");
      expect(names).toContain("sync");
      expect(names).toContain("validate");
      expect(names).toContain("merge");
      expect(names.at(-1)).toBe("done");
    } finally {
      client.disconnect();
    }
  }, 15_000);

  it("publish checkpoints uncommitted worktree changes before merging", async () => {
    const created = (await admin("/sessions", { owner_user_id: "alice" })) as {
      session_id: string;
      worktree_path: string;
    };
    writeFileSync(
      join(created.worktree_path, "foo.ts"),
      "export const createdBeforePublish = true;\n",
    );

    const res = (await admin(`/sessions/${created.session_id}/publish`)) as {
      ok: boolean;
      merge_sha?: string;
      failure_reason?: string;
      changed_files: string[];
    };
    expect(res.ok).toBe(true);
    expect(res.merge_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.changed_files).toContain("foo.ts");
    expect(readFileSync(join(repo, "foo.ts"), "utf8")).toContain(
      "createdBeforePublish",
    );
  }, 10_000);

  it("delegate emits owner.changed and invalidates the prior capability", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: [],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
    };
    const aliceInv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };

    const observer: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: aliceInv.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });

    try {
      const ownerEvt = waitFor<OwnerChanged>(observer, (ev) => ev.type === "owner.changed");
      const del = (await admin(`/sessions/${created.session_id}/delegate`, {
        new_owner_user_id: "bob",
      })) as { new_epoch: number; capability: Capability };
      const oc = await ownerEvt;
      expect(oc.new_owner).toBe("bob");
      expect(oc.epoch).toBe(del.new_epoch);
      expect(del.new_epoch).toBeGreaterThan(1);

      // Alice's old capability should now be rejected — connect with it and try a prompt.
      // Her invite was revoked by the delegate, so the socket connect itself should fail.
      const reconnect = new Promise((_, reject) => {
        const s = ioc(`http://127.0.0.1:${relay.port}`, {
          transports: ["websocket"],
          auth: { kind: "client", token: aliceInv.invite_token },
          reconnection: false,
        });
        s.once("connect_error", (e) => reject(e));
        s.once("connect", () => reject(new Error("alice should not be able to reconnect")));
      });
      await expect(reconnect).rejects.toThrow();
    } finally {
      observer.disconnect();
    }
  }, 10_000);

  it("end-session emits session.ended and disconnects clients", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: [],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
    };
    const inv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };
    const client: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: inv.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
    try {
      const endedEvt = waitFor<SessionEnded>(client, (ev) => ev.type === "session.ended");
      const disconnected = new Promise<void>((resolve) =>
        client.once("disconnect", () => resolve()),
      );
      await admin(`/sessions/${created.session_id}/end`, { reason: "test_done" });
      const ev = await endedEvt;
      expect(ev.reason).toBe("test_done");
      await disconnected;
      expect(client.connected).toBe(false);
    } finally {
      client.disconnect();
    }
  }, 10_000);

  it("delivers a replay bundle on connect with since cursors", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: [],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
    };
    const inv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };

    // First client sends chat to populate history.
    const first: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: inv.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
    try {
      const echoed = waitFor<ChatMessage>(first, (ev) => ev.type === "chat.message");
      first.emit("event", {
        type: "chat.message",
        session_id: created.session_id,
        user_id: "alice",
        text: "history-1",
      });
      await echoed;
    } finally {
      first.disconnect();
    }
    // Tiny pause so the daemon's chat append commits before the new client requests replay.
    await new Promise((r) => setTimeout(r, 50));

    // Second connection asks for replay since chat_seq=0.
    const replay = new Promise<unknown>((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: {
          kind: "client",
          token: inv.invite_token,
          since_chat_seq: 0,
          since_event_seq: 0,
        },
        reconnection: false,
      });
      const t = setTimeout(() => reject(new Error("replay timeout")), 3000);
      s.on("replay", (bundle: unknown) => {
        clearTimeout(t);
        s.disconnect();
        resolve(bundle);
      });
      s.once("connect_error", reject);
    });
    const bundle = (await replay) as {
      chat: Array<{ text: string }>;
      events: Array<{ kind: string }>;
      cursor: { chat_seq: number; event_seq: number };
    };
    expect(bundle.chat.some((c) => c.text === "history-1")).toBe(true);
    expect(bundle.cursor.chat_seq).toBeGreaterThan(0);
  }, 10_000);

  it("scopes replay and agent tokens by chat_id within the same session", async () => {
    const created = (await admin("/sessions", { owner_user_id: "alice" })) as {
      session_id: string;
      worktree_path: string;
    };
    const aliceInv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };
    const bobInv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "bob",
      role: "owner",
    })) as { invite_token: string; capability: Capability };

    const alice: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: aliceInv.invite_token, chat_id: "chat_a" },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
    try {
      const promptId = `p_${Date.now()}_chat`;
      const collect = collectTokens(alice, promptId);
      alice.emit("event", {
        type: "agent.prompt",
        session_id: created.session_id,
        chat_id: "chat_a",
        prompt_id: promptId,
        capability: aliceInv.capability,
        text: JSON.stringify({
          actions: [
            { type: "say", text: "chat scoped" },
          ],
        }),
      });
      const tokens = await collect;
      expect(tokens.every((t) => t.chat_id === "chat_a")).toBe(true);
    } finally {
      alice.disconnect();
    }

    const bob: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: bobInv.invite_token, chat_id: "chat_b" },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
    try {
      const promptId = `p_${Date.now()}_bob`;
      const collect = collectTokens(bob, promptId);
      bob.emit("event", {
        type: "agent.prompt",
        session_id: created.session_id,
        chat_id: "chat_b",
        prompt_id: promptId,
        capability: bobInv.capability,
        text: JSON.stringify({
          actions: [
            { type: "say", text: "bob scoped" },
          ],
        }),
      });
      await collect;
    } finally {
      bob.disconnect();
    }

    await new Promise((r) => setTimeout(r, 50));

    const replay = new Promise<unknown>((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: {
          kind: "client",
          token: aliceInv.invite_token,
          chat_id: "chat_a",
          since_chat_seq: 0,
          since_event_seq: 0,
        },
        reconnection: false,
      });
      const t = setTimeout(() => reject(new Error("chat replay timeout")), 3000);
      s.on("replay", (bundle: unknown) => {
        clearTimeout(t);
        s.disconnect();
        resolve(bundle);
      });
      s.once("connect_error", reject);
    });
    const bundle = (await replay) as {
      chat: Array<{ chat_id: string; text: string }>;
    };
    expect(bundle.chat.some((c) => c.chat_id === "chat_a" && c.text.includes("chat scoped"))).toBe(true);
    expect(bundle.chat.some((c) => c.chat_id === "chat_b" || c.text.includes("bob scoped"))).toBe(false);
  }, 10_000);

  it("a reader's invite cannot drive prompts (relay rejects with error)", async () => {
    const policy: PermissionPolicy = {
      read_allow: ["**"],
      write_allow: ["src/**"],
      deny: [".env*"],
      command_allow: [],
      network: "none",
    };
    const created = (await admin("/sessions", { owner_user_id: "alice", policy })) as {
      session_id: string;
      branch_name: string;
      worktree_path: string;
    };
    const ownerInv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "alice",
      role: "owner",
    })) as { invite_token: string; capability: Capability };
    const readerInv = (await admin(`/sessions/${created.session_id}/invites`, {
      user_id: "bob",
      role: "reader",
    })) as { invite_token: string; capability: Capability };

    const reader: ClientSocket = await new Promise((resolve, reject) => {
      const s = ioc(`http://127.0.0.1:${relay.port}`, {
        transports: ["websocket"],
        auth: { kind: "client", token: readerInv.invite_token },
        reconnection: false,
      });
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });

    try {
      const errBack = waitFor(reader, (ev) => ev.type === "error");
      reader.emit("event", {
        type: "agent.prompt",
        session_id: created.session_id,
        prompt_id: `p_${Date.now()}`,
        capability: ownerInv.capability, // even if the reader smuggles the owner's capability...
        text: "should not run",
      });
      // ...the relay drops it before it reaches the daemon because the reader's
      // socket isn't role=owner.
      const err = await errBack;
      expect(err.type).toBe("error");
    } finally {
      reader.disconnect();
    }
  }, 10_000);
});
