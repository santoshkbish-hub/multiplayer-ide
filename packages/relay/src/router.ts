import type { Server, Socket } from "socket.io";
import type { WireEvent, ErrorEvent } from "@collab/shared";
import type { InviteClaims, SocketData } from "./types.js";

// Events the relay forwards to the daemon when emitted by an owner client.
const OWNER_ONLY: ReadonlySet<WireEvent["type"]> = new Set([
  "agent.prompt",
  "command.request",
]);

// Events the relay rebroadcasts within the room when emitted by a client.
const CLIENT_BROADCAST: ReadonlySet<WireEvent["type"]> = new Set([
  "presence.update",
  "cursor.update",
  "chat.message",
]);

// Events the daemon may emit into a room.
const DAEMON_EMIT: ReadonlySet<WireEvent["type"]> = new Set([
  "command.output",
  "agent.token",
  "owner.changed",
  "publish.status",
  "session.ended",
  "chat.message",
  "error",
  "presence.update",
  "files.changed",
]);

export interface RouterState {
  daemonSocket: Socket | null;
  inviteTokens: Map<string, InviteClaims>;
}

export function attachHandlers(io: Server, state: RouterState): void {
  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    if (data.kind === "daemon") {
      state.daemonSocket = socket;
      socket.on("disconnect", () => {
        if (state.daemonSocket === socket) state.daemonSocket = null;
      });

      // Daemon may subscribe to any session room.
      socket.on("daemon.join", (sessionId: string) => {
        if (typeof sessionId === "string") void socket.join(sessionId);
      });
      socket.on("daemon.leave", (sessionId: string) => {
        if (typeof sessionId === "string") void socket.leave(sessionId);
      });

      // Daemon-mediated invite registration. Clients connect using these tokens.
      socket.on(
        "daemon.invite",
        (payload: { token: string; claims: InviteClaims } | undefined) => {
          if (!payload || typeof payload.token !== "string" || !payload.claims) return;
          state.inviteTokens.set(payload.token, payload.claims);
        },
      );
      socket.on("daemon.revoke_invite", (token: string) => {
        if (typeof token === "string") state.inviteTokens.delete(token);
      });

      socket.on("event", (ev: WireEvent) => {
        if (!ev || typeof ev.session_id !== "string") return;
        if (!DAEMON_EMIT.has(ev.type)) return;
        if (ev.type === "session.ended") {
          io.to(ev.session_id).emit("event", ev);
          // Close the room — disconnect all client sockets in it.
          const room = io.sockets.adapter.rooms.get(ev.session_id);
          if (room) {
            for (const sid of room) {
              const s = io.sockets.sockets.get(sid);
              if (s && (s.data as SocketData).kind === "client") {
                s.disconnect(true);
              }
            }
          }
          return;
        }
        io.to(ev.session_id).emit("event", ev);
      });

      // Daemon-targeted reply to a specific client socket (e.g. replay bundle).
      socket.on(
        "client.replay",
        (payload: { target_socket_id: string; bundle: unknown } | undefined) => {
          if (!payload || typeof payload.target_socket_id !== "string") return;
          const target = io.sockets.sockets.get(payload.target_socket_id);
          if (!target) return;
          target.emit("replay", payload.bundle);
        },
      );
      return;
    }

    // Client socket
    const { session_id, user_id, role, chat_id, since_chat_seq, since_event_seq } = data;
    void socket.join(session_id);

    // Tell the daemon a client just connected, so it can deliver a replay bundle.
    if (state.daemonSocket) {
      state.daemonSocket.emit("client.hello", {
        socket_id: socket.id,
        session_id,
        user_id,
        role,
        chat_id,
        since_chat_seq,
        since_event_seq,
      });
    }
    // Broadcast presence into the room.
    io.to(session_id).emit("event", {
      type: "presence.update",
      session_id,
      user_id,
      online: true,
    });
    socket.on("disconnect", () => {
      io.to(session_id).emit("event", {
        type: "presence.update",
        session_id,
        user_id,
        online: false,
      });
    });

    socket.on("event", (ev: WireEvent) => {
      if (!ev || typeof ev.type !== "string") return;
      if (ev.session_id !== session_id) {
        emitError(socket, session_id, "wrong_room", "session_id mismatch");
        return;
      }

      if (OWNER_ONLY.has(ev.type)) {
        if (role !== "owner") {
          emitError(socket, session_id, "not_owner", `${ev.type} requires owner`);
          return;
        }
        const d = state.daemonSocket;
        if (!d) {
          emitError(socket, session_id, "daemon_offline", "no daemon");
          return;
        }
        d.emit("event", { ...ev, _from: user_id });
        return;
      }

      if (CLIENT_BROADCAST.has(ev.type)) {
        const out = { ...ev, _from: user_id };
        io.to(session_id).emit("event", out);
        return;
      }

      emitError(socket, session_id, "event_not_allowed", `client may not emit ${ev.type}`);
    });
  });
}

function emitError(
  socket: Socket,
  session_id: string,
  code: string,
  message: string,
): void {
  const err: ErrorEvent = { type: "error", session_id, code, message };
  socket.emit("event", err);
}
