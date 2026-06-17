import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionPolicy } from "@collab/shared";
import { PolicyResolver } from "./resolver.js";

function fixtureWorktree(): string {
  const wt = mkdtempSync(join(tmpdir(), "collab-pol-"));
  mkdirSync(join(wt, "src"));
  mkdirSync(join(wt, "tests"));
  mkdirSync(join(wt, "secrets"));
  mkdirSync(join(wt, ".git"));
  writeFileSync(join(wt, "src/a.ts"), "x");
  writeFileSync(join(wt, "src/b.ts"), "x");
  writeFileSync(join(wt, "tests/a.test.ts"), "x");
  writeFileSync(join(wt, "README.md"), "x");
  writeFileSync(join(wt, "package.json"), "{}");
  writeFileSync(join(wt, ".env"), "SECRET=1");
  writeFileSync(join(wt, "secrets/token"), "x");
  writeFileSync(join(wt, ".git/HEAD"), "x");
  return wt;
}

const POLICY: PermissionPolicy = {
  read_allow: ["**"],
  write_allow: ["src/**", "tests/**"],
  deny: [".env*", "**/secrets/**", "**/*.pem"],
  command_allow: ["npm test"],
  network: "none",
};

describe("PolicyResolver M4", () => {
  let wt: string;
  let emptyFile: string;
  beforeEach(() => {
    wt = fixtureWorktree();
    const tmp = mkdtempSync(join(tmpdir(), "collab-empty-"));
    emptyFile = join(tmp, "empty");
    writeFileSync(emptyFile, "");
  });
  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  it("mounts the whole worktree rw at /work and overlays ro overrides on read-only files", () => {
    const plan = new PolicyResolver().resolveMountPlan(wt, POLICY, {
      emptyFileHost: emptyFile,
    });
    const find = (cp: string) => plan.mounts.find((m) => m.container_path === cp);

    // Base mount: agent writes anywhere under /work persist to the host worktree.
    const base = find("/work");
    expect(base?.mode).toBe("rw");
    expect(base?.host_path).toBe(wt);
    // src/tests are writable subtrees — covered by the base mount, no override.
    expect(find("/work/src")).toBeUndefined();
    expect(find("/work/tests")).toBeUndefined();
    // README.md and package.json are read_allow but not write_allow → ro overlays.
    expect(find("/work/README.md")?.mode).toBe("ro");
    expect(find("/work/package.json")?.mode).toBe("ro");
  });

  it("denied files are shadowed (empty_ro) so the original host content is unreachable", () => {
    const plan = new PolicyResolver().resolveMountPlan(wt, POLICY, {
      emptyFileHost: emptyFile,
    });
    const env = plan.mounts.find((m) => m.container_path === "/work/.env");
    expect(env).toBeDefined();
    expect(env!.mode).toBe("empty_ro");
    expect(env!.host_path).toBe(emptyFile);
  });

  it("a deny subtree is fully tmpfs'd (no host bind)", () => {
    const plan = new PolicyResolver().resolveMountPlan(wt, POLICY, {
      emptyFileHost: emptyFile,
    });
    const sec = plan.mounts.find((m) => m.container_path === "/work/secrets");
    expect(sec).toBeDefined();
    expect(sec!.mode).toBe("tmpfs");
  });

  it("can mount linked-worktree git metadata at its absolute host path", () => {
    const gitdir = join(wt, "..", "repo.git");
    const plan = new PolicyResolver().resolveMountPlan(wt, POLICY, {
      emptyFileHost: emptyFile,
      gitMetadataHost: gitdir,
    });
    const metadata = plan.mounts.find((m) => m.container_path === gitdir);
    expect(metadata).toEqual({
      host_path: gitdir,
      container_path: gitdir,
      mode: "rw",
    });
    // The worktree's .git file still inherits rw from the base /work mount; it
    // points at the mounted gitdir above.
    const explicit = plan.mounts.find((m) => m.container_path === "/work/.git");
    expect(explicit).toBeUndefined();
    expect(plan.mounts.find((m) => m.container_path === "/work")?.mode).toBe("rw");
  });

  it("propagates network policy", () => {
    const plan = new PolicyResolver().resolveMountPlan(
      wt,
      { ...POLICY, network: "restricted" },
      { emptyFileHost: emptyFile },
    );
    expect(plan.network).toBe("restricted");
  });
});
