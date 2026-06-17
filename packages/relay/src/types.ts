import type { Role } from "@collab/shared";

export interface InviteClaims {
  session_id: string;
  user_id: string;
  role: Role;
}

export interface SocketDataDaemon {
  kind: "daemon";
}

export interface SocketDataClient extends InviteClaims {
  kind: "client";
  chat_id?: string;
  since_chat_seq?: number;
  since_event_seq?: number;
}

export type SocketData = SocketDataDaemon | SocketDataClient;
