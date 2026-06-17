import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PermissionPolicy } from "@collab/shared";
import { openDb } from "../store/db.js";
import { SessionRepo } from "../store/sessions.js";
import { AuditRepo } from "../store/audit.js";
import { CapabilityIssuer } from "../session/capability.js";
import { SessionManager } from "../session/manager.js";
import { GitManager, git } from "../git/manager.js";
import { GitSync } from "../git/sync.js";
import { ScriptedAgent } from "./scripted.js";
import { AgentLoop } from "./loop.js";
import type { AgentContext, AgentEvent, AgentRunner } from "./runner.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-loop-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@local"]);
  mustGit(root, ["config", "user.name", "test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/foo.ts"), "export const foo = 1;\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  writeFileSync(join(root, ".env"), "SECRET=1");
  mustGit(root, ["add", "-A"]);
  mustGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

const POLICY: PermissionPolicy = {
  read_allow: ["**"],
  write_allow: ["src/**"],
  deny: [".env*"],
  command_allow: ["npm test"],
  network: "none",
};

describe("AgentLoop M5", () => {
  let repo: string;
  let wt: string;
  let sm: SessionManager;
  let loop: AgentLoop;
  let gm: GitManager;

  beforeEach(() => {
    repo = makeRepo();
    gm = new GitManager();
    const db = openDb(":memory:");
    sm = new SessionManager({
      sessions: new SessionRepo(db),
      audit: new AuditRepo(db),
      caps: new CapabilityIssuer(randomBytes(32)),
    });
    loop = new AgentLoop({
      sessions: sm,
      agent: new ScriptedAgent(),
      git: gm,
      sync: new GitSync(gm),
      repoRoot: repo,
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (wt) rmSync(wt, { recursive: true, force: true });
  });

  function bootSession() {
    const session = sm.createSession({
      owner_user_id: "alice",
      policy: POLICY,
      base_main_sha: gm.headSha(repo),
    });
    wt = join(repo, "..", `wt-${session.session_id}`);
    gm.createWorktree({
      repoRoot: repo,
      branchName: session.branch_name,
      worktreePath: wt,
    });
    // Materialize the worktree path in the session record.
    // (Direct repo access for the test — daemon wiring will own this.)
    (sm as unknown as { deps: { sessions: SessionRepo } }).deps.sessions.setWorktree(
      session.session_id,
      wt,
      new Date().toISOString(),
    );
    return sm.getSession(session.session_id)!;
  }

  it("an owner prompt drives an allowed edit and a checkpoint commit lands", async () => {
    const s = bootSession();
    const cap = sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    sm.submitPrompt(
      cap,
      JSON.stringify({
        actions: [
          { type: "say", text: "editing foo" },
          { type: "edit", path: "src/foo.ts", content: "export const foo = 42;\n" },
        ],
      }),
    );
    const pending = sm.pendingPrompts(s.session_id);
    const result = await loop.runOne(s.session_id, pending[0]!);

    expect(result.events.some((e) => e.kind === "edit" && e.ok)).toBe(true);
    expect(readFileSync(join(wt, "src/foo.ts"), "utf8")).toContain("foo = 42");
    expect(result.checkpoint_sha).toMatch(/^[0-9a-f]{40}$/);
    // Branch HEAD now equals the checkpoint
    expect(gm.headSha(repo, s.branch_name)).toBe(result.checkpoint_sha);
  });

  it("an attempt to edit a denied path fails and the host file is untouched", async () => {
    const s = bootSession();
    const cap = sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    sm.submitPrompt(
      cap,
      JSON.stringify({
        actions: [
          { type: "edit", path: ".env", content: "PWNED=1" },
          { type: "edit", path: "README.md", content: "rewrite" },
        ],
      }),
    );
    const pending = sm.pendingPrompts(s.session_id);
    const result = await loop.runOne(s.session_id, pending[0]!);

    const editEvents = result.events.filter((e) => e.kind === "edit") as Array<{
      kind: "edit";
      path: string;
      ok: boolean;
      reason?: string;
    }>;
    const envEv = editEvents.find((e) => e.path === ".env");
    const readmeEv = editEvents.find((e) => e.path === "README.md");
    expect(envEv?.ok).toBe(false);
    expect(envEv?.reason).toBe("denied");
    expect(readmeEv?.ok).toBe(false);
    expect(readmeEv?.reason).toBe("not_writable");
    // host file untouched
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1");
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("# hi\n");
  });

  it("passes chat-scoped status write/read callbacks into the agent", async () => {
    const s = bootSession();
    const cap = sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    sm.submitPrompt(cap, "coordinate", "p_status", "chat_a");
    const statusWrites: Array<{
      sessionId: string;
      promptChatId?: string;
      kind?: string;
      message: string;
    }> = [];
    const statusReads: Array<{ sessionId: string; after_feed_id?: number; limit?: number }> = [];
    class StatusAgent implements AgentRunner {
      async *run(ctx: AgentContext): AsyncIterable<AgentEvent> {
        await ctx.reportStatus?.({ kind: "plan", message: `working in ${ctx.chat_id}` });
        const feed = await ctx.readStatusFeed?.({ after_feed_id: 4, limit: 2 });
        yield { kind: "token", data: feed ?? "" };
        yield { kind: "done" };
      }
    }
    const statusLoop = new AgentLoop({
      sessions: sm,
      agent: new StatusAgent(),
      git: gm,
      sync: new GitSync(gm),
      repoRoot: repo,
      status: async (sessionId, prompt, input) => {
        statusWrites.push({
          sessionId,
          promptChatId: prompt.chat_id,
          kind: input.kind,
          message: input.message,
        });
      },
      statusRead: async (sessionId, input) => {
        statusReads.push({ sessionId, ...input });
        return "feed rows";
      },
    });

    const result = await statusLoop.runOne(s.session_id, sm.pendingPrompts(s.session_id)[0]!);

    expect(statusWrites).toEqual([
      {
        sessionId: s.session_id,
        promptChatId: "chat_a",
        kind: "plan",
        message: "working in chat_a",
      },
    ]);
    expect(statusReads).toEqual([
      { sessionId: s.session_id, after_feed_id: 4, limit: 2 },
    ]);
    expect(result.events.some((e) => e.kind === "token" && e.data === "feed rows")).toBe(true);
  });
});
