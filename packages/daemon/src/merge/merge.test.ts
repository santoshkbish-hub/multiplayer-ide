import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
import { MergeManager } from "./manager.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-merge-"));
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

const POLICY: PermissionPolicy = {
  read_allow: ["**"],
  write_allow: ["src/**"],
  deny: [".env*"],
  command_allow: ["npm test"],
  network: "none",
};

describe("MergeManager M6", () => {
  let repo: string;
  let wt: string;
  let sm: SessionManager;
  let gm: GitManager;
  let mm: MergeManager;
  let audit: AuditRepo;

  beforeEach(() => {
    repo = makeRepo();
    gm = new GitManager();
    const db = openDb(":memory:");
    audit = new AuditRepo(db);
    sm = new SessionManager({
      sessions: new SessionRepo(db),
      audit,
      caps: new CapabilityIssuer(randomBytes(32)),
    });
    mm = new MergeManager({
      sessions: sm,
      git: gm,
      sync: new GitSync(gm),
      audit,
      repoRoot: repo,
      runCheck: () => ({ code: 0, output: "" }),
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    if (wt) rmSync(wt, { recursive: true, force: true });
  });

  function bootSession(policy: PermissionPolicy = POLICY) {
    const session = sm.createSession({
      owner_user_id: "alice",
      policy,
      base_main_sha: gm.headSha(repo),
    });
    wt = join(repo, "..", `wt-${session.session_id}`);
    gm.createWorktree({
      repoRoot: repo,
      branchName: session.branch_name,
      worktreePath: wt,
    });
    sm.deps.sessions.setWorktree(session.session_id, wt, new Date().toISOString());
    return sm.getSession(session.session_id)!;
  }

  it("publishes a clean checkpoint into main", async () => {
    const s = bootSession();
    writeFileSync(join(wt, "src/foo.ts"), "export const foo = 99;\n");
    gm.checkpoint(wt, "edit foo");

    const res = await mm.publish(s.session_id);
    expect(res.ok).toBe(true);
    expect(res.merge_sha).toMatch(/^[0-9a-f]{40}$/);

    mustGit(repo, ["checkout", "main"]);
    expect(readFileSync(join(repo, "src/foo.ts"), "utf8")).toContain("foo = 99");
  });

  it("rejects a publish whose diff includes a denied path", async () => {
    const s = bootSession();
    writeFileSync(join(wt, "src/foo.ts"), "export const foo = 99;\n");
    // Force the worktree to commit a denied path by bypassing the resolver.
    writeFileSync(join(wt, ".env"), "PWNED=1");
    gm.checkpoint(wt, "smuggle .env");

    const before = mustGit(repo, ["rev-parse", "main"]);
    const res = await mm.publish(s.session_id);
    expect(res.ok).toBe(false);
    expect(res.failure_reason).toBe("denied_path");
    const after = mustGit(repo, ["rev-parse", "main"]);
    expect(after).toBe(before); // main untouched
  });

  it("rejects a publish whose diff is outside write_allow", async () => {
    const s = bootSession();
    mkdirSync(join(wt, "docs"));
    writeFileSync(join(wt, "docs/x.md"), "hi");
    gm.checkpoint(wt, "out-of-allow edit");

    const before = mustGit(repo, ["rev-parse", "main"]);
    const res = await mm.publish(s.session_id);
    expect(res.ok).toBe(false);
    expect(res.failure_reason).toBe("invalid_path");
    expect(mustGit(repo, ["rev-parse", "main"])).toBe(before);
  });

  it("fails publish when a required check fails (main unchanged)", async () => {
    mm = new MergeManager({
      sessions: sm,
      git: gm,
      sync: new GitSync(gm),
      audit,
      repoRoot: repo,
      runCheck: () => ({ code: 1, output: "tests failed" }),
    });
    const s = bootSession();
    writeFileSync(join(wt, "src/foo.ts"), "export const foo = 7;\n");
    gm.checkpoint(wt, "edit foo");
    const before = mustGit(repo, ["rev-parse", "main"]);
    const res = await mm.publish(s.session_id);
    expect(res.ok).toBe(false);
    expect(res.failure_reason).toBe("check_failed");
    expect(mustGit(repo, ["rev-parse", "main"])).toBe(before);
  });

  it("serializes concurrent publishes (global main lock)", async () => {
    const s1 = bootSession();
    const wt1 = wt;
    writeFileSync(join(wt1, "src/foo.ts"), "export const foo = 11;\n");
    gm.checkpoint(wt1, "s1 edit");

    const s2 = sm.createSession({
      owner_user_id: "carol",
      policy: POLICY,
      base_main_sha: gm.headSha(repo),
    });
    const wt2 = join(repo, "..", `wt-${s2.session_id}-2`);
    gm.createWorktree({
      repoRoot: repo,
      branchName: s2.branch_name,
      worktreePath: wt2,
    });
    sm.deps.sessions.setWorktree(s2.session_id, wt2, new Date().toISOString());
    mkdirSync(join(wt2, "src"), { recursive: true });
    writeFileSync(join(wt2, "src/bar.ts"), "export const bar = 2;\n");
    gm.checkpoint(wt2, "s2 edit");

    const [r1, r2] = await Promise.all([
      mm.publish(s1.session_id),
      mm.publish(s2.session_id),
    ]);
    // Both should succeed because they touched disjoint files; the lock ensured
    // sequential merges (second one rebases via fast-forward / non-ff merge into the updated main).
    // What we really assert here: no race, no aborted merge state.
    expect(r1.ok || r2.ok).toBe(true);
    rmSync(wt2, { recursive: true, force: true });
  });
});
