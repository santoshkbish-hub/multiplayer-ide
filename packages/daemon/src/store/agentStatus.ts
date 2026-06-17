import type { Database as Db } from "better-sqlite3";

export interface AgentStatusRow {
  session_id: string;
  seq: number;
  ts: string;
  agent_id: string;
  chat_id?: string;
  kind: string;
  message: string;
}

export class AgentStatusRepo {
  constructor(private db: Db) {}

  append(
    session_id: string,
    agent_id: string,
    kind: string,
    message: string,
    opts: { chat_id?: string; ts?: string } = {},
  ): AgentStatusRow {
    const cleanKind = compact(kind || "status", 32);
    const cleanMessage = compact(message, 300);
    const ts = opts.ts ?? new Date().toISOString();
    const txn = this.db.transaction((): AgentStatusRow => {
      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM agent_status WHERE session_id = ?`)
        .get(session_id) as { m: number };
      const seq = row.m + 1;
      this.db
        .prepare(
          `INSERT INTO agent_status(session_id, seq, ts, agent_id, chat_id, kind, message)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(session_id, seq, ts, agent_id, opts.chat_id ?? null, cleanKind, cleanMessage);
      return {
        session_id,
        seq,
        ts,
        agent_id,
        ...(opts.chat_id ? { chat_id: opts.chat_id } : {}),
        kind: cleanKind,
        message: cleanMessage,
      };
    });
    return txn();
  }

  listSince(session_id: string, afterSeq = 0, limit = 20): AgentStatusRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_status
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(session_id, afterSeq, limit) as Array<{
      session_id: string;
      seq: number;
      ts: string;
      agent_id: string;
      chat_id: string | null;
      kind: string;
      message: string;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      seq: r.seq,
      ts: r.ts,
      agent_id: r.agent_id,
      ...(r.chat_id ? { chat_id: r.chat_id } : {}),
      kind: r.kind,
      message: r.message,
    }));
  }
}

function compact(value: string, max: number): string {
  const oneLine = String(value).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
