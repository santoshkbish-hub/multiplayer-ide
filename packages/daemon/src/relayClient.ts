import { io, type Socket } from "socket.io-client";
import type { WireEvent } from "@collab/shared";

export type ForwardedEvent = WireEvent & { _from?: string };
export type EventHandler = (ev: ForwardedEvent) => void | Promise<void>;

export interface ClientHello {
  socket_id: string;
  session_id: string;
  user_id: string;
  role: "owner" | "reader";
  chat_id?: string;
  since_chat_seq?: number;
  since_event_seq?: number;
}
export type HelloHandler = (h: ClientHello) => void | Promise<void>;

export interface ClientBye {
  socket_id: string;
  session_id: string;
  user_id: string;
}
export type ByeHandler = (b: ClientBye) => void | Promise<void>;

export interface InviteRegistration {
  token: string;
  claims: { session_id: string; user_id: string; role: "owner" | "reader" };
}

export class RelayClient {
  private sock: Socket | null = null;
  private joined = new Set<string>();
  private pendingInvites: InviteRegistration[] = [];
  private onHello: HelloHandler | null = null;
  private onBye: ByeHandler | null = null;

  constructor(
    private url: string,
    private hostToken: string,
    private onEvent: EventHandler,
  ) {}

  setHelloHandler(h: HelloHandler): void {
    this.onHello = h;
  }

  setByeHandler(h: ByeHandler): void {
    this.onBye = h;
  }

  sendReplay(targetSocketId: string, bundle: unknown): void {
    this.sock?.emit("client.replay", { target_socket_id: targetSocketId, bundle });
  }

  async connect(): Promise<void> {
    const sock = io(this.url, {
      transports: ["websocket"],
      auth: { kind: "daemon", token: this.hostToken },
      reconnection: true,
    });
    this.sock = sock;
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => {
        sock.off("connect", onOk);
        reject(e);
      };
      const onOk = () => {
        sock.off("connect_error", onErr);
        resolve();
      };
      sock.once("connect", onOk);
      sock.once("connect_error", onErr);
    });

    sock.on("event", (ev: ForwardedEvent) => {
      void Promise.resolve(this.onEvent(ev)).catch(() => undefined);
    });

    sock.on("client.hello", (h: ClientHello) => {
      if (!this.onHello) return;
      void Promise.resolve(this.onHello(h)).catch(() => undefined);
    });

    sock.on("client.bye", (b: ClientBye) => {
      if (!this.onBye) return;
      void Promise.resolve(this.onBye(b)).catch(() => undefined);
    });

    sock.io.on("reconnect", () => {
      for (const sid of this.joined) sock.emit("daemon.join", sid);
      for (const inv of this.pendingInvites) sock.emit("daemon.invite", inv);
    });
  }

  join(sessionId: string): void {
    this.joined.add(sessionId);
    this.sock?.emit("daemon.join", sessionId);
  }

  leave(sessionId: string): void {
    this.joined.delete(sessionId);
    this.sock?.emit("daemon.leave", sessionId);
  }

  registerInvite(reg: InviteRegistration): void {
    this.pendingInvites.push(reg);
    this.sock?.emit("daemon.invite", reg);
  }

  revokeInvite(token: string): void {
    this.pendingInvites = this.pendingInvites.filter((p) => p.token !== token);
    this.sock?.emit("daemon.revoke_invite", token);
  }

  emit(ev: WireEvent): void {
    this.sock?.emit("event", ev);
  }

  async close(): Promise<void> {
    this.sock?.disconnect();
    this.sock = null;
  }
}
