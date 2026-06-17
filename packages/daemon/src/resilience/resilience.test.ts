import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PermissionPolicy } from "@collab/shared";
import { openDb } from "../store/db.js";
import { SessionRepo } from "../store/sessions.js";
import { AuditRepo } from "../store/audit.js";
import { ChatRepo } from "../store/chat.js";
import { CapabilityIssuer } from "../session/capability.js";
import { SessionManager } from "../session/manager.js";
import { GitManager, git } from "../git/manager.js";
import { FixedRehydrator } from "./rehydrate.js";
import { Replay } from "./replay.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-resi-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@local"]);
  mustGit(root, ["config", "user.name", "test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/foo.ts"), "export const foo = 1;\n");
  mustGit(root, ["add", "-A"]);
  mustGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

const POLICY: PermissionPolicy = {
  read_allow: ["**"],
  write_allow: ["src/**"],
  deny: [".env*"],
  command_allow: [],
  network: "none",
};

describe("Resilience M7", () => {
  let repo: string;
  let dbPath: string;
  beforeEach(() => {
    repo = makeRepo();
    dbPath = join(repo, "..", `db-${Date.now()}.sqlite`);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    try { rmSync(dbPath); } catch {}
  });

  it("resumes a session after a daemon restart by re-materializing the worktree", () => {
    // First "daemon process": create session, materialize, commit, then reclaim worktree.
    const db1 = openDb(dbPath);
    const sessions1 = new SessionRepo(db1);
    const audit1 = new AuditRepo(db1);
    const sm1 = new SessionManager({
      sessions: sessions1,
      audit: audit1,
      caps: new CapabilityIssuer(randomBytes(32)),
    });
    const gm = new GitManager();

    const s = sm1.createSession({
      owner_user_id: "alice",
      policy: POLICY,
      base_main_sha: gm.headSha(repo),
    });
    const wt = join(repo, "..", `wt-${s.session_id}`);
    gm.createWorktree({ repoRoot: repo, branchName: s.branch_name, worktreePath: wt });
    sm1.deps.sessions.setWorktree(s.session_id, wt, new Date().toISOString());

    writeFileSync(join(wt, "src/foo.ts"), "export const foo = 555;\n");
    const sha = gm.checkpoint(wt, "before restart");
    sm1.deps.sessions.setHead(s.session_id, sha, new Date().toISOString());

    // Simulate container/worktree reclaim — but keep durable branch.
    gm.removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    db1.close();

    // "Restart" — fresh process opens the same db.
    const db2 = openDb(dbPath);
    const sessions2 = new SessionRepo(db2);
    const reh = new FixedRehydrator(sessions2, gm, repo);
    const report = reh.rehydrateActive();
    expect(report.rehydrated.find((r) => r.session_id === s.session_id)).toBeDefined();
    expect(report.recreated_worktrees).toContain(wt);
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "src/foo.ts"), "utf8")).toContain("foo = 555");

    rmSync(wt, { recursive: true, force: true });
    db2.close();
  });

  it("replay bundles chat + audit events since a cursor", () => {
    const db = openDb(dbPath);
    const sessions = new SessionRepo(db);
    const audit = new AuditRepo(db);
    const chat = new ChatRepo(db);
    const sm = new SessionManager({
      sessions,
      audit,
      caps: new CapabilityIssuer(randomBytes(32)),
    });
    const replay = new Replay(chat, audit);

    const s = sm.createSession({
      owner_user_id: "alice",
      policy: POLICY,
      base_main_sha: "abc",
    });

    chat.append(s.session_id, "alice", "hello");
    chat.append(s.session_id, "bob", "hi");
    audit.append(s.session_id, "alice", "prompt", { x: 1 });

    const full = replay.bundle(s.session_id);
    // owner_changed audit from createSession + the prompt above
    expect(full.events.length).toBeGreaterThanOrEqual(2);
    expect(full.chat.map((c) => c.text)).toEqual(["hello", "hi"]);
    expect(full.cursor.chat_seq).toBe(2);

    chat.append(s.session_id, "alice", "later");
    audit.append(s.session_id, "alice", "prompt", { x: 2 });

    const since = replay.bundle(s.session_id, full.cursor);
    expect(since.chat.map((c) => c.text)).toEqual(["later"]);
    expect(since.events).toHaveLength(1);

    db.close();
  });
});
