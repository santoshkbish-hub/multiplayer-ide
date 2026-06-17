import type { AgentContext, AgentEvent, AgentRunner } from "./runner.js";

export type ScriptedAction =
  | { type: "say"; text: string }
  | { type: "edit"; path: string; content: string }
  | { type: "command"; argv: string[]; stub_output?: string };

export interface ScriptedScript {
  actions: ScriptedAction[];
}

/**
 * Prompts are JSON action lists, e.g.:
 *   {"actions":[{"type":"edit","path":"src/foo.ts","content":"..."}]}
 *
 * Falls back to a single token echo if the prompt isn't valid JSON.
 */
export class ScriptedAgent implements AgentRunner {
  async *run(ctx: AgentContext, prompt: string): AsyncIterable<AgentEvent> {
    const script = parsePrompt(prompt);
    if (!script) {
      yield { kind: "token", data: prompt };
      yield { kind: "done" };
      return;
    }
    for (const a of script.actions) {
      if (a.type === "say") {
        yield { kind: "token", data: a.text };
      } else if (a.type === "edit") {
        const res = ctx.workspace.write(a.path, a.content);
        const evt: AgentEvent = res.ok
          ? { kind: "edit", path: a.path, ok: true }
          : { kind: "edit", path: a.path, ok: false, reason: res.reason };
        yield evt;
      } else if (a.type === "command") {
        yield {
          kind: "command",
          argv: a.argv,
          ok: true,
          output: a.stub_output ?? "",
        };
      }
    }
    yield { kind: "done" };
  }
}

function parsePrompt(p: string): ScriptedScript | null {
  try {
    const j = JSON.parse(p) as ScriptedScript;
    if (!j || !Array.isArray(j.actions)) return null;
    return j;
  } catch {
    return null;
  }
}
