import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitManager, git } from "../git/manager.js";
import { MainDiffContextProvider } from "./mainContext.js";

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "collab-main-context-"));
  mustGit(root, ["init", "-q", "-b", "main"]);
  mustGit(root, ["config", "user.email", "test@local"]);
  mustGit(root, ["config", "user.name", "test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/foo.ts"), "export const foo = 1;\n");
  writeFileSync(join(root, "src/bar.ts"), "export const bar = 1;\n");
  mustGit(root, ["add", "-A"]);
  mustGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

describe("MainDiffContextProvider", () => {
  it("compares a session branch to main on demand and suppresses duplicate notices", () => {
    const repo = makeRepo();
    const wt = join(repo, "..", `wt-${Date.now()}`);
    const gm = new GitManager();
    const branchName = "collab/session-test";
    try {
      gm.createWorktree({ repoRoot: repo, branchName, worktreePath: wt });

      writeFileSync(join(wt, "src/foo.ts"), "export const foo = 2;\n");
      gm.checkpoint(wt, "session edit foo");

      writeFileSync(join(repo, "src/foo.ts"), "export const foo = 3;\n");
      writeFileSync(join(repo, "src/bar.ts"), "export const bar = 4;\n");
      mustGit(repo, ["add", "-A"]);
      mustGit(repo, ["commit", "-q", "-m", "main edit"]);

      const provider = new MainDiffContextProvider({
        repoRoot: repo,
        git: gm,
        getBranchName: (sessionId) => (sessionId === "sess_1" ? branchName : null),
      });
      const first = provider.getContext("sess_1");
      const second = provider.getContext("sess_1");

      expect(first).toContain("Your session worktree is isolated");
      expect(first).toContain("diverged from main at");
      expect(first).toContain("src/bar.ts, src/foo.ts");
      expect(first).toContain("overlap with your session changes: src/foo.ts");
      expect(first).toContain("check whether the listed main changes affect your task");
      expect(first).toContain("git diff");
      expect(second).toBeNull();
    } finally {
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {}
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null when main has not advanced", () => {
    const repo = makeRepo();
    const wt = join(repo, "..", `wt-${Date.now()}`);
    const gm = new GitManager();
    const branchName = "collab/session-clean";
    try {
      gm.createWorktree({ repoRoot: repo, branchName, worktreePath: wt });
      const provider = new MainDiffContextProvider({
        repoRoot: repo,
        git: gm,
        getBranchName: () => branchName,
      });
      expect(provider.getContext("sess_1")).toBeNull();
    } finally {
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {}
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
