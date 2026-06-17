import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalize,
  type Capability,
  type CapabilityClaims,
} from "@collab/shared";

export type CapVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "bad_sig"
        | "expired"
        | "session_mismatch"
        | "epoch_stale"
        | "role_mismatch"
        | "malformed";
    };

export class CapabilityIssuer {
  constructor(private secret: Buffer, private now: () => number = Date.now) {}

  sign(claims: CapabilityClaims): Capability {
    const sig = this.hmac(canonicalize(claims));
    return { ...claims, sig };
  }

  verifySignature(cap: Capability): boolean {
    if (!cap || typeof cap.sig !== "string") return false;
    const expected = this.hmac(canonicalize(stripSig(cap)));
    const a = Buffer.from(expected);
    const b = Buffer.from(cap.sig);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  verify(
    cap: Capability,
    requirements: { session_id: string; required_epoch: number; required_role?: "owner" | "reader" },
  ): CapVerifyResult {
    if (!cap || typeof cap !== "object") return { ok: false, reason: "malformed" };
    if (!this.verifySignature(cap)) return { ok: false, reason: "bad_sig" };
    if (cap.session_id !== requirements.session_id) return { ok: false, reason: "session_mismatch" };
    if (cap.exp <= this.now()) return { ok: false, reason: "expired" };
    if (cap.owner_epoch !== requirements.required_epoch) return { ok: false, reason: "epoch_stale" };
    if (requirements.required_role && cap.role !== requirements.required_role) {
      return { ok: false, reason: "role_mismatch" };
    }
    return { ok: true };
  }

  private hmac(data: string): string {
    return createHmac("sha256", this.secret).update(data).digest("base64url");
  }
}

function stripSig(cap: Capability): CapabilityClaims {
  return {
    session_id: cap.session_id,
    user_id: cap.user_id,
    role: cap.role,
    scope: cap.scope,
    owner_epoch: cap.owner_epoch,
    exp: cap.exp,
  };
}
