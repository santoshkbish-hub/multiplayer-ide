import type { AuditRepo } from "../store/audit.js";
import type { ChatRepo, ChatRow } from "../store/chat.js";
import type { AuditRecord } from "@collab/shared";

export interface ReplayCursor {
  chat_seq: number;
  event_seq: number;
}

export interface ReplayBundle {
  chat: ChatRow[];
  events: AuditRecord[];
  cursor: ReplayCursor;
}

export class Replay {
  constructor(private chat: ChatRepo, private audit: AuditRepo) {}

  bundle(
    session_id: string,
    since: Partial<ReplayCursor> = {},
    chat_id = "default",
  ): ReplayBundle {
    const chatRows = this.chat.list(session_id, since.chat_seq ?? 0, chat_id);
    const events = this.audit.list(session_id, since.event_seq ?? 0);
    const cursor: ReplayCursor = {
      chat_seq: chatRows.length ? chatRows[chatRows.length - 1]!.seq : (since.chat_seq ?? 0),
      event_seq: events.length ? events[events.length - 1]!.seq : (since.event_seq ?? 0),
    };
    return { chat: chatRows, events, cursor };
  }
}
