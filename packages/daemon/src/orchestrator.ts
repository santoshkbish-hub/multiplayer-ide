import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import { minimatch } from "minimatch";
import {
  DEFAULT_POLICY,
  type AgentPrompt,
  type AgentToken,
  type Capability,
  type ChatMessage,
  type CommandOutput,
  type CommandRequest,
  type ErrorEvent,
  type PermissionPolicy,
  type Role,
} from "@collab/shared";
import type { DaemonConfig } from "./config.js";
import { openDb } from "./store/db.js";
import { SessionRepo } from "./store/sessions.js";
import { AuditRepo } from "./store/audit.js";
import { ChatRepo } from "./store/chat.js";
import { AgentStatusRepo } from "./store/agentStatus.js";
import { loadOrCreateSecret } from "./session/secret.js";
import { CapabilityIssuer } from "./session/capability.js";
import { SessionManager } from "./session/manager.js";
import { GitManager } from "./git/manager.js";
import { GitSync } from "./git/sync.js";
import { PolicyResolver } from "./policy/resolver.js";
import { PodmanContainerManager } from "./container/podman.js";
import { DEFAULT_LIMITS } from "./container/types.js";
import { ScriptedAgent } from "./agent/scripted.js";
import { ClaudeAgent } from "./agent/claude.js";
import type { AgentRunner } from "./agent/runner.js";
import { MainDiffContextProvider } from "./agent/mainContext.js";
import { AgentStatusContextProvider } from "./agent/statusContext.js";
import { AgentLoop } from "./agent/loop.js";
import { MergeManager } from "./merge/manager.js";
import { FixedRehydrator } from "./resilience/rehydrate.js";
import { Replay } from "./resilience/replay.js";
import { FileWatcher } from "./files/watcher.js";
import { RelayClient, type ForwardedEvent } from "./relayClient.js";
import {
  AdminServer,
  type CreateSessionInput,
  type CreateSessionOutput,
  type DelegateInput,
  type DelegateOutput,
  type EndSessionInput,
  type IssueInviteInput,
  type IssueInviteOutput,
  type ListFilesOutput,
  type ReadFileOutput,
  type SessionSummary,
} from "./admin.js";
import type {
  FilesChanged,
  OwnerChanged,
  PublishStatus,
  SessionEnded,
} from "@collab/shared";

function classifyForPolicy(rel: string, policy: PermissionPolicy): "rw" | "ro" | null {
  if (policy.deny.some((g) => minimatch(rel, g, { dot: true }))) return null;
  if (policy.write_allow.some((g) => minimatch(rel, g, { dot: true }))) return "rw";
  if (policy.read_allow.some((g) => minimatch(rel, g, { dot: true }))) return "ro";
  return null;
}

export class Orchestrator {
  private db!: ReturnType<typeof openDb>;
  private sessions!: SessionRepo;
  private audit!: AuditRepo;
  private chat!: ChatRepo;
  private agentStatus!: AgentStatusRepo;
  private sm!: SessionManager;
  private gm!: GitManager;
  private gs!: GitSync;
  private resolver!: PolicyResolver;
  private podman!: PodmanContainerManager;
  private loop!: AgentLoop;
  private merge!: MergeManager;
  private replay!: Replay;
  private relay!: RelayClient;
  private admin!: AdminServer;
  private watcher!: FileWatcher;
  private emptyFile = "";
  // user_id of the most recent invite per session (so we can revoke on delegate)
  private invitesBySession = new Map<string, Map<string, string>>();
  // socket_ids currently connected per session, across all chats. A session is
  // considered live iff this set is non-empty.
  private liveSockets = new Map<string, Set<string>>();
  // Pending idle-teardown timers, one per session with zero live sockets.
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(private config: DaemonConfig) {}

  async start(): Promise<{ adminPort: number }> {
    this.db = openDb(this.config.dbPath);
    this.sessions = new SessionRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.chat = new ChatRepo(this.db);
    this.agentStatus = new AgentStatusRepo(this.db);

    const secret = loadOrCreateSecret(this.config.secretPath);
    this.sm = new SessionManager({
      sessions: this.sessions,
      audit: this.audit,
      caps: new CapabilityIssuer(secret),
    });

    this.gm = new GitManager();
    this.gs = new GitSync(this.gm);
    const mainContext = new MainDiffContextProvider({
      repoRoot: this.config.repoRoot,
      git: this.gm,
      sync: this.gs,
      getBranchName: (sessionId) => this.sm.getSession(sessionId)?.branch_name ?? null,
    });
    const statusContext = new AgentStatusContextProvider({
      status: this.agentStatus,
    });
    this.resolver = new PolicyResolver();
    this.podman = new PodmanContainerManager({
      ...DEFAULT_LIMITS,
      image: this.config.containerImage,
    });

    mkdirSync(this.config.worktreesRoot, { recursive: true });
    this.emptyFile = join(this.config.worktreesRoot, ".empty");
    writeFileSync(this.emptyFile, "");

    if (this.config.agent === "claude" && !this.config.createContainers) {
      throw new Error(
        "agent=claude requires createContainers=true — LLM tool calls must execute inside the per-session sandbox container.",
      );
    }
    const agent: AgentRunner =
      this.config.agent === "claude"
        ? new ClaudeAgent({
            containers: this.podman,
            ...(this.config.agentModel ? { model: this.config.agentModel } : {}),
            ...(this.config.agentSystemPrompt
              ? { systemPrompt: this.config.agentSystemPrompt }
              : {}),
          })
        : new ScriptedAgent();
    this.loop = new AgentLoop({
      sessions: this.sm,
      agent,
      git: this.gm,
      sync: this.gs,
      repoRoot: this.config.repoRoot,
      additionalContextProviders: [statusContext.provider(), mainContext.provider()],
      publish: async (sid) => {
        const r = await this.publish(sid);
        return {
          ok: r.ok,
          ...(r.failure_reason ? { reason: r.failure_reason } : {}),
          ...(r.merge_sha ? { merge_sha: r.merge_sha } : {}),
          ...(r.changed_files ? { changed_files: r.changed_files } : {}),
        };
      },
      status: async (_sid, prompt, input) => {
        this.appendAgentStatus(
          prompt.session_id,
          prompt.user_id,
          prompt.chat_id,
          input.kind ?? "status",
          input.message,
        );
      },
      statusRead: async (sid, input) => this.readAgentStatus(sid, input),
    });

    this.merge = new MergeManager({
      sessions: this.sm,
      git: this.gm,
      sync: this.gs,
      audit: this.audit,
      repoRoot: this.config.repoRoot,
    });

    this.replay = new Replay(this.chat, this.audit);
    this.watcher = new FileWatcher({
      classify: classifyForPolicy,
      emit: (sessionId, changes) => {
        const ev: FilesChanged = {
          type: "files.changed",
          session_id: sessionId,
          changes,
        };
        this.relay.emit(ev);
      },
    });

    this.relay = new RelayClient(this.config.relayUrl, this.config.hostToken, (ev) =>
      this.handleEvent(ev),
    );
    this.relay.setHelloHandler((h) => this.handleHello(h));
    this.relay.setByeHandler((b) => this.handleBye(b));
    await this.relay.connect();

    this.admin = new AdminServer({
      port: this.config.adminPort,
      token: this.config.adminToken,
      handlers: {
        createSession: (i) => this.createSession(i),
        listSessions: () => this.listSessions(),
        issueInvite: (sid, i) => this.issueInvite(sid, i),
        publish: (sid) => this.publish(sid),
        delegate: (sid, i) => this.delegate(sid, i),
        endSession: (sid, i) => this.endSession(sid, i),
        listFiles: (sid) => this.listFiles(sid),
        readFile: (sid, p) => this.readFile(sid, p),
      },
    });
    const port = await this.admin.start();

    // Rehydrate any sessions left over from a prior daemon run. We only restore
    // worktree metadata + relay room membership; containers and file watchers
    // are created lazily when the first client socket connects (see
    // attachClient). A freshly-booted daemon has zero live sockets, so any row
    // previously marked "active" is demoted to "inactive" — it will flip back
    // to active when a client reconnects.
    const reh = new FixedRehydrator(this.sessions, this.gm, this.config.repoRoot);
    const report = reh.rehydrateActive();
    const now = new Date().toISOString();
    for (const s of report.rehydrated) {
      this.relay.join(s.session_id);
      if (s.status === "active") {
        this.sessions.setStatus(s.session_id, "inactive", now);
      }
    }

    return { adminPort: port };
  }

  async stop(): Promise<void> {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    this.liveSockets.clear();
    this.watcher?.stopAll();
    await this.admin?.stop();
    await this.relay?.close();
    this.db?.close();
  }

  private async createSession(input: CreateSessionInput): Promise<CreateSessionOutput> {
    const policy: PermissionPolicy = input.policy ?? DEFAULT_POLICY;
    const baseSha = this.gm.headSha(this.config.repoRoot);
    const s = this.sm.createSession({
      owner_user_id: input.owner_user_id,
      policy,
      base_main_sha: baseSha,
    });
    const wt = join(this.config.worktreesRoot, s.session_id);
    this.gm.createWorktree({
      repoRoot: this.config.repoRoot,
      branchName: s.branch_name,
      worktreePath: wt,
    });
    this.sm.deps.sessions.setWorktree(s.session_id, wt, new Date().toISOString());

    if (this.config.createContainers) {
      const plan = this.resolver.resolveMountPlan(wt, policy, {
        emptyFileHost: this.emptyFile,
        gitMetadataHost: this.gm.absoluteGitDir(this.config.repoRoot),
      });
      await this.podman.create(s.session_id, plan);
    }

    this.relay.join(s.session_id);
    this.watcher.watchSession(s.session_id, wt, policy);
    // Arm an idle timer so a session created via /api/join whose WS never
    // arrives (browser crash, network blip) doesn't leak a container.
    this.armIdleTimer(s.session_id);
    return { session_id: s.session_id, branch_name: s.branch_name, worktree_path: wt };
  }

  private async listSessions(): Promise<{ sessions: SessionSummary[] }> {
    const sessions = this.sessions
      .listAll()
      .filter((s) => s.status !== "ended")
      .map((s) => ({
        session_id: s.session_id,
        branch_name: s.branch_name,
        owner_user_id: s.owner_user_id,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        ...(s.last_head_sha ? { last_head_sha: s.last_head_sha } : {}),
      }));
    return { sessions };
  }

  private async issueInvite(
    sessionId: string,
    input: IssueInviteInput,
  ): Promise<IssueInviteOutput> {
    const role: Role = input.role;
    this.sm.joinSession(sessionId, input.user_id, role);
    const inviteToken = `inv_${randomUUID()}`;
    this.relay.registerInvite({
      token: inviteToken,
      claims: { session_id: sessionId, user_id: input.user_id, role },
    });
    let perUser = this.invitesBySession.get(sessionId);
    if (!perUser) {
      perUser = new Map();
      this.invitesBySession.set(sessionId, perUser);
    }
    const prior = perUser.get(input.user_id);
    if (prior) this.relay.revokeInvite(prior);
    perUser.set(input.user_id, inviteToken);
    const cap: Capability = this.sm.issueCapability(
      sessionId,
      input.user_id,
      role,
      role === "owner" ? ["prompt"] : ["observe"],
    );
    if (role === "owner") {
      this.appendAgentStatus(
        sessionId,
        input.user_id,
        input.chat_id,
        "join",
        input.chat_id
          ? `joined chat ${input.chat_id} in this shared session`
          : "joined this shared session",
      );
    }
    return { invite_token: inviteToken, capability: cap };
  }

  private appendAgentStatus(
    sessionId: string,
    userId: string,
    chatId: string | undefined,
    kind: string,
    message: string,
  ): void {
    const agentId = chatId ? `${userId}:${chatId}` : userId;
    this.agentStatus.append(sessionId, agentId, kind, message, {
      ...(chatId ? { chat_id: chatId } : {}),
    });
  }

  private readAgentStatus(
    sessionId: string,
    input: { after_feed_id?: number; limit?: number },
  ): string {
    const after = typeof input.after_feed_id === "number" && Number.isFinite(input.after_feed_id)
      ? Math.max(0, Math.floor(input.after_feed_id))
      : 0;
    const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.min(Math.max(Math.floor(input.limit), 1), 50)
      : 20;
    const rows = this.agentStatus.listSince(sessionId, after, limit);
    if (!rows.length) return `No shared status rows after feed_id=${after}.`;
    return rows
      .map((r) => {
        const chat = r.chat_id ? ` chat=${r.chat_id}` : "";
        return `[feed_id=${r.seq}] ${r.ts} agent=${r.agent_id}${chat} kind=${r.kind}: ${r.message}`;
      })
      .join("\n");
  }

  private async publish(
    sessionId: string,
  ): Promise<import("./merge/manager.js").PublishResult> {
    const session = this.sm.getSession(sessionId);
    if (!session) throw new Error("session_not_found");
    if (session.worktree_path) {
      const sha = this.gm.checkpoint(
        session.worktree_path,
        `checkpoint: pre-publish ${sessionId}`,
      );
      this.sm.deps.sessions.setHead(sessionId, sha, new Date().toISOString());
    }
    const result = await this.merge.publish(sessionId, (ev) => {
      const out: PublishStatus = {
        type: "publish.status",
        session_id: sessionId,
        phase: ev.phase,
        ok: ev.ok,
        ...(ev.detail ? { detail: ev.detail } : {}),
      };
      this.relay.emit(out);
    });
    // Keep the session branch tracking main: fast-forward the worktree so the
    // next checkpoint lands on top of the merge commit and a subsequent publish
    // doesn't re-validate already-merged history.
    if (result.ok) {
      const s = this.sm.getSession(sessionId);
      if (s?.worktree_path) {
        const ff = this.gm.syncBranchToMain(s.worktree_path);
        const sync: PublishStatus = {
          type: "publish.status",
          session_id: sessionId,
          phase: "done",
          ok: ff.code === 0,
          detail: ff.code === 0
            ? { synced: true, head: this.gm.headSha(s.worktree_path) }
            : { synced: false, error: ff.stderr },
        };
        this.relay.emit(sync);
      }
      // Fan the new main out to every other active session so concurrent
      // collaborators see the merged code without re-joining. ff-only keeps
      // sessions with their own in-progress commits stale (we warn via event
      // rather than rewriting their history); the FileWatcher emits
      // files.changed for each worktree that actually moved, which refreshes
      // their UIs.
      this.syncSiblingSessionsToMain(sessionId);
    }
    return result;
  }

  private syncSiblingSessionsToMain(publisherId: string): void {
    for (const status of ["active", "inactive"] as const) {
      for (const s of this.sessions.listByStatus(status)) {
        if (s.session_id === publisherId) continue;
        if (!s.worktree_path) continue;
        const ff = this.gm.syncBranchToMain(s.worktree_path);
        const ok = ff.code === 0;
        const head = ok ? this.gm.headSha(s.worktree_path) : undefined;
        const ev: PublishStatus = {
          type: "publish.status",
          session_id: s.session_id,
          phase: ok ? "done" : "failed",
          ok,
          detail: ok
            ? { synced: true, source: publisherId, head }
            : { synced: false, source: publisherId, reason: "non_ff", error: ff.stderr },
        };
        this.relay.emit(ev);
      }
    }
  }

  private async delegate(
    sessionId: string,
    input: DelegateInput,
  ): Promise<DelegateOutput> {
    this.sm.joinSession(sessionId, input.new_owner_user_id, "owner");
    const { new_epoch, cancelled_prompt_ids } = this.sm.delegateOwner(
      sessionId,
      input.new_owner_user_id,
    );
    // Revoke ALL prior invites in the session — capabilities tied to the old
    // epoch are now stale, and reader invites should be re-issued by the new owner.
    const perUser = this.invitesBySession.get(sessionId);
    if (perUser) {
      for (const tok of perUser.values()) this.relay.revokeInvite(tok);
      perUser.clear();
    }
    // Issue a fresh invite + capability for the new owner.
    const inviteToken = `inv_${randomUUID()}`;
    this.relay.registerInvite({
      token: inviteToken,
      claims: { session_id: sessionId, user_id: input.new_owner_user_id, role: "owner" },
    });
    if (!perUser) this.invitesBySession.set(sessionId, new Map([[input.new_owner_user_id, inviteToken]]));
    else perUser.set(input.new_owner_user_id, inviteToken);
    const cap = this.sm.issueCapability(sessionId, input.new_owner_user_id, "owner", ["prompt"]);
    const ev: OwnerChanged = {
      type: "owner.changed",
      session_id: sessionId,
      new_owner: input.new_owner_user_id,
      epoch: new_epoch,
    };
    this.relay.emit(ev);
    return { new_epoch, cancelled_prompt_ids, capability: cap };
  }

  private async endSession(
    sessionId: string,
    input: EndSessionInput,
  ): Promise<{ ok: true }> {
    const reason = input.reason ?? "ended";
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
    this.liveSockets.delete(sessionId);
    this.watcher.unwatch(sessionId);
    this.sm.endSession(sessionId, reason);
    if (this.config.createContainers) {
      try {
        await this.podman.destroy(sessionId);
      } catch {
        // container may already be gone; non-fatal
      }
    }
    const perUser = this.invitesBySession.get(sessionId);
    if (perUser) {
      for (const tok of perUser.values()) this.relay.revokeInvite(tok);
      this.invitesBySession.delete(sessionId);
    }
    const ev: SessionEnded = {
      type: "session.ended",
      session_id: sessionId,
      reason,
    };
    this.relay.emit(ev);
    this.relay.leave(sessionId);
    return { ok: true };
  }

  private async listFiles(sessionId: string): Promise<ListFilesOutput> {
    const s = this.sm.getSession(sessionId);
    if (!s || !s.worktree_path) return { files: [] };
    const wt = s.worktree_path;
    const out: { path: string; size: number; mode: "rw" | "ro" }[] = [];
    const walk = (relDir: string): void => {
      const abs = relDir === "" ? wt : join(wt, relDir);
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = relDir === "" ? e.name : posix.join(relDir, e.name);
        if (rel === ".git" || rel.startsWith(".git/")) continue;
        if (e.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        const cls = classifyForPolicy(rel, s.policy);
        if (!cls) continue; // deny / none → hidden
        let size = 0;
        try {
          size = statSync(join(wt, rel)).size;
        } catch {
          continue;
        }
        out.push({ path: rel, size, mode: cls });
      }
    };
    walk("");
    out.sort((a, b) => a.path.localeCompare(b.path));
    return { files: out };
  }

  private async readFile(sessionId: string, requested: string): Promise<ReadFileOutput> {
    const s = this.sm.getSession(sessionId);
    if (!s || !s.worktree_path) throw new Error("session_not_found");
    const wt = s.worktree_path;
    const abs = isAbsolute(requested) ? resolvePath(requested) : resolvePath(wt, requested);
    const rel = relative(wt, abs).split(sep).join("/");
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
      throw new Error("path_outside_worktree");
    }
    if (rel === ".git" || rel.startsWith(".git/")) throw new Error("denied");
    const cls = classifyForPolicy(rel, s.policy);
    if (!cls) throw new Error("denied");
    const MAX = 256 * 1024;
    const buf = readFileSync(abs);
    const truncated = buf.byteLength > MAX;
    const slice = truncated ? buf.subarray(0, MAX) : buf;
    return { path: rel, content: slice.toString("utf8"), truncated, mode: cls };
  }

  private handleHello(h: import("./relayClient.js").ClientHello): void {
    void this.attachClient(h.session_id, h.socket_id);
    const bundle = this.replay.bundle(h.session_id, {
      ...(h.since_chat_seq !== undefined ? { chat_seq: h.since_chat_seq } : {}),
      ...(h.since_event_seq !== undefined ? { event_seq: h.since_event_seq } : {}),
    }, h.chat_id ?? "default");
    this.relay.sendReplay(h.socket_id, bundle);
  }

  private handleBye(b: import("./relayClient.js").ClientBye): void {
    this.detachClient(b.session_id, b.socket_id);
  }

  // Add a client socket to the session's live set. If this is the first socket
  // for the session, cancel any pending idle teardown and lazily materialize
  // the per-session container + file watcher.
  private async attachClient(sessionId: string, socketId: string): Promise<void> {
    const s = this.sm.getSession(sessionId);
    if (!s || s.status === "ended") return;
    let set = this.liveSockets.get(sessionId);
    if (!set) {
      set = new Set();
      this.liveSockets.set(sessionId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socketId);
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
    if (!wasEmpty) return;
    if (s.status !== "active") {
      this.sessions.setStatus(sessionId, "active", new Date().toISOString());
    }
    if (!s.worktree_path) return;
    if (this.config.createContainers && !this.podman.has(sessionId)) {
      const plan = this.resolver.resolveMountPlan(s.worktree_path, s.policy, {
        emptyFileHost: this.emptyFile,
        gitMetadataHost: this.gm.absoluteGitDir(this.config.repoRoot),
      });
      try {
        await this.podman.create(sessionId, plan);
      } catch (e) {
        this.relay.emit({
          type: "error",
          session_id: sessionId,
          code: "container_create_failed",
          message: (e as Error).message,
        } satisfies ErrorEvent);
        return;
      }
    }
    if (!this.watcher.isWatching(sessionId)) {
      this.watcher.watchSession(sessionId, s.worktree_path, s.policy);
    }
  }

  // Remove a client socket. If the session is now empty, arm the idle timer.
  private detachClient(sessionId: string, socketId: string): void {
    const set = this.liveSockets.get(sessionId);
    if (!set) return;
    set.delete(socketId);
    if (set.size > 0) return;
    this.liveSockets.delete(sessionId);
    this.armIdleTimer(sessionId);
  }

  private armIdleTimer(sessionId: string): void {
    const prior = this.idleTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      void this.runIdle(sessionId);
    }, this.config.idleMs);
    // Don't hold the event loop open just for the teardown.
    if (typeof t.unref === "function") t.unref();
    this.idleTimers.set(sessionId, t);
  }

  // Fired when the idle timer elapses with zero live sockets — tear down the
  // container + watcher and mark the session inactive. Session row is kept so
  // a future client can re-attach.
  private async runIdle(sessionId: string): Promise<void> {
    if ((this.liveSockets.get(sessionId)?.size ?? 0) > 0) return;
    const s = this.sm.getSession(sessionId);
    if (!s || s.status === "ended") return;
    this.watcher.unwatch(sessionId);
    if (this.config.createContainers) {
      try {
        await this.podman.destroy(sessionId);
      } catch {
        // best-effort; container may already be gone
      }
    }
    this.sessions.setStatus(sessionId, "inactive", new Date().toISOString());
  }

  private async handleEvent(ev: ForwardedEvent): Promise<void> {
    try {
      if (ev.type === "agent.prompt") return await this.handlePrompt(ev);
      if (ev.type === "command.request") return await this.handleCommand(ev);
      if (ev.type === "chat.message") return this.handleChat(ev);
    } catch (e) {
      this.relay.emit({
        type: "error",
        session_id: ev.session_id,
        ...(ev.chat_id ? { chat_id: ev.chat_id } : {}),
        code: "internal",
        message: (e as Error).message,
      } satisfies ErrorEvent);
    }
  }

  private handleChat(ev: ChatMessage): void {
    this.chat.append(ev.session_id, ev.user_id, ev.text, ev.chat_id ?? "default");
    // Relay already broadcast it; we just persist for replay.
  }

  private async handlePrompt(ev: AgentPrompt): Promise<void> {
    const chatId = ev.chat_id ?? "default";
    const sub = this.sm.submitPrompt(ev.capability, ev.text, ev.prompt_id, chatId);
    if (!sub.ok) {
      this.relay.emit({
        type: "error",
        session_id: ev.session_id,
        chat_id: chatId,
        code: sub.reason,
        message: `prompt rejected: ${sub.reason}`,
      } satisfies ErrorEvent);
      return;
    }
    this.chat.append(ev.session_id, ev.capability.user_id, ev.text, chatId);
    this.appendAgentStatus(
      ev.session_id,
      ev.capability.user_id,
      chatId,
      "start",
      `started prompt: ${ev.text.slice(0, 120)}`,
    );
    const pending = this.sm.pendingPrompts(ev.session_id);
    const prompt = pending.find((p) => p.prompt_id === sub.prompt_id);
    if (!prompt) return;

    const emit = (data: string, done = false) => {
      const tok: AgentToken = {
        type: "agent.token",
        session_id: ev.session_id,
        chat_id: chatId,
        prompt_id: prompt.prompt_id,
        data,
        ...(done ? { done: true } : {}),
      };
      this.relay.emit(tok);
    };

    const result = await this.loop.runOne(ev.session_id, prompt, (e) => {
      // edit/command events are internal signalling only — the user-facing
      // tool_use/tool_result tile already carries that info with real status.
      if (e.kind === "token") emit(e.data);
      else if (e.kind === "done") emit("[done]", true);
      else if (e.kind === "edit") {
        this.appendAgentStatus(
          ev.session_id,
          ev.capability.user_id,
          chatId,
          "edit",
          `editing ${e.path}`,
        );
      } else if (e.kind === "command") {
        this.appendAgentStatus(
          ev.session_id,
          ev.capability.user_id,
          chatId,
          "command",
          `running ${e.argv.join(" ").slice(0, 160)}`,
        );
      }
    });
    this.appendAgentStatus(
      ev.session_id,
      ev.capability.user_id,
      chatId,
      "checkpoint",
      `checkpoint ${result.checkpoint_sha.slice(0, 8)} after prompt`,
    );
    emit(`[checkpoint ${result.checkpoint_sha.slice(0, 8)}]`);
  }

  private async handleCommand(ev: CommandRequest): Promise<void> {
    const v = this.sm.verifyCapability(ev.capability, "owner");
    if (!v.ok) {
      this.relay.emit({
        type: "error",
        session_id: ev.session_id,
        code: v.reason,
        message: `command rejected: ${v.reason}`,
      } satisfies ErrorEvent);
      return;
    }
    const s = this.sm.getSession(ev.session_id);
    if (!s) return;
    const cmd = ev.argv.join(" ");
    const allowed = s.policy.command_allow.some(
      (g) => cmd === g || cmd.startsWith(`${g} `) || minimatch(cmd, g),
    );
    if (!allowed) {
      this.relay.emit({
        type: "error",
        session_id: ev.session_id,
        code: "command_not_allowed",
        message: `not in command_allow: ${cmd}`,
      } satisfies ErrorEvent);
      return;
    }
    if (!this.config.createContainers) {
      this.relay.emit({
        type: "error",
        session_id: ev.session_id,
        code: "no_container",
        message: "container execution disabled",
      } satisfies ErrorEvent);
      return;
    }
    for await (const chunk of this.podman.exec(ev.session_id, ev.argv)) {
      const out: CommandOutput = {
        type: "command.output",
        session_id: ev.session_id,
        request_id: ev.request_id,
        stream: chunk.stream,
        data: chunk.data,
      };
      this.relay.emit(out);
    }
  }
}
