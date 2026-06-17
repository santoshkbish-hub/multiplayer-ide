import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AgentStatusRepo } from "./agentStatus.js";

describe("AgentStatusRepo", () => {
  it("assigns incremental feed ids per session and clamps messages", () => {
    const db = openDb(":memory:");
    try {
      const repo = new AgentStatusRepo(db);
      const a = repo.append("sess_1", "alice:chat_a", "plan", "first", {
        chat_id: "chat_a",
        ts: "2026-06-17T03:00:00.000Z",
      });
      const b = repo.append("sess_1", "bob:chat_b", "edit", "x".repeat(400), {
        chat_id: "chat_b",
        ts: "2026-06-17T03:01:00.000Z",
      });
      const c = repo.append("sess_2", "carol:chat_c", "plan", "other session");

      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(c.seq).toBe(1);

      const rows = repo.listSince("sess_1", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.seq).toBe(2);
      expect(rows[0]?.message.length).toBeLessThanOrEqual(300);
      expect(rows[0]?.message.endsWith("…")).toBe(true);
    } finally {
      db.close();
    }
  });
});
