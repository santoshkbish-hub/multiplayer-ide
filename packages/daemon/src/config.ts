import { resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CONTAINER_IMAGE } from "./container/types.js";

export type AgentKind = "claude" | "scripted";

export interface DaemonConfig {
  repoRoot: string;
  worktreesRoot: string;
  relayUrl: string;
  hostToken: string;
  adminToken: string;
  adminPort: number;
  secretPath: string;
  dbPath: string;
  containerImage: string;
  createContainers: boolean;
  agent: AgentKind;
  agentModel?: string;
  agentSystemPrompt?: string;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const must = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required env: ${k}`);
    return v;
  };
  const home = env.HOME ?? homedir();
  const repoRoot = resolve(must("COLLAB_REPO_ROOT"));
  return {
    repoRoot,
    worktreesRoot: resolve(env.COLLAB_WORKTREES_ROOT ?? resolve(repoRoot, "..", "collab-worktrees")),
    relayUrl: env.COLLAB_RELAY_URL ?? "http://127.0.0.1:4000",
    hostToken: must("COLLAB_HOST_TOKEN"),
    adminToken: env.COLLAB_ADMIN_TOKEN ?? must("COLLAB_HOST_TOKEN"),
    adminPort: Number(env.COLLAB_ADMIN_PORT ?? 4100),
    secretPath: env.COLLAB_SECRET_PATH ?? resolve(home, ".local-collab", "secret"),
    dbPath: env.COLLAB_DB_PATH ?? resolve(home, ".local-collab", "db.sqlite"),
    containerImage: env.COLLAB_CONTAINER_IMAGE ?? DEFAULT_CONTAINER_IMAGE,
    createContainers: env.COLLAB_CREATE_CONTAINERS !== "false",
    agent: parseAgent(
      env.COLLAB_AGENT,
      env.ANTHROPIC_API_KEY ?? env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN,
    ),
    ...(env.COLLAB_AGENT_MODEL ? { agentModel: env.COLLAB_AGENT_MODEL } : {}),
    ...(env.COLLAB_AGENT_SYSTEM_PROMPT
      ? { agentSystemPrompt: env.COLLAB_AGENT_SYSTEM_PROMPT }
      : {}),
  };
}

function parseAgent(kind: string | undefined, anyAnthropicCred: string | undefined): AgentKind {
  if (kind === "claude" || kind === "scripted") return kind;
  return anyAnthropicCred ? "claude" : "scripted";
}
