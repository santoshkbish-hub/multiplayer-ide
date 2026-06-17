import type { Database as Db } from "better-sqlite3";
import type {
  PermissionPolicy,
  Session,
  SessionStatus,
  Participant,
  Role,
} from "@collab/shared";

interface SessionRow {
  session_id: string;
  branch_name: string;
  worktree_path: string | null;
  base_main_sha: string;
  last_head_sha: string | null;
  owner_user_id: string;
  owner_epoch: number;
  policy_json: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  session_id: string;
  user_id: string;
  role: Role;
  capabilities_json: string;
}

export class SessionRepo {
  constructor(private db: Db) {}

  insert(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions(session_id, branch_name, worktree_path, base_main_sha, last_head_sha,
                              owner_user_id, owner_epoch, policy_json, status, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.session_id,
        s.branch_name,
        s.worktree_path ?? null,
        s.base_main_sha,
        s.last_head_sha ?? null,
        s.owner_user_id,
        s.owner_epoch,
        JSON.stringify(s.policy),
        s.status,
        s.created_at,
        s.updated_at,
      );
    for (const p of s.participants) this.upsertParticipant(s.session_id, p);
  }

  upsertParticipant(session_id: string, p: Participant): void {
    this.db
      .prepare(
        `INSERT INTO participants(session_id, user_id, role, capabilities_json)
         VALUES(?,?,?,?)
         ON CONFLICT(session_id, user_id) DO UPDATE SET role=excluded.role, capabilities_json=excluded.capabilities_json`,
      )
      .run(session_id, p.user_id, p.role, JSON.stringify(p.capabilities));
  }

  get(session_id: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(session_id) as SessionRow | undefined;
    if (!row) return null;
    const participants = (this.db
      .prepare(`SELECT * FROM participants WHERE session_id = ?`)
      .all(session_id) as ParticipantRow[]).map((p) => ({
      user_id: p.user_id,
      role: p.role,
      capabilities: JSON.parse(p.capabilities_json) as string[],
    }));
    return rowToSession(row, participants);
  }

  listByStatus(status: SessionStatus): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status = ?`)
      .all(status) as SessionRow[];
    return rows.map((r) => {
      const ps = (this.db
        .prepare(`SELECT * FROM participants WHERE session_id = ?`)
        .all(r.session_id) as ParticipantRow[]).map((p) => ({
        user_id: p.user_id,
        role: p.role,
        capabilities: JSON.parse(p.capabilities_json) as string[],
      }));
      return rowToSession(r, ps);
    });
  }

  listAll(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .all() as SessionRow[];
    return rows.map((r) => {
      const ps = (this.db
        .prepare(`SELECT * FROM participants WHERE session_id = ?`)
        .all(r.session_id) as ParticipantRow[]).map((p) => ({
        user_id: p.user_id,
        role: p.role,
        capabilities: JSON.parse(p.capabilities_json) as string[],
      }));
      return rowToSession(r, ps);
    });
  }

  setStatus(session_id: string, status: SessionStatus, now: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(status, now, session_id);
  }

  setWorktree(session_id: string, worktree_path: string | null, now: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET worktree_path = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(worktree_path, now, session_id);
  }

  setHead(session_id: string, head: string, now: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET last_head_sha = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(head, now, session_id);
  }

  // Atomic: switch owner + bump epoch, return new epoch.
  rotateOwner(
    session_id: string,
    new_owner_user_id: string,
    now: string,
  ): number {
    const txn = this.db.transaction((sid: string, nid: string, ts: string): number => {
      const row = this.db
        .prepare(
          `SELECT owner_user_id, owner_epoch FROM sessions WHERE session_id = ?`,
        )
        .get(sid) as { owner_user_id: string; owner_epoch: number } | undefined;
      if (!row) throw new Error("session_not_found");
      const newEpoch = row.owner_epoch + 1;
      this.db
        .prepare(
          `UPDATE sessions SET owner_user_id = ?, owner_epoch = ?, updated_at = ? WHERE session_id = ?`,
        )
        .run(nid, newEpoch, ts, sid);
      // Demote prior owner if present; promote new owner.
      this.db
        .prepare(
          `UPDATE participants SET role = 'reader', capabilities_json = ? WHERE session_id = ? AND user_id = ?`,
        )
        .run(JSON.stringify(["observe"]), sid, row.owner_user_id);
      this.db
        .prepare(
          `INSERT INTO participants(session_id, user_id, role, capabilities_json)
           VALUES(?,?,?,?)
           ON CONFLICT(session_id, user_id) DO UPDATE SET role='owner', capabilities_json=excluded.capabilities_json`,
        )
        .run(sid, nid, "owner", JSON.stringify(["observe", "prompt"]));
      return newEpoch;
    });
    return txn(session_id, new_owner_user_id, now);
  }
}

function rowToSession(row: SessionRow, participants: Participant[]): Session {
  const session: Session = {
    session_id: row.session_id,
    branch_name: row.branch_name,
    base_main_sha: row.base_main_sha,
    owner_user_id: row.owner_user_id,
    owner_epoch: row.owner_epoch,
    participants,
    policy: JSON.parse(row.policy_json) as PermissionPolicy,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.worktree_path) session.worktree_path = row.worktree_path;
  if (row.last_head_sha) session.last_head_sha = row.last_head_sha;
  return session;
}
