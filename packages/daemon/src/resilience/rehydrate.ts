import { existsSync } from "node:fs";
import type { Session } from "@collab/shared";
import { GitManager } from "../git/manager.js";
import { SessionRepo } from "../store/sessions.js";

export interface RehydrateReport {
  rehydrated: Session[];
  recreated_worktrees: string[];
  skipped: Array<{ session_id: string; reason: string }>;
}

export class Rehydrator {
  constructor(private sessions: SessionRepo, private git: GitManager) {}

  rehydrateActive(): RehydrateReport {
    const out: RehydrateReport = { rehydrated: [], recreated_worktrees: [], skipped: [] };
    for (const status of ["active", "inactive", "stale"] as const) {
      for (const s of this.sessions.listByStatus(status)) {
        if (!s.worktree_path) {
          out.skipped.push({ session_id: s.session_id, reason: "no_worktree_path" });
          continue;
        }
        if (existsSync(s.worktree_path)) {
          out.rehydrated.push(s);
          continue;
        }
        try {
          // Worktree was reclaimed — branch is durable, re-materialize.
          this.git.resumeWorktree(this.repoRootFor(s), s.branch_name, s.worktree_path);
          out.rehydrated.push(s);
          out.recreated_worktrees.push(s.worktree_path);
        } catch (e) {
          out.skipped.push({ session_id: s.session_id, reason: (e as Error).message });
        }
      }
    }
    return out;
  }

  // For the prototype the repo root is the parent of the worktrees dir;
  // tests inject this via subclass. Real daemon will pass it in.
  protected repoRootFor(_s: Session): string {
    throw new Error("repoRootFor must be provided");
  }
}

export class FixedRehydrator extends Rehydrator {
  constructor(sessions: SessionRepo, git: GitManager, private repoRoot: string) {
    super(sessions, git);
  }
  protected override repoRootFor(_s: Session): string {
    return this.repoRoot;
  }
}
