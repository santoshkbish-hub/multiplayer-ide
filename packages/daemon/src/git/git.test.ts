import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitManager, git } from "./manager.js";
import { GitSync } from "./sync.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-git-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@local"]);
  mustGit(root, ["config", "user.name", "test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "README.md"), "# hi\n");
  mustGit(root, ["add", "-A"]);
  mustGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

describe("GitManager + GitSync M3", () => {
  let repo: string;
  let gm: GitManager;
  let sync: GitSync;
  beforeEach(() => {
    repo = makeRepo();
    gm = new GitManager();
    sync = new GitSync(gm);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates a worktree on a fresh branch, allows checkpoints, reclaims, and resumes", () => {
    const wt = join(repo, "..", `wt-${Date.now()}`);
    const branch = "collab/session-test";
    gm.createWorktree({ repoRoot: repo, branchName: branch, worktreePath: wt });
    expect(gm.branchExists(repo, branch)).toBe(true);

    // edit and checkpoint
    writeFileSync(join(wt, "src/a.ts"), "export const a = 11;\n");
    const sha1 = gm.checkpoint(wt, "checkpoint: change a");
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);

    // reclaim
    gm.removeWorktree(repo, wt);

    // resume
    gm.resumeWorktree(repo, branch, wt);
    expect(gm.headSha(wt)).toBe(sha1);

    rmSync(wt, { recursive: true, force: true });
  });

  it("syncCheck flags stale when main advances on an overlapping file", () => {
    const wt = join(repo, "..", `wt-${Date.now()}-1`);
    const branch = "collab/session-overlap";
    gm.createWorktree({ repoRoot: repo, branchName: branch, worktreePath: wt });

    // session edits src/a.ts
    writeFileSync(join(wt, "src/a.ts"), "export const a = 100;\n");
    gm.checkpoint(wt, "session: a -> 100");

    // main edits src/a.ts independently
    mustGit(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 999;\n");
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-q", "-m", "main: a -> 999"]);

    const rep = sync.check({ repoRoot: repo, branchName: branch });
    expect(rep.mainAdvanced).toBe(true);
    expect(rep.overlap).toEqual(["src/a.ts"]);
    expect(rep.stale).toBe(true);

    rmSync(wt, { recursive: true, force: true });
  });

  it("syncCheck is not stale when main advances on a non-overlapping file", () => {
    const wt = join(repo, "..", `wt-${Date.now()}-2`);
    const branch = "collab/session-clean";
    gm.createWorktree({ repoRoot: repo, branchName: branch, worktreePath: wt });

    writeFileSync(join(wt, "src/a.ts"), "export const a = 7;\n");
    gm.checkpoint(wt, "session: a");

    mustGit(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "src/b.ts"), "export const b = 22;\n");
    mustGit(repo, ["add", "-A"]);
    mustGit(repo, ["commit", "-q", "-m", "main: b"]);

    const rep = sync.check({ repoRoot: repo, branchName: branch });
    expect(rep.mainAdvanced).toBe(true);
    expect(rep.overlap).toEqual([]);
    expect(rep.stale).toBe(false);

    rmSync(wt, { recursive: true, force: true });
  });
});
