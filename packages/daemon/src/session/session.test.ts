import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { DEFAULT_POLICY } from "@collab/shared";
import { openDb } from "../store/db.js";
import { SessionRepo } from "../store/sessions.js";
import { AuditRepo } from "../store/audit.js";
import { CapabilityIssuer } from "./capability.js";
import { SessionManager } from "./manager.js";

function newManager() {
  const db = openDb(":memory:");
  const sessions = new SessionRepo(db);
  const audit = new AuditRepo(db);
  const caps = new CapabilityIssuer(randomBytes(32));
  const sm = new SessionManager({ sessions, audit, caps });
  return { sm, sessions, audit, caps, db };
}

describe("SessionManager M2", () => {
  let env: ReturnType<typeof newManager>;
  beforeEach(() => {
    env = newManager();
  });

  it("creates a session with the owner as the sole participant", () => {
    const s = env.sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc123",
    });
    expect(s.owner_user_id).toBe("alice");
    expect(s.owner_epoch).toBe(1);
    expect(s.participants).toHaveLength(1);
    expect(s.participants[0]).toMatchObject({ user_id: "alice", role: "owner" });
  });

  it("a fresh owner capability validates and submits prompts", () => {
    const s = env.sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc",
    });
    const cap = env.sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    const res = env.sm.submitPrompt(cap, "hello");
    expect(res.ok).toBe(true);
    expect(env.sm.pendingPrompts(s.session_id)).toHaveLength(1);
  });

  it("rejects tampered signatures", () => {
    const s = env.sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc",
    });
    const cap = env.sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    const tampered = { ...cap, sig: cap.sig.slice(0, -2) + "AA" };
    const v = env.sm.verifyCapability(tampered, "owner");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("bad_sig");
  });

  it("delegation bumps epoch and invalidates the prior owner's capability", () => {
    const s = env.sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc",
    });
    env.sm.joinSession(s.session_id, "bob", "reader");

    const aliceCap = env.sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    expect(env.sm.submitPrompt(aliceCap, "first").ok).toBe(true);

    const { new_epoch, cancelled_prompt_ids } = env.sm.delegateOwner(s.session_id, "bob");
    expect(new_epoch).toBe(2);
    expect(cancelled_prompt_ids).toHaveLength(1);
    expect(env.sm.pendingPrompts(s.session_id)).toHaveLength(0);

    const stale = env.sm.submitPrompt(aliceCap, "should fail");
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("epoch_stale");

    const bobCap = env.sm.issueCapability(s.session_id, "bob", "owner", ["prompt"]);
    expect(env.sm.submitPrompt(bobCap, "now mine").ok).toBe(true);
  });

  it("expired capabilities are rejected", () => {
    const db = openDb(":memory:");
    const sessions = new SessionRepo(db);
    const audit = new AuditRepo(db);
    let t = 1_000_000;
    const caps = new CapabilityIssuer(randomBytes(32), () => t);
    const sm = new SessionManager({
      sessions,
      audit,
      caps,
      now: () => new Date(t),
      capTtlMs: 1000,
    });
    const s = sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc",
    });
    const cap = sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    t += 2000;
    const v = sm.verifyCapability(cap, "owner");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("audit log is monotonic per session", () => {
    const s = env.sm.createSession({
      owner_user_id: "alice",
      policy: DEFAULT_POLICY,
      base_main_sha: "abc",
    });
    const cap = env.sm.issueCapability(s.session_id, "alice", "owner", ["prompt"]);
    env.sm.submitPrompt(cap, "one");
    env.sm.submitPrompt(cap, "two");
    const log = env.audit.list(s.session_id);
    const seqs = log.map((r) => r.seq);
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1];
      const cur = seqs[i];
      if (prev === undefined || cur === undefined) throw new Error("seq missing");
      expect(cur).toBe(prev + 1);
    }
  });
});
