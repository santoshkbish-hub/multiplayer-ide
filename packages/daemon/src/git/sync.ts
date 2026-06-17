import { GitManager } from "./manager.js";

export interface SyncReport {
  base: string;
  mainAdvanced: boolean;
  mainChanged: string[];
  sessionChanged: string[];
  overlap: string[];
  stale: boolean;
}

export interface SyncCheckArgs {
  repoRoot: string;
  branchName: string;
  mainRef?: string;
}

export class GitSync {
  constructor(private git: GitManager = new GitManager()) {}

  check(args: SyncCheckArgs): SyncReport {
    const mainRef = args.mainRef ?? "main";
    const base = this.git.mergeBase(args.repoRoot, args.branchName, mainRef);
    const mainHead = this.git.headSha(args.repoRoot, mainRef);
    const sessionHead = this.git.headSha(args.repoRoot, args.branchName);
    const mainAdvanced = base !== mainHead;
    const mainChanged = mainAdvanced
      ? this.git.changedFiles(args.repoRoot, base, mainRef)
      : [];
    const sessionChanged =
      base !== sessionHead
        ? this.git.changedFiles(args.repoRoot, base, args.branchName)
        : [];
    const mainSet = new Set(mainChanged);
    const overlap = sessionChanged.filter((f) => mainSet.has(f));
    return {
      base,
      mainAdvanced,
      mainChanged,
      sessionChanged,
      overlap,
      stale: mainAdvanced && overlap.length > 0,
    };
  }
}
