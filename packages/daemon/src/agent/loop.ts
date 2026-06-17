import type { AgentRunner, AgentEvent, PublishOutcome } from "./runner.js";
import type { AdditionalContextProvider } from "./contextHooks.js";
import { HostWorkspace } from "./workspace.js";
import { GitManager } from "../git/manager.js";
import { GitSync, type SyncReport } from "../git/sync.js";
import type { SessionManager, PendingPrompt } from "../session/manager.js";

export interface LoopDeps {
  sessions: SessionManager;
  agent: AgentRunner;
  git: GitManager;
  sync: GitSync;
  repoRoot: string;
  onEvent?: (sessionId: string, ev: AgentEvent) => void;
  syncEvery?: number;
  publish?: (sessionId: string) => Promise<PublishOutcome>;
  status?: (
    sessionId: string,
    prompt: PendingPrompt,
    input: { kind?: string; message: string },
  ) => Promise<void>;
  statusRead?: (
    sessionId: string,
    input: { after_feed_id?: number; limit?: number },
  ) => Promise<string>;
  additionalContextProviders?: AdditionalContextProvider[];
}

export interface LoopResult {
  prompt_id: string;
  events: AgentEvent[];
  checkpoint_sha: string;
  sync_report: SyncReport;
}

export class AgentLoop {
  constructor(private deps: LoopDeps) {}

  async runOne(
    sessionId: string,
    prompt: PendingPrompt,
    onEvent?: (ev: AgentEvent) => void,
  ): Promise<LoopResult> {
    const s = this.deps.sessions.getSession(sessionId);
    if (!s) throw new Error("session_not_found");
    if (!s.worktree_path) throw new Error("worktree_not_materialized");
    const ws = new HostWorkspace(s.worktree_path, s.policy);
    const events: AgentEvent[] = [];
    const every = this.deps.syncEvery ?? 8;
    let i = 0;
    const publish = this.deps.publish;
    const status = this.deps.status;
    const statusRead = this.deps.statusRead;
    for await (const ev of this.deps.agent.run(
      {
        session_id: sessionId,
        ...(prompt.chat_id ? { chat_id: prompt.chat_id } : {}),
        workspace: ws,
        worktree_abs: s.worktree_path,
        policy: s.policy,
        ...(this.deps.additionalContextProviders
          ? { additionalContextProviders: this.deps.additionalContextProviders }
          : {}),
        ...(publish ? { publish: () => publish(sessionId) } : {}),
        ...(status ? { reportStatus: (input) => status(sessionId, prompt, input) } : {}),
        ...(statusRead ? { readStatusFeed: (input) => statusRead(sessionId, input) } : {}),
      },
      prompt.text,
    )) {
      events.push(ev);
      this.deps.onEvent?.(sessionId, ev);
      onEvent?.(ev);
      i++;
      if (i % every === 0) this.deps.sync.check({ repoRoot: this.deps.repoRoot, branchName: s.branch_name });
    }
    const sha = this.deps.git.checkpoint(s.worktree_path, `checkpoint: ${prompt.prompt_id}`);
    const report = this.deps.sync.check({
      repoRoot: this.deps.repoRoot,
      branchName: s.branch_name,
    });
    return { prompt_id: prompt.prompt_id, events, checkpoint_sha: sha, sync_report: report };
  }
}
