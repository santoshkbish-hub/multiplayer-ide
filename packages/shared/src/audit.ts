export type AuditKind =
  | "prompt"
  | "command"
  | "file_change"
  | "owner_changed"
  | "publish"
  | "merge"
  | "error";

export interface AuditRecord {
  seq: number;
  ts: string;
  session_id: string;
  actor_user_id: string;
  kind: AuditKind;
  detail: Record<string, unknown>;
}
