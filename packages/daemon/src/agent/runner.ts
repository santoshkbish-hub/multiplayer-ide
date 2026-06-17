import type { PermissionPolicy } from "@collab/shared";
import type { Workspace } from "./workspace.js";
import type { AdditionalContextProvider } from "./contextHooks.js";

export interface PublishOutcome {
  ok: boolean;
  reason?: string;
  merge_sha?: string;
  changed_files?: string[];
}

export interface AgentContext {
  session_id: string;
  chat_id?: string;
  workspace: Workspace;
  worktree_abs: string;
  policy: PermissionPolicy;
  additionalContextProviders?: AdditionalContextProvider[];
  // Lets the agent declare a turn complete and ship the change to main.
  publish?: () => Promise<PublishOutcome>;
  reportStatus?: (input: { kind?: string; message: string }) => Promise<void>;
  readStatusFeed?: (input: { after_feed_id?: number; limit?: number }) => Promise<string>;
}

export type AgentEvent =
  | { kind: "token"; data: string }
  | { kind: "edit"; path: string; ok: boolean; reason?: string }
  | { kind: "command"; argv: string[]; ok: boolean; output?: string }
  | { kind: "done" };

export interface AgentRunner {
  run(ctx: AgentContext, prompt: string): AsyncIterable<AgentEvent>;
  cancel?(promptId: string): void;
}
