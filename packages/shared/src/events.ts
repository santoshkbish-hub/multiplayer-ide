import type { Capability } from "./capability.js";
import type { Role } from "./session.js";

export interface BaseEvent {
  session_id: string;
  chat_id?: string;
  ts?: string;
  seq?: number;
}

export interface PresenceUpdate extends BaseEvent {
  type: "presence.update";
  user_id: string;
  online: boolean;
}

export interface CursorUpdate extends BaseEvent {
  type: "cursor.update";
  user_id: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface ChatMessage extends BaseEvent {
  type: "chat.message";
  user_id: string;
  text: string;
}

export interface AgentPrompt extends BaseEvent {
  type: "agent.prompt";
  prompt_id: string;
  capability: Capability;
  text: string;
}

export interface CommandRequest extends BaseEvent {
  type: "command.request";
  request_id: string;
  capability: Capability;
  argv: string[];
}

export interface CommandOutput extends BaseEvent {
  type: "command.output";
  request_id: string;
  stream: "stdout" | "stderr" | "exit";
  data: string;
}

export interface AgentToken extends BaseEvent {
  type: "agent.token";
  prompt_id: string;
  data: string;
  done?: boolean;
}

export interface OwnerChanged extends BaseEvent {
  type: "owner.changed";
  new_owner: string;
  epoch: number;
}

export interface PublishStatus extends BaseEvent {
  type: "publish.status";
  phase: "start" | "sync" | "validate" | "checks" | "merge" | "done" | "failed";
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface SessionEnded extends BaseEvent {
  type: "session.ended";
  reason?: string;
}

export interface FilesChanged extends BaseEvent {
  type: "files.changed";
  changes: { path: string; kind: "add" | "change" | "unlink" }[];
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export type WireEvent =
  | PresenceUpdate
  | CursorUpdate
  | ChatMessage
  | AgentPrompt
  | CommandRequest
  | CommandOutput
  | AgentToken
  | OwnerChanged
  | PublishStatus
  | SessionEnded
  | FilesChanged
  | ErrorEvent;

export type WireEventType = WireEvent["type"];

export interface HandshakeAuth {
  kind: "daemon" | "client";
  token: string;
  session_id?: string;
  user_id?: string;
  role?: Role;
  chat_id?: string;
  since_chat_seq?: number;
  since_event_seq?: number;
}
