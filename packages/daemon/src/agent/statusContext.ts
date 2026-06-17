import type { AdditionalContextProvider } from "./contextHooks.js";
import type { AgentStatusRepo, AgentStatusRow } from "../store/agentStatus.js";

export interface AgentStatusContextDeps {
  status: AgentStatusRepo;
  now?: () => Date;
}

export class AgentStatusContextProvider {
  private lastSeen = new Map<string, number>();
  private now: () => Date;

  constructor(private deps: AgentStatusContextDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  provider(): AdditionalContextProvider {
    return ({ session_id, chat_id }) => this.getContext(session_id, chat_id);
  }

  getContext(sessionId: string, chatId?: string): string {
    const key = `${sessionId}:${chatId ?? "default"}`;
    const after = this.lastSeen.get(key) ?? 0;
    const rows = this.deps.status.listSince(sessionId, after, 20);
    if (rows.length) this.lastSeen.set(key, rows[rows.length - 1]!.seq);
    return formatStatusContext(this.now(), rows);
  }
}

function formatStatusContext(now: Date, rows: AgentStatusRow[]): string {
  const lines = [
    `Shared agent status feed (current time: ${now.toISOString()}):`,
    "- This session shares one container, worktree, and branch across multiple chats/agents.",
  ];
  if (rows.length === 0) {
    lines.push("- No new shared status rows since your last check.");
  } else {
    lines.push("- New shared status rows since your last check:");
    for (const row of rows) {
      const chat = row.chat_id ? ` chat=${row.chat_id}` : "";
      lines.push(
        `  [feed_id=${row.seq}] ${row.ts} agent=${row.agent_id}${chat} kind=${row.kind}: ${row.message}`,
      );
    }
  }
  lines.push(
    "- Use these rows to avoid duplicate work and file conflicts. Keep your own status updates short.",
  );
  return lines.join("\n");
}
