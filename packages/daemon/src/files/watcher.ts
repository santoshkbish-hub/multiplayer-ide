import { watch, statSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import type { PermissionPolicy } from "@collab/shared";

export type ChangeKind = "add" | "change" | "unlink";
export interface FileChange {
  path: string;
  kind: ChangeKind;
}

export interface FileWatcherDeps {
  emit: (sessionId: string, changes: FileChange[]) => void;
  classify: (rel: string, policy: PermissionPolicy) => "rw" | "ro" | null;
  debounceMs?: number;
}

// Watches a session worktree (recursively) and coalesces fs events into a
// single `files.changed` emission per debounce window. Policy-hidden paths
// are filtered out so the wire event never leaks denied filenames.
export class FileWatcher {
  private watchers = new Map<string, FSWatcher>();
  private policies = new Map<string, PermissionPolicy>();
  private worktrees = new Map<string, string>();
  private pending = new Map<string, Map<string, ChangeKind>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private deps: FileWatcherDeps) {}

  watchSession(sessionId: string, worktree: string, policy: PermissionPolicy): void {
    this.unwatch(sessionId);
    this.policies.set(sessionId, policy);
    this.worktrees.set(sessionId, worktree);
    let w: FSWatcher;
    try {
      w = watch(worktree, { recursive: true });
    } catch {
      return; // platform may not support recursive watch; non-fatal
    }
    w.on("change", (_event, filename) => {
      if (!filename) return;
      const rel =
        typeof filename === "string" ? filename : filename.toString("utf8");
      this.handle(sessionId, rel);
    });
    w.on("error", () => {});
    this.watchers.set(sessionId, w);
  }

  private handle(sessionId: string, rawRel: string): void {
    const rel = rawRel.split(sep).join("/");
    if (!rel || rel === ".git" || rel.startsWith(".git/")) return;
    const policy = this.policies.get(sessionId);
    const worktree = this.worktrees.get(sessionId);
    if (!policy || !worktree) return;
    if (this.deps.classify(rel, policy) === null) return;
    let kind: ChangeKind;
    try {
      statSync(join(worktree, rel));
      kind = "change";
    } catch {
      kind = "unlink";
    }
    let m = this.pending.get(sessionId);
    if (!m) {
      m = new Map();
      this.pending.set(sessionId, m);
    }
    // unlink wins over change for the same path within the window.
    const prior = m.get(rel);
    if (prior === "unlink") return;
    m.set(rel, kind);
    this.schedule(sessionId);
  }

  private schedule(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const ms = this.deps.debounceMs ?? 250;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        const m = this.pending.get(sessionId);
        if (!m || m.size === 0) return;
        const changes: FileChange[] = [];
        for (const [path, kind] of m) changes.push({ path, kind });
        m.clear();
        this.deps.emit(sessionId, changes);
      }, ms),
    );
  }

  unwatch(sessionId: string): void {
    this.watchers.get(sessionId)?.close();
    this.watchers.delete(sessionId);
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
    this.pending.delete(sessionId);
    this.policies.delete(sessionId);
    this.worktrees.delete(sessionId);
  }

  stopAll(): void {
    for (const sid of [...this.watchers.keys()]) this.unwatch(sid);
  }
}
