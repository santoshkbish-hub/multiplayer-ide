import type { Socket } from "socket.io";
import type { HandshakeAuth } from "@collab/shared";
import type { InviteClaims } from "./types.js";

type NextFn = (err?: Error) => void;

export interface AuthDeps {
  hostToken: string;
  inviteTokens: Map<string, InviteClaims>;
}

export function makeAuthMiddleware(deps: AuthDeps) {
  return function authMiddleware(socket: Socket, next: NextFn): void {
    const auth = socket.handshake.auth as Partial<HandshakeAuth>;
    if (!auth || typeof auth.token !== "string" || !auth.kind) {
      return next(new Error("missing auth"));
    }
    if (auth.kind === "daemon") {
      if (auth.token !== deps.hostToken) {
        return next(new Error("bad daemon token"));
      }
      socket.data = { kind: "daemon" };
      return next();
    }
    if (auth.kind === "client") {
      const claims = deps.inviteTokens.get(auth.token);
      if (!claims) return next(new Error("bad invite token"));
      const since_chat_seq =
        typeof auth.since_chat_seq === "number" ? auth.since_chat_seq : undefined;
      const since_event_seq =
        typeof auth.since_event_seq === "number" ? auth.since_event_seq : undefined;
      const chat_id =
        typeof auth.chat_id === "string" && auth.chat_id.length ? auth.chat_id : undefined;
      socket.data = {
        kind: "client",
        ...claims,
        ...(chat_id !== undefined ? { chat_id } : {}),
        ...(since_chat_seq !== undefined ? { since_chat_seq } : {}),
        ...(since_event_seq !== undefined ? { since_event_seq } : {}),
      };
      return next();
    }
    return next(new Error("unknown auth kind"));
  };
}
