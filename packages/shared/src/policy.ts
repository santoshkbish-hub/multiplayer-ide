export type NetworkPolicy = "none" | "restricted" | "open";

export interface PermissionPolicy {
  read_allow: string[];
  write_allow: string[];
  deny: string[];
  command_allow: string[];
  network: NetworkPolicy;
}

export type MountMode = "ro" | "rw" | "tmpfs" | "empty_ro";

export interface MountEntry {
  host_path: string;
  container_path: string;
  mode: MountMode;
}

export interface MountPlan {
  mounts: MountEntry[];
  network: NetworkPolicy;
}

export const DEFAULT_POLICY: PermissionPolicy = {
  read_allow: ["**"],
  // Permissive default so the agent can write at the worktree root (foo.ts,
  // package.json, etc.). The `deny` list still hard-blocks secrets, and
  // session creators can supply a narrower policy when they want to.
  write_allow: ["**"],
  deny: [".env*", "**/*.pem", "**/*.key", "**/secrets/**"],
  command_allow: [
    "npm test",
    "npm run lint",
    "git status",
    "git diff",
    "git log",
    "git show",
    "git add",
    "git restore",
    "git commit",
    "git branch",
    "git rev-parse",
    "git ls-files",
    "git blame",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "find",
  ],
  network: "none",
};
