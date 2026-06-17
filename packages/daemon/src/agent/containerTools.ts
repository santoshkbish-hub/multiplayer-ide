import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ContainerManager, ExecChunk } from "../container/types.js";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function drainExec(it: AsyncIterable<ExecChunk>): Promise<ExecResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for await (const c of it) {
    if (c.stream === "stdout") stdout += c.data;
    else if (c.stream === "stderr") stderr += c.data;
    else if (c.stream === "exit") exitCode = parseInt(c.data, 10);
  }
  return { stdout, stderr, exitCode };
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Inside the container the worktree is bind-mounted at /work — the value `-w /work`
// is set in buildRunArgv. We resolve relative paths against /work.
const WORK = "/work";
function resolveContainerPath(p: string): string {
  if (p.startsWith("/")) return p;
  // No traversal handling here: the container's mount boundary (with tmpfs/empty_ro
  // shadowing on deny paths) is the security control. canUseTool in ClaudeAgent
  // still rejects ".." early for a clearer error.
  return `${WORK}/${p}`;
}

const MAX_READ_BYTES = 256 * 1024;

export interface ContainerToolsDeps {
  containers: ContainerManager;
  sessionId: string;
  // Lets the agent declare its work complete and merge the session branch into
  // main. Returns the merge SHA on success or a failure reason the agent can
  // act on (e.g. "stale" → rebase, "denied_path" → revert the touch).
  publish?: () => Promise<{
    ok: boolean;
    reason?: string;
    merge_sha?: string;
    changed_files?: string[];
  }>;
  status?: (input: { kind?: string; message: string }) => Promise<void>;
  statusRead?: (input: { after_feed_id?: number; limit?: number }) => Promise<string>;
}

// Direct handler signatures so tests can drive the tools without an MCP transport.
// The SDK wraps these via tool(...) below; both call the same underlying functions.
export interface ContainerToolHandlers {
  read: (args: { file_path: string }) => Promise<CallToolResult>;
  write: (args: { file_path: string; content: string }) => Promise<CallToolResult>;
  edit: (args: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }) => Promise<CallToolResult>;
  bash: (args: { command: string; timeout_ms?: number }) => Promise<CallToolResult>;
  status: (args: { kind?: string; message: string }) => Promise<CallToolResult>;
  status_read: (args: { after_feed_id?: number; limit?: number }) => Promise<CallToolResult>;
  publish: (args: Record<string, never>) => Promise<CallToolResult>;
}

const DEFAULT_BASH_TIMEOUT_MS = 60_000;
const MAX_BASH_TIMEOUT_MS = 10 * 60_000;

function normalizeTimeoutMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.ceil(raw), 1_000), MAX_BASH_TIMEOUT_MS);
}

function timeoutArg(ms: number): string {
  return `${Math.ceil(ms / 1_000)}s`;
}

export function buildContainerToolHandlers(deps: ContainerToolsDeps): ContainerToolHandlers {
  return {
    read: async ({ file_path }) => {
      const path = resolveContainerPath(file_path);
      const r = await drainExec(
        deps.containers.exec(deps.sessionId, [
          "sh",
          "-c",
          `head -c ${MAX_READ_BYTES} -- "$1"`,
          "sh",
          path,
        ]),
      );
      if (r.exitCode !== 0) return err(`read failed (${r.exitCode}): ${r.stderr.trim()}`);
      return ok(r.stdout);
    },
    write: async ({ file_path, content }) => {
      const path = resolveContainerPath(file_path);
      const r = await drainExec(
        deps.containers.exec(
          deps.sessionId,
          ["sh", "-c", `mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`, "sh", path],
          { stdin: content },
        ),
      );
      if (r.exitCode !== 0) return err(`write failed (${r.exitCode}): ${r.stderr.trim()}`);
      return ok(`wrote ${content.length} bytes to ${file_path}`);
    },
    edit: async ({ file_path, old_string, new_string, replace_all }) => {
      const path = resolveContainerPath(file_path);
      const cat = await drainExec(deps.containers.exec(deps.sessionId, ["cat", "--", path]));
      if (cat.exitCode !== 0)
        return err(`edit: cannot read ${file_path}: ${cat.stderr.trim()}`);
      const before = cat.stdout;
      const idx = before.indexOf(old_string);
      if (idx === -1) return err(`edit: old_string not found in ${file_path}`);
      let after: string;
      if (replace_all) {
        after = before.split(old_string).join(new_string);
      } else {
        const next = before.indexOf(old_string, idx + old_string.length);
        if (next !== -1)
          return err(`edit: old_string is not unique in ${file_path} (use replace_all)`);
        after = before.slice(0, idx) + new_string + before.slice(idx + old_string.length);
      }
      const w = await drainExec(
        deps.containers.exec(deps.sessionId, ["sh", "-c", `cat > "$1"`, "sh", path], {
          stdin: after,
        }),
      );
      if (w.exitCode !== 0) return err(`edit: write failed: ${w.stderr.trim()}`);
      return ok(`edited ${file_path}`);
    },
    bash: async ({ command, timeout_ms }) => {
      const timeoutMs = normalizeTimeoutMs(timeout_ms);
      const r = await drainExec(
        deps.containers.exec(deps.sessionId, [
          "timeout",
          "-k",
          "5s",
          timeoutArg(timeoutMs),
          "sh",
          "-c",
          command,
        ]),
      );
      const timedOut = r.exitCode === 124 || r.exitCode === 137;
      const body =
        (r.stdout ? r.stdout : "") +
        (r.stderr ? (r.stdout ? "\n" : "") + `[stderr]\n${r.stderr}` : "") +
        (timedOut ? `\n[timed out after ${timeoutMs}ms]` : "") +
        `\n[exit ${r.exitCode}]`;
      return r.exitCode === 0 ? ok(body) : err(body);
    },
    status: async ({ kind, message }) => {
      if (!deps.status) return err("status updates not available in this session");
      const clean = String(message ?? "").replace(/\s+/g, " ").trim();
      if (!clean) return err("status message required");
      await deps.status({
        ...(kind ? { kind: String(kind) } : {}),
        message: clean,
      });
      return ok("status recorded");
    },
    status_read: async ({ after_feed_id, limit }) => {
      if (!deps.statusRead) return err("status feed read not available in this session");
      const text = await deps.statusRead({
        ...(typeof after_feed_id === "number" ? { after_feed_id } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      });
      return ok(text);
    },
    publish: async () => {
      if (!deps.publish) return err("publish not available in this session");
      const r = await deps.publish();
      if (r.ok) {
        const files = r.changed_files?.length
          ? `\nfiles: ${r.changed_files.join(", ")}`
          : "";
        return ok(
          `merged into main at ${r.merge_sha ?? "(unknown sha)"}.${files}\n` +
            `session branch is now fast-forwarded to main; keep iterating on the same branch.`,
        );
      }
      return err(`publish failed: ${r.reason ?? "unknown"}`);
    },
  };
}

export function buildContainerToolServer(
  deps: ContainerToolsDeps,
): McpSdkServerConfigWithInstance {
  const h = buildContainerToolHandlers(deps);
  const readTool = tool(
    "read",
    "Read a file inside the session container. Paths are relative to /work (the session worktree).",
    { file_path: z.string() },
    (args) => h.read(args),
  );
  const writeTool = tool(
    "write",
    "Write a file inside the session container, creating parent directories. Paths are relative to /work.",
    { file_path: z.string(), content: z.string() },
    (args) => h.write(args),
  );
  const editTool = tool(
    "edit",
    "Replace `old_string` with `new_string` in a file inside the session container.",
    {
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    },
    (args) => h.edit(args),
  );
  const bashTool = tool(
    "bash",
    "Run a shell command inside the session container (sh -c). Constrained by container limits and mount plan.",
    { command: z.string(), timeout_ms: z.number().optional() },
    (args) => h.bash(args),
  );
  const publishTool = tool(
    "publish",
    "Declare the current request complete and merge the session branch into main. " +
      "Runs sync + policy validation + required checks under a global lock; on success " +
      "the session branch is fast-forwarded to the new main so you keep iterating on it. " +
      "Call this when you believe the user's requirement is satisfied.",
    {},
    (args) => h.publish(args),
  );
  const statusTool = tool(
    "status",
    "Write a short shared status update for other agents in this same session/container. " +
      "Use this for concise plan/current-work/blocker updates, not verbose reasoning.",
    { kind: z.string().optional(), message: z.string() },
    (args) => h.status(args),
  );
  const statusReadTool = tool(
    "status_read",
    "Read shared status feed rows for this same session/container. " +
      "Use after_feed_id to continue from a known incremental feed id.",
    { after_feed_id: z.number().optional(), limit: z.number().optional() },
    (args) => h.status_read(args),
  );

  return createSdkMcpServer({
    name: "container",
    version: "0.0.1",
    instructions:
      "All file and shell tools route through the per-session sandbox container. " +
      "Paths are relative to /work (the session worktree). Call `publish` to merge " +
      "into main when the user's requirement looks complete.",
    tools: [readTool, writeTool, editTool, bashTool, statusTool, statusReadTool, publishTool],
  });
}
