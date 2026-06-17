import { describe, it, expect } from "vitest";
import type { MountPlan } from "@collab/shared";
import { buildContainerToolHandlers } from "./containerTools.js";
import type {
  ContainerManager,
  ExecChunk,
  ExecOpts,
} from "../container/types.js";

class FakeContainers implements ContainerManager {
  calls: Array<{ session: string; argv: string[]; opts: ExecOpts }> = [];
  scripts: Record<string, ExecChunk[]> = {};
  async create(_id: string, _plan: MountPlan): Promise<string> {
    return "fake";
  }
  async destroy(_id: string): Promise<void> {}
  exec(session: string, argv: string[], opts: ExecOpts = {}): AsyncIterable<ExecChunk> {
    this.calls.push({ session, argv, opts });
    // Match on first arg + last arg (typical: ["sh","-c","...","sh","/work/...."])
    const key = argv.join(" ");
    const script =
      this.scripts[key] ??
      this.scripts[argv[0] ?? ""] ?? [{ stream: "exit", data: "0" }];
    return (async function* () {
      for (const c of script) yield c;
    })();
  }
}

function firstText(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected first content block to be text");
  }
  return first.text;
}

describe("container-backed MCP tools", () => {
  it("read tool routes through ContainerManager.exec with cat-like command", async () => {
    const c = new FakeContainers();
    c.scripts["sh -c head -c 262144 -- \"$1\" sh /work/src/foo.ts"] = [
      { stream: "stdout", data: "hello\n" },
      { stream: "exit", data: "0" },
    ];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.read({ file_path: "src/foo.ts" });
    expect(r.isError).toBeUndefined();
    expect(firstText(r.content)).toBe("hello\n");
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.session).toBe("sess_1");
    expect(c.calls[0]?.argv).toEqual([
      "sh",
      "-c",
      `head -c 262144 -- "$1"`,
      "sh",
      "/work/src/foo.ts",
    ]);
  });

  it("write tool sends content via stdin to a container-side cat redirect", async () => {
    const c = new FakeContainers();
    c.scripts["sh"] = [{ stream: "exit", data: "0" }];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.write({
      file_path: "src/foo.ts",
      content: "export const x = 1;\n",
    });
    expect(r.isError).toBeUndefined();
    const call = c.calls[0]!;
    expect(call.argv[0]).toBe("sh");
    expect(call.argv[1]).toBe("-c");
    expect(call.argv[2]).toContain("mkdir -p");
    expect(call.argv[2]).toContain("cat > ");
    expect(call.argv[4]).toBe("/work/src/foo.ts");
    expect(call.opts.stdin).toBe("export const x = 1;\n");
  });

  it("edit tool reads then writes through the container", async () => {
    const c = new FakeContainers();
    c.scripts["cat -- /work/src/foo.ts"] = [
      { stream: "stdout", data: "let x = 1;\n" },
      { stream: "exit", data: "0" },
    ];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.edit({
      file_path: "src/foo.ts",
      old_string: "x = 1",
      new_string: "x = 42",
    });
    expect(r.isError).toBeUndefined();
    // Two calls: cat then write
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0]?.argv).toEqual(["cat", "--", "/work/src/foo.ts"]);
    expect(c.calls[1]?.opts.stdin).toBe("let x = 42;\n");
  });

  it("edit tool errors when old_string is missing", async () => {
    const c = new FakeContainers();
    c.scripts["cat -- /work/src/foo.ts"] = [
      { stream: "stdout", data: "hello\n" },
      { stream: "exit", data: "0" },
    ];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.edit({
      file_path: "src/foo.ts",
      old_string: "absent",
      new_string: "x",
    });
    expect(r.isError).toBe(true);
    expect(firstText(r.content)).toContain("not found");
  });

  it("bash tool runs sh -c inside the container and returns combined output", async () => {
    const c = new FakeContainers();
    c.scripts["timeout -k 5s 60s sh -c npm test"] = [
      { stream: "stdout", data: "PASS\n" },
      { stream: "exit", data: "0" },
    ];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.bash({ command: "npm test" });
    expect(r.isError).toBeUndefined();
    expect(firstText(r.content)).toContain("PASS");
    expect(firstText(r.content)).toContain("[exit 0]");
    expect(c.calls[0]?.argv).toEqual([
      "timeout",
      "-k",
      "5s",
      "60s",
      "sh",
      "-c",
      "npm test",
    ]);
  });

  it("bash tool marks non-zero exit as isError", async () => {
    const c = new FakeContainers();
    c.scripts["timeout -k 5s 60s sh -c false"] = [{ stream: "exit", data: "1" }];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.bash({ command: "false" });
    expect(r.isError).toBe(true);
    expect(firstText(r.content)).toContain("[exit 1]");
  });

  it("bash tool honors timeout_ms and reports command timeout exits", async () => {
    const c = new FakeContainers();
    c.scripts["timeout -k 5s 2s sh -c sleep 30"] = [
      { stream: "exit", data: "124" },
    ];
    const tools = buildContainerToolHandlers({ containers: c, sessionId: "sess_1" });
    const r = await tools.bash({ command: "sleep 30", timeout_ms: 1500 });
    expect(r.isError).toBe(true);
    expect(firstText(r.content)).toContain("[timed out after 1500ms]");
    expect(firstText(r.content)).toContain("[exit 124]");
  });

  it("status tool writes a concise shared status update", async () => {
    const updates: Array<{ kind?: string; message: string }> = [];
    const tools = buildContainerToolHandlers({
      containers: new FakeContainers(),
      sessionId: "sess_1",
      status: async (input) => {
        updates.push(input);
      },
    });
    const r = await tools.status({
      kind: "plan",
      message: "  update app.js session picker   ",
    });
    expect(r.isError).toBeUndefined();
    expect(firstText(r.content)).toContain("status recorded");
    expect(updates).toEqual([
      { kind: "plan", message: "update app.js session picker" },
    ]);
  });

  it("status_read tool reads shared status rows", async () => {
    const tools = buildContainerToolHandlers({
      containers: new FakeContainers(),
      sessionId: "sess_1",
      statusRead: async (input) =>
        `after=${input.after_feed_id ?? 0} limit=${input.limit ?? 20}`,
    });
    const r = await tools.status_read({ after_feed_id: 3, limit: 5 });
    expect(r.isError).toBeUndefined();
    expect(firstText(r.content)).toBe("after=3 limit=5");
  });
});
