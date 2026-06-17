import type { AdditionalContextProvider } from "./contextHooks.js";
import { GitManager } from "../git/manager.js";
import { GitSync } from "../git/sync.js";

export interface MainDiffContextDeps {
  repoRoot: string;
  getBranchName: (sessionId: string) => string | null;
  git?: GitManager;
  sync?: GitSync;
}

export class MainDiffContextProvider {
  private git: GitManager;
  private sync: GitSync;
  private notified = new Map<string, string>();

  constructor(private deps: MainDiffContextDeps) {
    this.git = deps.git ?? new GitManager();
    this.sync = deps.sync ?? new GitSync(this.git);
  }

  provider(): AdditionalContextProvider {
    return ({ session_id }) => this.getContext(session_id);
  }

  getContext(sessionId: string): string | null {
    const branchName = this.deps.getBranchName(sessionId);
    if (!branchName) return null;
    const report = this.sync.check({
      repoRoot: this.deps.repoRoot,
      branchName,
    });
    if (!report.mainAdvanced) {
      this.notified.delete(sessionId);
      return null;
    }
    const mainHead = this.git.headSha(this.deps.repoRoot, "main");
    const key = `${report.base}:${mainHead}:${report.mainChanged.join("\0")}:${report.overlap.join("\0")}`;
    if (this.notified.get(sessionId) === key) return null;
    this.notified.set(sessionId, key);
    return formatReport({
      base: report.base,
      mainHead,
      mainChanged: report.mainChanged,
      overlap: report.overlap,
    });
  }
}

interface FormatInput {
  base: string;
  mainHead: string;
  mainChanged: string[];
  overlap: string[];
}

function formatReport(input: FormatInput): string {
  const lines = [
    "Collaborative main-branch notice:",
    "- Your session worktree is isolated; other sessions may have published to `main` while you were working.",
    `- current comparison: your session branch diverged from main at ${short(input.base)}; main is now ${short(input.mainHead)}.`,
    `- files changed on main: ${formatFiles(input.mainChanged)}`,
  ];
  if (input.overlap.length > 0) {
    lines.push(`- overlap with your session changes: ${formatFiles(input.overlap)}`);
  }
  lines.push(
    "Before editing or publishing, check whether the listed main changes affect your task. If relevant, inspect on demand with `git show --stat main`, `git show --name-only main`, or `git diff " +
      `${short(input.base)}..main -- <path>` +
      "`. Do not inspect unrelated main changes by default.",
  );
  return lines.join("\n");
}

function formatFiles(files: string[]): string {
  return files.length ? files.join(", ") : "(none)";
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
