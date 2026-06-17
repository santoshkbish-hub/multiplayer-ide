import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

export type AdditionalContextHookEvent = "UserPromptSubmit" | "PostToolBatch";

export interface AdditionalContextProviderInput {
  event: AdditionalContextHookEvent;
  session_id: string;
  chat_id?: string;
  input: HookInput;
}

export type AdditionalContextProvider = (
  input: AdditionalContextProviderInput,
) => Promise<string | null | undefined> | string | null | undefined;

export function buildAdditionalContextHooks(
  sessionId: string,
  chatId: string | undefined,
  providers: AdditionalContextProvider[] = [],
): Partial<Record<AdditionalContextHookEvent, HookCallbackMatcher[]>> | undefined {
  if (providers.length === 0) return undefined;
  return {
    UserPromptSubmit: [{ hooks: [makeHook("UserPromptSubmit", sessionId, chatId, providers)] }],
    PostToolBatch: [{ hooks: [makeHook("PostToolBatch", sessionId, chatId, providers)] }],
  };
}

function makeHook(
  event: AdditionalContextHookEvent,
  sessionId: string,
  chatId: string | undefined,
  providers: AdditionalContextProvider[],
): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    const chunks: string[] = [];
    for (const provider of providers) {
      const chunk = await provider({
        event,
        session_id: sessionId,
        ...(chatId ? { chat_id: chatId } : {}),
        input,
      });
      if (chunk && chunk.trim()) chunks.push(chunk.trim());
    }
    if (chunks.length === 0) return {};
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: chunks.join("\n\n"),
      },
    };
  };
}
