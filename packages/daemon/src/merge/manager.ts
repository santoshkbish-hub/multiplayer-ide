import { Mutex } from "async-mutex";
import { minimatch } from "minimatch";
import type { PermissionPolicy } from "@collab/shared";
import { GitManager, git } from "../git/manager.js";
import { GitSync } from "../git/sync.js";
import type { SessionManager } from "../session/manager.js";
import type { AuditRepo } from "../store/audit.js";

export type PublishPhase =
  | "start"
  | "sync"
  | "validate"
  | "checks"
  | "merge"
  | "done"
  | "failed";

export interface PublishEvent {
  phase: PublishPhase;
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface PublishResult {
  ok: boolean;
  failure_reason?:
    | "stale"
    | "invalid_path"
    | "denied_path"
    | "check_failed"
    | "merge_conflict"
    | "nothing_to_publish";
  merge_sha?: string;
  events: PublishEvent[];
  changed_files: string[];
}

export interface MergeDeps {
  sessions: SessionManager;
  git: GitManager;
  sync: GitSync;
  audit: AuditRepo;
  repoRoot: string;
  runCheck?: (cwd: string, argv: string[]) => { code: number; output: string };
}

export type PublishObserver = (ev: PublishEvent) => void;

export class MergeManager {
  private lock = new Mutex();

  constructor(private deps: MergeDeps) {}

  async publish(sessionId: string, observe?: PublishObserver): Promise<PublishResult> {
    return this.lock.runExclusive(async () => this.publishUnderLock(sessionId, observe));
  }

  private publishUnderLock(sessionId: string, observe?: PublishObserver): PublishResult {
    const events: PublishEvent[] = [];
    const emit = (phase: PublishPhase, ok: boolean, detail?: Record<string, unknown>) => {
      const ev: PublishEvent = { phase, ok, detail };
      events.push(ev);
      observe?.(ev);
    };

    emit("start", true);

    const s = this.deps.sessions.getSession(sessionId);
    if (!s) throw new Error("session_not_found");
    const policy = s.policy;

    // Phase: sync
    const report = this.deps.sync.check({
      repoRoot: this.deps.repoRoot,
      branchName: s.branch_name,
    });
    if (report.stale) {
      emit("sync", false, { overlap: report.overlap });
      emit("failed", false, { reason: "stale" });
      this.deps.audit.append(sessionId, "system", "error", { phase: "sync", overlap: report.overlap });
      return { ok: false, failure_reason: "stale", events, changed_files: report.sessionChanged };
    }
    emit("sync", true, { base: report.base });

    // Phase: validate
    const changed = this.deps.git.changedFiles(this.deps.repoRoot, report.base, s.branch_name);
    if (changed.length === 0) {
      // Guard against silent no-op publishes — these were previously
      // possible when the agent wrote files inside the container but the
      // write never landed on the host worktree (e.g. /work was a podman
      // stub, not a bind mount). Now we fail loudly so the agent sees a
      // real error and can re-emit the write, instead of declaring success
      // with main unchanged.
      emit("validate", false, { reason: "nothing_to_publish" });
      emit("failed", false, { reason: "nothing_to_publish" });
      this.deps.audit.append(sessionId, "system", "error", {
        phase: "validate",
        reason: "nothing_to_publish",
      });
      return {
        ok: false,
        failure_reason: "nothing_to_publish",
        events,
        changed_files: changed,
      };
    }
    const bad = validateAgainstPolicy(changed, policy);
    if (bad.length > 0) {
      emit("validate", false, { bad });
      const reason = bad.some((b) => b.kind === "denied") ? "denied_path" : "invalid_path";
      emit("failed", false, { reason });
      this.deps.audit.append(sessionId, "system", "error", { phase: "validate", bad });
      return { ok: false, failure_reason: reason, events, changed_files: changed };
    }
    emit("validate", true, { changed });

    // Phase: required checks
    const checkFn = this.deps.runCheck;
    if (checkFn && s.worktree_path) {
      for (const cmd of policy.command_allow) {
        if (!isCheckCommand(cmd)) continue;
        const argv = cmd.split(/\s+/);
        const r = checkFn(s.worktree_path, argv);
        if (r.code !== 0) {
          emit("checks", false, { cmd, code: r.code });
          emit("failed", false, { reason: "check_failed", cmd });
          this.deps.audit.append(sessionId, "system", "error", { phase: "checks", cmd, code: r.code });
          return { ok: false, failure_reason: "check_failed", events, changed_files: changed };
        }
      }
    }
    emit("checks", true);

    // Phase: merge
    const co = git(this.deps.repoRoot, ["checkout", "main"]);
    if (co.code !== 0) {
      emit("merge", false, { stderr: co.stderr });
      emit("failed", false, { reason: "merge_conflict" });
      return { ok: false, failure_reason: "merge_conflict", events, changed_files: changed };
    }
    const merge = git(this.deps.repoRoot, [
      "-c",
      "user.email=daemon@local",
      "-c",
      "user.name=collab-daemon",
      "merge",
      "--no-ff",
      "-m",
      `merge ${s.branch_name}`,
      s.branch_name,
    ]);
    if (merge.code !== 0) {
      // Abort to leave main untouched.
      git(this.deps.repoRoot, ["merge", "--abort"]);
      emit("merge", false, { stderr: merge.stderr });
      emit("failed", false, { reason: "merge_conflict" });
      this.deps.audit.append(sessionId, "system", "merge", { ok: false });
      return { ok: false, failure_reason: "merge_conflict", events, changed_files: changed };
    }
    const sha = this.deps.git.headSha(this.deps.repoRoot, "main");
    emit("merge", true, { sha });
    emit("done", true, { sha, changed });
    this.deps.audit.append(sessionId, "system", "merge", { ok: true, sha, changed });
    return { ok: true, merge_sha: sha, events, changed_files: changed };
  }
}

interface BadFile {
  path: string;
  kind: "denied" | "not_in_write_allow";
}

function validateAgainstPolicy(files: string[], policy: PermissionPolicy): BadFile[] {
  const bad: BadFile[] = [];
  for (const f of files) {
    if (policy.deny.some((g) => minimatch(f, g, { dot: true }))) {
      bad.push({ path: f, kind: "denied" });
      continue;
    }
    if (!policy.write_allow.some((g) => minimatch(f, g, { dot: true }))) {
      bad.push({ path: f, kind: "not_in_write_allow" });
    }
  }
  return bad;
}

function isCheckCommand(cmd: string): boolean {
  // Treat `npm test`, `npm run *`, and `*lint*` as required checks.
  return /\bnpm\s+test\b/.test(cmd) || /\bnpm\s+run\b/.test(cmd) || /lint/.test(cmd);
}
