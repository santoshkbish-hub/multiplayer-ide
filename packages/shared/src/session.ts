import type { PermissionPolicy } from "./policy.js";

export type SessionStatus =
  | "active"
  | "inactive"
  | "stale"
  | "merging"
  | "failed"
  | "ended";

export type Role = "owner" | "reader";

export interface Participant {
  user_id: string;
  role: Role;
  capabilities: string[];
}

export interface Session {
  session_id: string;
  branch_name: string;
  worktree_path?: string;
  base_main_sha: string;
  last_head_sha?: string;
  owner_user_id: string;
  owner_epoch: number;
  participants: Participant[];
  policy: PermissionPolicy;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}
