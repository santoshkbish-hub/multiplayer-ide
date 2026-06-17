import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import type { MountEntry, MountPlan, PermissionPolicy } from "@collab/shared";

type Classification = "deny" | "write" | "read" | "none";

export interface ResolveOptions {
  emptyFileHost: string;     // host path to an empty file used for empty_ro shadows
  containerRoot?: string;    // default /work
  gitMetadataHost?: string;  // host repo gitdir, mounted at the same absolute path
}

export class PolicyResolver {
  resolveMountPlan(
    worktree: string,
    policy: PermissionPolicy,
    opts: ResolveOptions,
  ): MountPlan {
    const containerRoot = opts.containerRoot ?? "/work";
    const files = walk(worktree);
    const classified = files.map((rel) => ({
      rel,
      cls: classify(rel, policy),
    }));

    // Base mount: the entire worktree at /work as rw. Without this, podman
    // auto-creates /work as an ephemeral stub; any write the agent makes to a
    // path we didn't anticipate (e.g. /work/foo.ts at the worktree root) lands
    // in the container's writable layer instead of the host worktree, so git
    // never sees it and `publish` happily merges an empty diff.
    //
    // Deny shadows (tmpfs / empty_ro) and explicit `ro` overrides are emitted
    // AFTER the base, so podman applies them on top — masking secrets and
    // enforcing read-only on read_allow paths while writes at any other path
    // persist to disk.
    const mounts: MountEntry[] = [
      { host_path: worktree, container_path: containerRoot, mode: "rw" },
    ];
    if (opts.gitMetadataHost) {
      // Linked git worktrees have a /work/.git file pointing at the host repo's
      // real gitdir. Mount that gitdir at the same absolute path inside the
      // container so `git status`, `git diff main`, and similar commands work
      // from /work without rewriting the worktree metadata.
      mounts.push({
        host_path: opts.gitMetadataHost,
        container_path: opts.gitMetadataHost,
        mode: "rw",
      });
    }

    // Pure-deny groups get a tmpfs override. Pure-read groups get a ro
    // override. Pure-write groups need nothing (covered by the base). Mixed
    // groups need per-file shadows for the deny entries; the rest are covered.
    const groups = new Map<string, typeof classified>();
    for (const e of classified) {
      const top = topSegment(e.rel);
      const arr = groups.get(top) ?? [];
      arr.push(e);
      groups.set(top, arr);
    }

    // Root-level files: emit ro / empty_ro overrides only. Writable & "none"
    // already covered by the base mount.
    const rootFiles = groups.get("") ?? [];
    groups.delete("");
    for (const f of rootFiles) {
      const m = overrideMount(worktree, f.rel, f.cls, containerRoot, opts.emptyFileHost);
      if (m) mounts.push(m);
    }

    for (const [top, entries] of groups) {
      const modes = new Set(entries.map((e) => e.cls));
      const dirHost = join(worktree, top);
      const dirCont = posix.join(containerRoot, top);

      if (modes.size === 1) {
        const only = entries[0]!.cls;
        if (only === "read") {
          mounts.push({ host_path: dirHost, container_path: dirCont, mode: "ro" });
        } else if (only === "deny") {
          mounts.push({ host_path: dirHost, container_path: dirCont, mode: "tmpfs" });
        }
        // "write" and "none" are already covered by the base rw mount.
        continue;
      }

      // Mixed subtree: emit per-file overrides for deny + ro. Write/none ride
      // the base mount.
      for (const e of entries) {
        const m = overrideMount(worktree, e.rel, e.cls, containerRoot, opts.emptyFileHost);
        if (m) mounts.push(m);
      }
    }

    return { mounts, network: policy.network };
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel === "" ? root : join(root, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel === "" ? e.name : posix.join(rel.split(sep).join("/"), e.name);
      // Never descend into .git for the resolver — it's mounted whole.
      if (childRel === ".git" || childRel.startsWith(".git/")) continue;
      if (e.isDirectory()) {
        stack.push(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

function classify(rel: string, policy: PermissionPolicy): Classification {
  if (matchesAny(rel, policy.deny)) return "deny";
  if (matchesAny(rel, policy.write_allow)) return "write";
  if (matchesAny(rel, policy.read_allow)) return "read";
  return "none";
}

function matchesAny(rel: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(rel, g, { dot: true }));
}

function topSegment(rel: string): string {
  const i = rel.indexOf("/");
  if (i === -1) return ""; // root-level file
  return rel.slice(0, i);
}

// Only emits a mount if the path needs to OVERRIDE the base rw bind — i.e.
// the path is denied (shadow) or read-only (ro overlay). "write" and "none"
// already inherit rw from the base mount.
function overrideMount(
  worktree: string,
  rel: string,
  cls: Classification,
  containerRoot: string,
  emptyFileHost: string,
): MountEntry | null {
  if (cls === "deny") return shadowMount(worktree, rel, containerRoot, emptyFileHost);
  if (cls === "read") {
    return {
      host_path: join(worktree, rel),
      container_path: posix.join(containerRoot, rel),
      mode: "ro",
    };
  }
  return null;
}

function shadowMount(
  worktree: string,
  rel: string,
  containerRoot: string,
  emptyFileHost: string,
): MountEntry {
  // We can't reliably know dir-vs-file without statting; resolver only walks files,
  // so we always shadow as empty_ro for file paths.
  return {
    host_path: emptyFileHost,
    container_path: posix.join(containerRoot, rel),
    mode: "empty_ro",
  };
}

export function relWithin(root: string, p: string): string {
  return relative(root, p).split(sep).join("/");
}
