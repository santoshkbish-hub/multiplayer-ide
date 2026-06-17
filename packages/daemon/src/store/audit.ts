import type { Database as Db } from "better-sqlite3";
import type { AuditKind, AuditRecord } from "@collab/shared";

export class AuditRepo {
  constructor(private db: Db) {}

  append(
    session_id: string,
    actor_user_id: string,
    kind: AuditKind,
    detail: Record<string, unknown>,
    now = new Date().toISOString(),
  ): AuditRecord {
    const txn = this.db.transaction((): AuditRecord => {
      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?`)
        .get(session_id) as { m: number };
      const seq = row.m + 1;
      this.db
        .prepare(
          `INSERT INTO events(session_id, seq, ts, actor_user_id, kind, detail_json) VALUES(?,?,?,?,?,?)`,
        )
        .run(session_id, seq, now, actor_user_id, kind, JSON.stringify(detail));
      return { seq, ts: now, session_id, actor_user_id, kind, detail };
    });
    return txn();
  }

  list(session_id: string, fromSeq = 0): AuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(session_id, fromSeq) as Array<{
      session_id: string;
      seq: number;
      ts: string;
      actor_user_id: string;
      kind: AuditKind;
      detail_json: string;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      seq: r.seq,
      ts: r.ts,
      actor_user_id: r.actor_user_id,
      kind: r.kind,
      detail: JSON.parse(r.detail_json) as Record<string, unknown>,
    }));
  }
}
