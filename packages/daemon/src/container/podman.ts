import { spawn, spawnSync } from "node:child_process";
import type { MountPlan } from "@collab/shared";
import {
  type ContainerLimits,
  type ContainerManager,
  type ExecChunk,
  type ExecOpts,
  DEFAULT_LIMITS,
} from "./types.js";

export function containerName(sessionId: string): string {
  return `ctr_${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function podmanAvailable(): boolean {
  const r = spawnSync("podman", ["version", "--format", "{{.Client.Version}}"], {
    encoding: "utf8",
  });
  return r.status === 0;
}

export function buildRunArgv(
  sessionId: string,
  plan: MountPlan,
  limits: ContainerLimits = DEFAULT_LIMITS,
): string[] {
  const name = containerName(sessionId);
  const argv: string[] = [
    "run",
    "--replace",
    "--rm",
    "-d",
    "--name",
    name,
    "--cap-drop=ALL",
    `--pids-limit=${limits.pidsLimit}`,
    `--memory=${limits.memory}`,
    `--cpus=${limits.cpus}`,
    "-w",
    "/work",
  ];
  if (limits.userIdMap) argv.push("--user", limits.userIdMap);
  argv.push("--network", plan.network === "open" ? "bridge" : plan.network === "restricted" ? "bridge" : "none");

  for (const m of plan.mounts) {
    switch (m.mode) {
      case "rw":
        argv.push("-v", `${m.host_path}:${m.container_path}:rw`);
        break;
      case "ro":
        argv.push("-v", `${m.host_path}:${m.container_path}:ro`);
        break;
      case "empty_ro":
        argv.push("-v", `${m.host_path}:${m.container_path}:ro`);
        break;
      case "tmpfs":
        // Anonymous podman volume: empty, container-writable, auto-removed
        // with `--rm`. We use this instead of `--tmpfs` because on macOS
        // applehv, `--tmpfs` over a subpath of an existing bind mount does
        // not reliably mask the underlying host content. Anonymous volumes
        // override unambiguously and work cross-platform.
        argv.push("-v", m.container_path);
        break;
    }
  }
  argv.push(limits.image, "sleep", "infinity");
  return argv;
}

export class PodmanContainerManager implements ContainerManager {
  private created = new Map<string, string>(); // sessionId -> container id

  constructor(private limits: ContainerLimits = DEFAULT_LIMITS) {}

  async create(sessionId: string, plan: MountPlan): Promise<string> {
    const args = buildRunArgv(sessionId, plan, this.limits);
    const r = spawnSync("podman", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`podman run failed: ${r.stderr || r.stdout}`);
    const id = r.stdout.trim();
    this.created.set(sessionId, id);
    return id;
  }

  exec(sessionId: string, argv: string[], opts: ExecOpts = {}): AsyncIterable<ExecChunk> {
    const name = containerName(sessionId);
    const execArgs = ["exec"];
    if (opts.stdin !== undefined) execArgs.push("-i");
    if (opts.cwd) execArgs.push("-w", opts.cwd);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) execArgs.push("-e", `${k}=${v}`);
    }
    execArgs.push(name, ...argv);
    const child = spawn("podman", execArgs);
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    return iterChunks(child);
  }

  async destroy(sessionId: string): Promise<void> {
    const name = containerName(sessionId);
    spawnSync("podman", ["rm", "-f", name], { encoding: "utf8" });
    this.created.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.created.has(sessionId);
  }
}

async function* iterChunks(child: ReturnType<typeof spawn>): AsyncIterable<ExecChunk> {
  const queue: ExecChunk[] = [];
  let waiter: ((v: void) => void) | null = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  child.stdout?.on("data", (b: Buffer) => {
    queue.push({ stream: "stdout", data: b.toString("utf8") });
    wake();
  });
  child.stderr?.on("data", (b: Buffer) => {
    queue.push({ stream: "stderr", data: b.toString("utf8") });
    wake();
  });
  const exit = new Promise<number>((resolve) => {
    child.on("close", (code) => {
      queue.push({ stream: "exit", data: String(code ?? -1) });
      resolve(code ?? -1);
      wake();
    });
  });
  while (true) {
    if (queue.length === 0) {
      const done = await Promise.race([
        new Promise<void>((r) => (waiter = r)),
        exit.then(() => undefined),
      ]);
      void done;
    }
    while (queue.length) {
      const item = queue.shift()!;
      yield item;
      if (item.stream === "exit") return;
    }
  }
}
