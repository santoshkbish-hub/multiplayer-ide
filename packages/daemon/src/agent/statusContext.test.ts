import { describe, expect, it } from "vitest";
import { openDb } from "../store/db.js";
import { AgentStatusRepo } from "../store/agentStatus.js";
import { AgentStatusContextProvider } from "./statusContext.js";

describe("AgentStatusContextProvider", () => {
  it("returns current time and only unseen shared status rows", () => {
    const db = openDb(":memory:");
    try {
      const repo = new AgentStatusRepo(db);
      const provider = new AgentStatusContextProvider({
        status: repo,
        now: () => new Date("2026-06-17T03:30:00.000Z"),
      });
      repo.append("sess_1", "alice:chat_a", "plan", "editing app.js picker", {
        chat_id: "chat_a",
        ts: "2026-06-17T03:29:00.000Z",
      });

      const first = provider.getContext("sess_1", "chat_b");
      expect(first).toContain("current time: 2026-06-17T03:30:00.000Z");
      expect(first).toContain("[feed_id=1]");
      expect(first).toContain("agent=alice:chat_a chat=chat_a kind=plan");
      expect(first).toContain("editing app.js picker");

      const second = provider.getContext("sess_1", "chat_b");
      expect(second).toContain("No new shared status rows");
      expect(second).not.toContain("editing app.js picker");
    } finally {
      db.close();
    }
  });

  it("tracks last injected feed id independently per chat", () => {
    const db = openDb(":memory:");
    try {
      const repo = new AgentStatusRepo(db);
      const provider = new AgentStatusContextProvider({
        status: repo,
        now: () => new Date("2026-06-17T03:35:00.000Z"),
      });
      repo.append("sess_1", "alice:chat_a", "plan", "first", { chat_id: "chat_a" });

      expect(provider.getContext("sess_1", "chat_a")).toContain("[feed_id=1]");
      expect(provider.getContext("sess_1", "chat_a")).not.toContain("[feed_id=1]");
      expect(provider.getContext("sess_1", "chat_b")).toContain("[feed_id=1]");

      repo.append("sess_1", "bob:chat_b", "edit", "second", { chat_id: "chat_b" });
      const chatA = provider.getContext("sess_1", "chat_a");
      expect(chatA).toContain("[feed_id=2]");
      expect(chatA).not.toContain("[feed_id=1]");
    } finally {
      db.close();
    }
  });
});
