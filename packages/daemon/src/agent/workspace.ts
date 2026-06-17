import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { minimatch } from "minimatch";
import type { PermissionPolicy } from "@collab/shared";

export interface WriteResult {
  ok: boolean;
  reason?: "denied" | "not_writable";
}

export interface Workspace {
  read(path: string): string | null;
  write(path: string, content: string): WriteResult;
  exists(path: string): boolean;
}

// Defense-in-depth: enforces write_allow/deny against the worktree regardless
// of whether a container is in front. The mount boundary is the primary control;
// this layer trips earlier and yields a clearer reason.
export class HostWorkspace implements Workspace {
  constructor(private worktree: string, private policy: PermissionPolicy) {}

  read(path: string): string | null {
    const rel = posix.normalize(path);
    if (matches(rel, this.policy.deny)) return null;
    if (!matches(rel, this.policy.read_allow) && !matches(rel, this.policy.write_allow)) {
      return null;
    }
    const abs = join(this.worktree, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  }

  write(path: string, content: string): WriteResult {
    const rel = posix.normalize(path);
    if (matches(rel, this.policy.deny)) return { ok: false, reason: "denied" };
    if (!matches(rel, this.policy.write_allow)) return { ok: false, reason: "not_writable" };
    const abs = join(this.worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { ok: true };
  }

  exists(path: string): boolean {
    return existsSync(join(this.worktree, path));
  }
}

function matches(rel: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(rel, g, { dot: true }));
}
