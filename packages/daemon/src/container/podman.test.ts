import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { MountPlan, PermissionPolicy } from "@collab/shared";
import { DEFAULT_CONTAINER_IMAGE } from "./types.js";
import { buildRunArgv, containerName, podmanAvailable, PodmanContainerManager } from "./podman.js";
import { PolicyResolver } from "../policy/resolver.js";
import { GitManager, git } from "../git/manager.js";

const plan: MountPlan = {
  network: "none",
  mounts: [
    { host_path: "/host/wt/src", container_path: "/work/src", mode: "rw" },
    { host_path: "/host/wt/README.md", container_path: "/work/README.md", mode: "ro" },
    { host_path: "/host/wt/secrets", container_path: "/work/secrets", mode: "tmpfs" },
    { host_path: "/tmp/empty", container_path: "/work/.env", mode: "empty_ro" },
    { host_path: "/host/wt/.git", container_path: "/work/.git", mode: "rw" },
  ],
};

describe("PodmanContainerManager argv (M4)", () => {
  it("builds podman run argv with required hardening flags", () => {
    const argv = buildRunArgv("sess_xyz", plan);
    expect(argv).toContain("--replace");
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--pids-limit=512");
    expect(argv).toContain("--memory=2g");
    expect(argv).toContain("--cpus=2");
    // No --user override by default — rootless podman maps container root to
    // the host's unprivileged user, so the agent can write to /work without
    // a UID-collision hazard.
    expect(argv).not.toContain("--user");
    const netIdx = argv.indexOf("--network");
    expect(argv[netIdx + 1]).toBe("none");
    expect(argv).toContain("--name");
    expect(argv).toContain(containerName("sess_xyz"));
    expect(argv).toContain(DEFAULT_CONTAINER_IMAGE);
  });

  it("emits the right mount flags per mode", () => {
    const argv = buildRunArgv("sess_y", plan);
    const j = argv.join(" ");
    expect(j).toContain("/host/wt/src:/work/src:rw");
    expect(j).toContain("/host/wt/README.md:/work/README.md:ro");
    expect(j).toContain("/tmp/empty:/work/.env:ro");
    expect(j).toContain("/host/wt/.git:/work/.git:rw");
    // tmpfs entries are emitted as anonymous podman volumes (no host path)
    // because `--tmpfs` cannot reliably mask an underlying bind mount on
    // macOS applehv. An anonymous volume gets `-v <container_path>` alone.
    const vIdxs = argv.flatMap((a, i) => (a === "-v" ? [i] : []));
    expect(vIdxs.some((i) => argv[i + 1] === "/work/secrets")).toBe(true);
  });
});

const POLICY: PermissionPolicy = {
  read_allow: ["**"],
  write_allow: ["src/**"],
  deny: [".env*", "**/secrets/**"],
  command_allow: [],
  network: "none",
};

function machineRunning(): boolean {
  // On macOS, podman needs a running VM. The CLI is "available" even when the
  // machine is stopped, but `podman info` will fail.
  const r = spawnSync("podman", ["info", "--format", "{{.Host.Arch}}"], { encoding: "utf8" });
  return r.status === 0;
}

const live = podmanAvailable() && machineRunning();
const describeLive = live ? describe : describe.skip;

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

describeLive("PodmanContainerManager live (M4 acceptance)", () => {
  let wt: string;
  let emptyFile: string;
  let mgr: PodmanContainerManager;
  const sessionId = `acc-${Date.now()}`;

  beforeAll(async () => {
    wt = mkdtempSync(join(tmpdir(), "collab-pod-"));
    mkdirSync(join(wt, "src"));
    mkdirSync(join(wt, "secrets"));
    mkdirSync(join(wt, ".git"));
    writeFileSync(join(wt, "src/foo.ts"), "export const foo = 1;\n");
    writeFileSync(join(wt, "README.md"), "# hi\n");
    writeFileSync(join(wt, ".env"), "SECRET=1");
    writeFileSync(join(wt, "secrets/token"), "x");
    writeFileSync(join(wt, ".git/HEAD"), "ref: refs/heads/main\n");

    const emptyDir = mkdtempSync(join(tmpdir(), "collab-empty-"));
    emptyFile = join(emptyDir, "empty");
    writeFileSync(emptyFile, "");

    const resolved = new PolicyResolver().resolveMountPlan(wt, POLICY, { emptyFileHost: emptyFile });
    mgr = new PodmanContainerManager();
    await mgr.create(sessionId, resolved);
  }, 60_000);

  afterAll(async () => {
    try { await mgr?.destroy(sessionId); } catch {}
    if (wt) rmSync(wt, { recursive: true, force: true });
  });

  async function collect(argv: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
    let stdout = "";
    let stderr = "";
    let exit = -1;
    for await (const c of mgr.exec(sessionId, argv)) {
      if (c.stream === "stdout") stdout += c.data;
      else if (c.stream === "stderr") stderr += c.data;
      else if (c.stream === "exit") exit = Number(c.data);
    }
    return { stdout, stderr, exit };
  }

  it("a denied file is shadowed: container content empty, host content preserved", async () => {
    const r = await collect(["sh", "-c", "cat /work/.env || true; echo ---; wc -c < /work/.env"]);
    expect(r.exit).toBe(0);
    // .env mounted as empty file
    expect(r.stdout).toMatch(/---\s*0\b/);
    // host .env untouched
    expect(readFileSync(join(wt, ".env"), "utf8")).toBe("SECRET=1");
  });

  it("a denied directory is tmpfs (no host data, writes don't escape)", async () => {
    const r = await collect(["sh", "-c", "ls -A /work/secrets; echo ---; echo hi > /work/secrets/x; ls -A /work/secrets"]);
    expect(r.exit).toBe(0);
    // tmpfs starts empty
    const [before, after] = r.stdout.split("---");
    expect(before?.trim()).toBe("");
    // writes inside tmpfs are visible inside the container...
    expect(after).toMatch(/\bx\b/);
    // ...but never reach the host
    expect(readFileSync(join(wt, "secrets/token"), "utf8")).toBe("x");
    expect(existsSync(join(wt, "secrets/x"))).toBe(false);
  });

  it("a read-only mount rejects writes", async () => {
    const r = await collect(["sh", "-c", "echo nope > /work/README.md"]);
    expect(r.exit).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/read-only|permission denied/);
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("# hi\n");
  });

  it("a writable mount lets edits land in the host worktree", async () => {
    const r = await collect(["sh", "-c", "echo 'export const foo = 42;' > /work/src/foo.ts"]);
    expect(r.exit).toBe(0);
    expect(readFileSync(join(wt, "src/foo.ts"), "utf8")).toContain("foo = 42");
  });

  it("git commands work from a linked worktree when repo metadata is mounted", async () => {
    const repo = mkdtempSync(join(tmpdir(), "collab-git-container-"));
    const gitWt = join(repo, "..", `linked-${Date.now()}`);
    const gitSession = `git-${Date.now()}`;
    const gitMgr = new GitManager();
    let gitContainer: PodmanContainerManager | undefined;
    try {
      mustGit(repo, ["init", "-q", "-b", "main"]);
      mustGit(repo, ["config", "user.email", "test@local"]);
      mustGit(repo, ["config", "user.name", "test"]);
      writeFileSync(join(repo, "foo.ts"), "export const foo = 1;\n");
      mustGit(repo, ["add", "-A"]);
      mustGit(repo, ["commit", "-q", "-m", "init"]);
      gitMgr.createWorktree({
        repoRoot: repo,
        branchName: "collab/session-git-container",
        worktreePath: gitWt,
      });

      const emptyDir = mkdtempSync(join(tmpdir(), "collab-empty-"));
      const empty = join(emptyDir, "empty");
      writeFileSync(empty, "");
      const resolved = new PolicyResolver().resolveMountPlan(gitWt, POLICY, {
        emptyFileHost: empty,
        gitMetadataHost: gitMgr.absoluteGitDir(repo),
      });
      gitContainer = new PodmanContainerManager();
      await gitContainer.create(gitSession, resolved);

      let stdout = "";
      let stderr = "";
      let exit = -1;
      for await (const c of gitContainer.exec(gitSession, [
        "sh",
        "-c",
        "git --version && git status --short && git show --name-only --oneline main",
      ])) {
        if (c.stream === "stdout") stdout += c.data;
        else if (c.stream === "stderr") stderr += c.data;
        else if (c.stream === "exit") exit = Number(c.data);
      }
      expect(exit, stderr).toBe(0);
      expect(stdout).toContain("git version");
      expect(stdout).toContain("init");
      expect(stdout).toContain("foo.ts");
    } finally {
      try { await gitContainer?.destroy(gitSession); } catch {}
      try { gitMgr.removeWorktree(repo, gitWt); } catch {}
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
