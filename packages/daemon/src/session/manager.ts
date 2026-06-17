import { randomUUID } from "node:crypto";
import type {
  Capability,
  PermissionPolicy,
  Role,
  Session,
} from "@collab/shared";
import { SessionRepo } from "../store/sessions.js";
import { AuditRepo } from "../store/audit.js";
import { CapabilityIssuer, type CapVerifyResult } from "./capability.js";

type FailReason = Exclude<CapVerifyResult, { ok: true }>["reason"];

export interface CreateSessionInput {
  owner_user_id: string;
  policy: PermissionPolicy;
  base_main_sha: string;
}

export interface PendingPrompt {
  prompt_id: string;
  session_id: string;
  chat_id?: string;
  user_id: string;
  text: string;
  owner_epoch: number;
}

export type SubmitResult =
  | { ok: true; prompt_id: string }
  | { ok: false; reason: FailReason };

export interface DelegateResult {
  new_epoch: number;
  cancelled_prompt_ids: string[];
}

export interface SessionManagerDeps {
  sessions: SessionRepo;
  audit: AuditRepo;
  caps: CapabilityIssuer;
  now?: () => Date;
  uuid?: () => string;
  capTtlMs?: number;
}

export class SessionManager {
  private pending = new Map<string, PendingPrompt[]>(); // session_id -> queue

  // Test seam: expose deps so callers (and tests) can reach the repo for
  // operations the manager doesn't yet wrap (e.g. setWorktree).
  public readonly deps: SessionManagerDeps;
  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  private nowIso(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }
  private nowMs(): number {
    return (this.deps.now ? this.deps.now() : new Date()).getTime();
  }
  private id(prefix: string): string {
    const u = this.deps.uuid ? this.deps.uuid() : randomUUID();
    return `${prefix}_${u}`;
  }

  createSession(input: CreateSessionInput): Session {
    const session_id = this.id("sess");
    const branch_name = `collab/session-${session_id}`;
    const now = this.nowIso();
    const session: Session = {
      session_id,
      branch_name,
      base_main_sha: input.base_main_sha,
      owner_user_id: input.owner_user_id,
      owner_epoch: 1,
      participants: [
        {
          user_id: input.owner_user_id,
          role: "owner",
          capabilities: ["observe", "prompt"],
        },
      ],
      policy: input.policy,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    this.deps.sessions.insert(session);
    this.pending.set(session_id, []);
    this.deps.audit.append(session_id, input.owner_user_id, "owner_changed", {
      from: null,
      to: input.owner_user_id,
      epoch: 1,
    }, now);
    return session;
  }

  getSession(session_id: string): Session | null {
    return this.deps.sessions.get(session_id);
  }

  joinSession(session_id: string, user_id: string, role: Role = "reader"): Session {
    const s = this.deps.sessions.get(session_id);
    if (!s) throw new Error("session_not_found");
    const caps = role === "owner" ? ["observe", "prompt"] : ["observe"];
    this.deps.sessions.upsertParticipant(session_id, {
      user_id,
      role,
      capabilities: caps,
    });
    const fresh = this.deps.sessions.get(session_id);
    if (!fresh) throw new Error("session_vanished");
    return fresh;
  }

  endSession(session_id: string, reason = "ended"): void {
    const now = this.nowIso();
    this.deps.sessions.setStatus(session_id, "ended", now);
    this.pending.delete(session_id);
    this.deps.audit.append(session_id, "system", "error", { reason }, now);
  }

  issueCapability(
    session_id: string,
    user_id: string,
    role: Role,
    scope: string[],
  ): Capability {
    const s = this.deps.sessions.get(session_id);
    if (!s) throw new Error("session_not_found");
    const ttl = this.deps.capTtlMs ?? 15 * 60_000;
    return this.deps.caps.sign({
      session_id,
      user_id,
      role,
      scope,
      owner_epoch: s.owner_epoch,
      exp: this.nowMs() + ttl,
    });
  }

  verifyCapability(cap: Capability, requiredRole?: Role): CapVerifyResult {
    const s = this.deps.sessions.get(cap.session_id);
    if (!s) return { ok: false, reason: "session_mismatch" };
    return this.deps.caps.verify(cap, {
      session_id: s.session_id,
      required_epoch: s.owner_epoch,
      required_role: requiredRole,
    });
  }

  submitPrompt(
    cap: Capability,
    text: string,
    preferredId?: string,
    chatId?: string,
  ): SubmitResult {
    const v = this.verifyCapability(cap, "owner");
    if (!v.ok) return { ok: false, reason: v.reason };
    const s = this.deps.sessions.get(cap.session_id);
    if (!s) return { ok: false, reason: "session_mismatch" };
    const prompt_id = preferredId ?? this.id("p");
    const queue = this.pending.get(cap.session_id) ?? [];
    queue.push({
      prompt_id,
      session_id: cap.session_id,
      ...(chatId ? { chat_id: chatId } : {}),
      user_id: cap.user_id,
      text,
      owner_epoch: cap.owner_epoch,
    });
    this.pending.set(cap.session_id, queue);
    this.deps.audit.append(cap.session_id, cap.user_id, "prompt", {
      prompt_id,
      text_preview: text.slice(0, 120),
    });
    return { ok: true, prompt_id };
  }

  pendingPrompts(session_id: string): PendingPrompt[] {
    return [...(this.pending.get(session_id) ?? [])];
  }

  delegateOwner(session_id: string, new_owner_user_id: string): DelegateResult {
    const now = this.nowIso();
    const newEpoch = this.deps.sessions.rotateOwner(session_id, new_owner_user_id, now);
    const queue = this.pending.get(session_id) ?? [];
    const cancelled = queue.filter((p) => p.owner_epoch < newEpoch).map((p) => p.prompt_id);
    const remaining = queue.filter((p) => p.owner_epoch >= newEpoch);
    this.pending.set(session_id, remaining);
    this.deps.audit.append(session_id, new_owner_user_id, "owner_changed", {
      to: new_owner_user_id,
      epoch: newEpoch,
      cancelled_prompt_ids: cancelled,
    }, now);
    return { new_epoch: newEpoch, cancelled_prompt_ids: cancelled };
  }
}
