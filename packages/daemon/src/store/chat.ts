import type { Database as Db } from "better-sqlite3";

export interface ChatRow {
  session_id: string;
  chat_id: string;
  seq: number;
  ts: string;
  user_id: string;
  text: string;
}

export class ChatRepo {
  constructor(private db: Db) {}

  append(
    session_id: string,
    user_id: string,
    text: string,
    chat_id = "default",
    ts = new Date().toISOString(),
  ): ChatRow {
    const txn = this.db.transaction((): ChatRow => {
      const row = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM chat WHERE session_id = ?`)
        .get(session_id) as { m: number };
      const seq = row.m + 1;
      this.db
        .prepare(`INSERT INTO chat(session_id, chat_id, seq, ts, user_id, text) VALUES(?,?,?,?,?,?)`)
        .run(session_id, chat_id, seq, ts, user_id, text);
      return { session_id, chat_id, seq, ts, user_id, text };
    });
    return txn();
  }

  list(session_id: string, fromSeq = 0, chat_id = "default"): ChatRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat WHERE session_id = ? AND chat_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(session_id, chat_id, fromSeq) as ChatRow[];
  }
}
