import { resolve, relative, isAbsolute, posix } from "node:path";
import { minimatch } from "minimatch";
import {
  query as sdkQuery,
  type Options,
  type Query,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionPolicy } from "@collab/shared";
import type { AgentContext, AgentEvent, AgentRunner } from "./runner.js";
import type { ContainerManager } from "../container/types.js";
import { buildContainerToolServer } from "./containerTools.js";
import { buildAdditionalContextHooks } from "./contextHooks.js";

export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Options;
}) => Query;

export interface ClaudeAgentOptions {
  // Override only for testing — production uses the SDK's query().
  queryFn?: QueryFn;
  model?: string;
  systemPrompt?: string;
  // Container backing for all file/shell tool executions. Required for
  // production safety — tool calls run inside the per-session sandbox.
  containers?: ContainerManager;
}

// File-tool names whose first input field names the target path. Includes
// both the SDK's built-in names and the container-backed MCP tool names
// (canUseTool may see either depending on whether toolAliases is in play).
const FILE_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "mcp__container__read",
  "mcp__container__edit",
  "mcp__container__write",
]);
const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "mcp__container__edit",
  "mcp__container__write",
]);
const BASH_TOOLS = new Set(["Bash", "mcp__container__bash"]);

interface ResolvedPolicyDeps {
  worktreeAbs: string;
  policy: PermissionPolicy;
}

function classifyPath(
  raw: unknown,
  deps: ResolvedPolicyDeps,
): { ok: true; rel: string } | { ok: false; reason: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "missing file_path" };
  }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(deps.worktreeAbs, raw);
  const rel = relative(deps.worktreeAbs, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: `path outside worktree: ${raw}` };
  }
  return { ok: true, rel: posix.normalize(rel || ".") };
}

function pathInGlobs(rel: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(rel, g, { dot: true }));
}

function checkBash(cmd: string, allow: string[]): boolean {
  // The same shape used by orchestrator.handleCommand: exact, prefix, or glob.
  return allow.some((g) => cmd === g || cmd.startsWith(`${g} `) || minimatch(cmd, g));
}

function makeCanUseTool(deps: ResolvedPolicyDeps) {
  return async function canUseTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    if (FILE_TOOLS.has(name)) {
      const cls = classifyPath(input.file_path, deps);
      if (!cls.ok) return { behavior: "deny", message: cls.reason };
      if (pathInGlobs(cls.rel, deps.policy.deny)) {
        return { behavior: "deny", message: `denied by policy: ${cls.rel}` };
      }
      if (WRITE_TOOLS.has(name)) {
        if (!pathInGlobs(cls.rel, deps.policy.write_allow)) {
          return { behavior: "deny", message: `not in write_allow: ${cls.rel}` };
        }
      } else {
        // Read-style: read_allow OR write_allow grants read.
        if (
          !pathInGlobs(cls.rel, deps.policy.read_allow) &&
          !pathInGlobs(cls.rel, deps.policy.write_allow)
        ) {
          return { behavior: "deny", message: `not in read_allow: ${cls.rel}` };
        }
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (BASH_TOOLS.has(name)) {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (!checkBash(cmd, deps.policy.command_allow)) {
        return { behavior: "deny", message: `not in command_allow: ${cmd}` };
      }
      return { behavior: "allow", updatedInput: input };
    }
    // `publish` is a daemon-side action gated by MergeManager (lock + policy
    // re-validation + checks). No input to inspect here, allow it through.
    if (name === "mcp__container__publish") {
      return { behavior: "allow", updatedInput: input };
    }
    if (name === "mcp__container__status") {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) return { behavior: "deny", message: "status message required" };
      return { behavior: "allow", updatedInput: input };
    }
    if (name === "mcp__container__status_read") {
      return { behavior: "allow", updatedInput: input };
    }
    // Unknown tool — deny by default.
    return { behavior: "deny", message: `tool not permitted: ${name}` };
  };
}

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type: string; text?: string }>;
}

const TOOL_RESULT_MAX = 4096;
function toolResultBody(block: ContentBlock): string {
  const raw = block.content;
  let body: string;
  if (typeof raw === "string") body = raw;
  else if (Array.isArray(raw)) {
    body = raw
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("");
  } else body = "";
  if (body.length > TOOL_RESULT_MAX) {
    body = body.slice(0, TOOL_RESULT_MAX) + `\n…(truncated, ${body.length} bytes total)`;
  }
  return body;
}

export class ClaudeAgent implements AgentRunner {
  private aborts = new Map<string, AbortController>();
  // Map collab session id -> Claude SDK session id, so the next prompt
  // resumes the prior turn's transcript instead of starting fresh.
  private sdkSessionIds = new Map<string, string>();

  constructor(private opts: ClaudeAgentOptions = {}) {}

  cancel(promptId: string): void {
    this.aborts.get(promptId)?.abort();
  }

  async *run(ctx: AgentContext, prompt: string): AsyncIterable<AgentEvent> {
    const policy = ctx.policy;
    const worktreeAbs = ctx.worktree_abs;
    const ac = new AbortController();
    this.aborts.set(ctx.session_id, ac);
    const resumeKey = ctx.chat_id ? `${ctx.session_id}:${ctx.chat_id}` : ctx.session_id;
    const resumeId = this.sdkSessionIds.get(resumeKey);
    const hooks = buildAdditionalContextHooks(
      ctx.session_id,
      ctx.chat_id,
      ctx.additionalContextProviders,
    );

    if (!this.opts.containers) {
      throw new Error(
        "ClaudeAgent requires a ContainerManager — tool calls must execute inside the per-session sandbox container.",
      );
    }
    const mcp = buildContainerToolServer({
      containers: this.opts.containers,
      sessionId: ctx.session_id,
      ...(ctx.publish ? { publish: ctx.publish } : {}),
      ...(ctx.reportStatus ? { status: ctx.reportStatus } : {}),
      ...(ctx.readStatusFeed ? { statusRead: ctx.readStatusFeed } : {}),
    });

    const q = (this.opts.queryFn ?? sdkQuery)({
      prompt,
      options: {
        abortController: ac,
        canUseTool: makeCanUseTool({ worktreeAbs, policy }),
        permissionMode: "default",
        mcpServers: { container: mcp },
        // Redirect the model's built-in tool names into the container-backed
        // MCP tools. Everything the LLM does executes inside the sandbox.
        toolAliases: {
          Read: "mcp__container__read",
          Edit: "mcp__container__edit",
          Write: "mcp__container__write",
          Bash: "mcp__container__bash",
        },
        includePartialMessages: true,
        allowedTools: [
          "mcp__container__read",
          "mcp__container__edit",
          "mcp__container__write",
          "mcp__container__bash",
          "mcp__container__status",
          "mcp__container__status_read",
          "mcp__container__publish",
          "Glob",
          "Grep",
        ],
        // AskUserQuestion / ExitPlanMode stall the stream waiting for a human
        // reply we have no UI channel for; deny them outright.
        disallowedTools: [
          "WebFetch",
          "WebSearch",
          "AskUserQuestion",
          "ExitPlanMode",
        ],
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        ...(hooks ? { hooks } : {}),
        systemPrompt: buildSystemPrompt(this.opts.systemPrompt),
      },
    });

    const streamedIndexes = new Set<number>();
    const toolUseNames = new Map<string, string>();
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) this.sdkSessionIds.set(resumeKey, sid);
        for (const ev of mapMessage(msg, streamedIndexes, toolUseNames)) yield ev;
      }
    } finally {
      this.aborts.delete(ctx.session_id);
    }
    yield { kind: "done" };
  }
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are an AI coding agent collaborating with a user inside an isolated sandbox container.",
  "The session worktree is mounted at /work. All file edits and shell commands run inside the container.",
  "You have access to git commands (status, diff, log, add, commit, branch, restore, …) — use them freely to inspect history and stage commits on the session branch.",
  "",
  "RUNTIME ENVIRONMENT:",
  "- The container normally runs with network policy `none`; package registry lookups and downloads can fail or hang.",
  "- Do not run ad hoc package-fetching commands such as `npx -y ...`, `npm exec <package>`, `npm install`, `npm create`, `pnpm add`, or `yarn add` unless the user explicitly asks to install dependencies and the network policy allows it.",
  "- In particular, do not use `npx -y tsx`, `npx -y ts-node`, or `npx -y typescript@latest` as throwaway TypeScript checks.",
  "- For verification, prefer commands and dependencies already present in the repo, such as `npm test`, `npm run ...`, `git ...`, `node`, or local binaries under `node_modules/.bin`. If a check requires a missing package or network access, say that instead of trying to fetch it.",
  "",
  "PUBLISHING RULES — read carefully:",
  "- A successful edit is NOT visible to other sessions or on `main` until you call the `publish` tool.",
  "- The `AgentLoop` records a `checkpoint` commit on the session branch at the end of every turn — that is local-only bookkeeping, NOT a publish. A checkpoint does not merge to main.",
  "- After completing any code change that satisfies the user's request, you MUST call `publish` in the SAME turn. Do not end your reply until publish has been called and returned a merge SHA.",
  "- If the user asks 'did you publish?' or similar, answer using ONLY the result of a real `publish` tool call (success returns a merge SHA). Do not infer from checkpoints, git log, or local branch state.",
  "- Do not attempt `git push`, `git merge main`, or `git checkout main` — those are managed by the daemon. Just call `publish`.",
  "- If `publish` fails (stale / denied_path / check_failed / merge_conflict), explain the reason to the user and either fix the issue and try again or stop.",
  "",
  "MAIN UPDATE CONTEXT:",
  "- You are working in an isolated session worktree inside a collaborative environment. Other sessions may publish to `main` while you work.",
  "- Other agents may update files related to your task. Stay up to date before editing or publishing by checking injected file-update notices, relevant `publish.status` context, and recent commit messages when main has moved.",
  "- The host may inject short notices comparing your session branch to current `main`: base SHA, current main SHA, files changed on main, and overlaps with your branch.",
  "- Treat these as routing hints, not full context. Before editing or publishing, check whether listed main changes affect your task. If relevant, inspect on demand with `git log --oneline <base>..main`, `git show --stat main`, `git show --name-only main`, or `git diff <base>..main -- <path>`.",
  "- Do not assume your worktree has been reconciled with main, and do not inspect unrelated main changes by default.",
  "",
  "SHARED AGENT STATUS:",
  "- Multiple chats/agents may work in this same container, branch, and worktree. You must coordinate through the shared status feed injected into additional context.",
  "- The host automatically injects latest unread shared status rows before user prompts and between tool batches. Each row has an incremental `feed_id`, agent id, chat id, timestamp, kind, and short message; the injected context also includes current time.",
  "- You do not need to poll the feed routinely. If you need older rows or want to inspect beyond the injected latest rows, use the `status_read` tool with `after_feed_id`.",
  "- Use the `status` tool to write concise updates for other agents: when you join/start a task, when you form or change a plan, before editing important files, when you are blocked, and before publishing.",
  "- Status messages must be one short sentence, not verbose chain-of-thought. Mention files and intent, for example: `plan: update src/foo.ts validation path` or `editing packages/client/public/app.js to add chat picker`.",
  "- If another agent is already working on overlapping files, inspect their status and recent commits before proceeding; avoid duplicating or overwriting their work.",
].join("\n");

function buildSystemPrompt(extra?: string): string {
  if (!extra) return DEFAULT_SYSTEM_PROMPT;
  return `${DEFAULT_SYSTEM_PROMPT}\n\n${extra}`;
}

interface PartialStreamEvent {
  type: string;
  index?: number;
  delta?: { type: string; text?: string };
  content_block?: { type: string };
}

function mapMessage(
  msg: SDKMessage,
  streamedIndexes: Set<number>,
  toolUseNames: Map<string, string>,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (msg.type === "stream_event") {
    const ev = (msg as { event?: PartialStreamEvent }).event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const text = ev.delta.text ?? "";
      if (text) {
        if (typeof ev.index === "number") streamedIndexes.add(ev.index);
        out.push({ kind: "token", data: text });
      }
    }
    return out;
  }
  if (msg.type === "assistant") {
    const content = (msg.message?.content ?? []) as ContentBlock[];
    content.forEach((block, idx) => {
      if (block.type === "text" && typeof block.text === "string") {
        if (streamedIndexes.has(idx)) return; // already streamed live
        out.push({ kind: "token", data: block.text });
      } else if (block.type === "tool_use") {
        const toolName = block.name ?? "?";
        const id = block.id ?? "";
        if (id) toolUseNames.set(id, toolName);
        const input = block.input ?? {};
        const summary = summarizeToolInput(toolName, input);
        // Structured token the UI uses to render a collapsible tile.
        out.push({ kind: "token", data: encodeToolUse(id, toolName, summary) });
        // Internal-only events for downstream signalling (loop, audit,
        // tests). The orchestrator no longer renders these as user-facing
        // strings — the tool_use/tool_result tile carries that information
        // with real status.
        if (WRITE_TOOLS.has(toolName)) {
          const path = typeof input.file_path === "string" ? input.file_path : "?";
          out.push({ kind: "edit", path, ok: true });
        } else if (BASH_TOOLS.has(toolName)) {
          const cmd = typeof input.command === "string" ? input.command : "";
          out.push({ kind: "command", argv: cmd.split(/\s+/).filter(Boolean), ok: true });
        }
      }
    });
    return out;
  }
  if (msg.type === "user") {
    // The SDK delivers tool results as a user message containing
    // tool_result content blocks. Surface them as collapsible UI tiles.
    const content = (msg.message?.content ?? []) as ContentBlock[];
    if (typeof msg.message?.content === "string") return out;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id ?? "";
      const name = toolUseNames.get(id) ?? "?";
      const body = toolResultBody(block);
      out.push({
        kind: "token",
        data: encodeToolResult(id, name, !block.is_error, body),
      });
    }
  }
  return out;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  if (typeof input.pattern === "string") return input.pattern;
  const keys = Object.keys(input);
  return keys.length === 0 ? "" : keys.join(",");
}

function encodeToolUse(id: string, name: string, summary: string): string {
  // Single line so it survives the token transport intact; UI parses on prefix.
  return `[tool_use:${id}:${name}] ${summary}`;
}
function encodeToolResult(id: string, name: string, ok: boolean, body: string): string {
  // Body is newline-separated from the header so UI splits on first \n.
  return `[tool_result:${id}:${name}:${ok ? "ok" : "err"}]\n${body}`;
}
