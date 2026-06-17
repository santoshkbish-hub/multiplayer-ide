import type { Role } from "./session.js";

export interface CapabilityClaims {
  session_id: string;
  user_id: string;
  role: Role;
  scope: string[];
  owner_epoch: number;
  exp: number;
}

export interface Capability extends CapabilityClaims {
  sig: string;
}

export function canonicalize(claims: CapabilityClaims): string {
  const ordered: CapabilityClaims = {
    session_id: claims.session_id,
    user_id: claims.user_id,
    role: claims.role,
    scope: [...claims.scope].sort(),
    owner_epoch: claims.owner_epoch,
    exp: claims.exp,
  };
  return JSON.stringify(ordered);
}
