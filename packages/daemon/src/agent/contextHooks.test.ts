import { describe, expect, it } from "vitest";
import { buildAdditionalContextHooks } from "./contextHooks.js";

describe("additional context hooks", () => {
  it("uses the same providers for UserPromptSubmit and PostToolBatch", async () => {
    const hooks = buildAdditionalContextHooks("sess_1", "chat_1", [
      ({ event, session_id }) => `${event}:${session_id}`,
    ]);
    expect(hooks).toBeDefined();

    const promptOut = await hooks!.UserPromptSubmit![0]!.hooks[0]!(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sdk-session",
        transcript_path: "/tmp/t",
        cwd: "/work",
        prompt: "hi",
      },
      undefined,
      { signal: new AbortController().signal },
    );
    const batchOut = await hooks!.PostToolBatch![0]!.hooks[0]!(
      {
        hook_event_name: "PostToolBatch",
        session_id: "sdk-session",
        transcript_path: "/tmp/t",
        cwd: "/work",
        tool_calls: [],
      },
      undefined,
      { signal: new AbortController().signal },
    );

    expect(promptOut).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "UserPromptSubmit:sess_1",
      },
    });
    expect(batchOut).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: "PostToolBatch:sess_1",
      },
    });
  });

  it("combines non-empty provider output", async () => {
    const hooks = buildAdditionalContextHooks("sess_1", "chat_1", [
      () => "one",
      () => "",
      async () => "two",
    ]);
    const out = await hooks!.UserPromptSubmit![0]!.hooks[0]!(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sdk-session",
        transcript_path: "/tmp/t",
        cwd: "/work",
        prompt: "hi",
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        additionalContext: "one\n\ntwo",
      },
    });
  });

  it("passes chat_id to providers", async () => {
    const hooks = buildAdditionalContextHooks("sess_1", "chat_9", [
      ({ session_id, chat_id }) => `${session_id}:${chat_id}`,
    ]);
    const out = await hooks!.UserPromptSubmit![0]!.hooks[0]!(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "sdk-session",
        transcript_path: "/tmp/t",
        cwd: "/work",
        prompt: "hi",
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        additionalContext: "sess_1:chat_9",
      },
    });
  });
});
