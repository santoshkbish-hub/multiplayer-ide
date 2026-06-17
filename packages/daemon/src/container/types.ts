import type { MountPlan } from "@collab/shared";

export interface ExecChunk {
  stream: "stdout" | "stderr" | "exit";
  data: string;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ContainerManager {
  create(sessionId: string, plan: MountPlan): Promise<string>;
  exec(sessionId: string, argv: string[], opts?: ExecOpts): AsyncIterable<ExecChunk>;
  destroy(sessionId: string): Promise<void>;
}

export interface ContainerLimits {
  memory: string;          // e.g. "2g"
  cpus: string;            // e.g. "2"
  pidsLimit: number;       // e.g. 512
  userIdMap?: string;      // e.g. "1000:1000"
  image: string;
}

export const DEFAULT_CONTAINER_IMAGE = "node:20-bookworm";

export const DEFAULT_LIMITS: ContainerLimits = {
  memory: "2g",
  cpus: "2",
  pidsLimit: 512,
  // No --user override: under rootless podman the container "root" is just
  // your unprivileged host UID via the user namespace, so it can write to
  // bind-mounted worktree files and to the auto-created /work mount root,
  // while cap-drop=ALL + pids/cpu/memory limits + the mount shadow plan
  // still provide defense in depth.
  image: DEFAULT_CONTAINER_IMAGE,
};
