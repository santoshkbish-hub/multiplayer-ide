import { spawnSync } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export interface CreateWorktreeArgs {
  repoRoot: string;
  branchName: string;
  worktreePath: string;
  baseRef?: string;
}

export class GitManager {
  headSha(repoRoot: string, ref = "HEAD"): string {
    return mustGit(repoRoot, ["rev-parse", ref]);
  }

  absoluteGitDir(repoRoot: string): string {
    return mustGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  }

  branchExists(repoRoot: string, branch: string): boolean {
    return git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]).code === 0;
  }

  createWorktree(args: CreateWorktreeArgs): void {
    const base = args.baseRef ?? "main";
    mustGit(args.repoRoot, [
      "worktree",
      "add",
      "-b",
      args.branchName,
      args.worktreePath,
      base,
    ]);
  }

  removeWorktree(repoRoot: string, worktreePath: string): void {
    mustGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  }

  resumeWorktree(repoRoot: string, branchName: string, worktreePath: string): void {
    mustGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
  }

  checkpoint(worktreePath: string, message: string): string {
    mustGit(worktreePath, ["add", "-A"]);
    const status = git(worktreePath, ["status", "--porcelain"]).stdout;
    if (status === "") {
      // Nothing to commit; return current HEAD.
      return this.headSha(worktreePath);
    }
    mustGit(worktreePath, [
      "-c",
      "user.email=daemon@local",
      "-c",
      "user.name=collab-daemon",
      "commit",
      "-m",
      message,
    ]);
    return this.headSha(worktreePath);
  }

  changedFiles(repoRoot: string, fromRef: string, toRef: string): string[] {
    const out = mustGit(repoRoot, ["diff", "--name-only", `${fromRef}..${toRef}`]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  mergeBase(repoRoot: string, a: string, b: string): string {
    return mustGit(repoRoot, ["merge-base", a, b]);
  }

  // Fast-forwards the branch checked out in `worktreePath` to `mainRef`.
  // Used after a publish lands so the session branch keeps tracking main and
  // the next checkpoint is rooted on the merge commit.
  syncBranchToMain(worktreePath: string, mainRef = "main"): GitResult {
    return git(worktreePath, ["merge", "--ff-only", mainRef]);
  }
}
