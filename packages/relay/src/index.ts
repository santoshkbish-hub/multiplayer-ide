import { createServer, type Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { makeAuthMiddleware } from "./auth.js";
import { attachHandlers, type RouterState } from "./router.js";
import type { InviteClaims } from "./types.js";

export interface RelayOptions {
  port?: number;
  hostToken: string;
}

export interface RelayHandle {
  port: number;
  http: HttpServer;
  io: IOServer;
  inviteTokens: Map<string, InviteClaims>;
  registerInvite: (token: string, claims: InviteClaims) => void;
  revokeInvite: (token: string) => void;
  close: () => Promise<void>;
}

export const RELAY_PORT_DEFAULT = 4000;

export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const inviteTokens = new Map<string, InviteClaims>();
  const http = createServer();
  const io = new IOServer(http, {
    cors: { origin: "*" },
    maxHttpBufferSize: 64 * 1024,
  });

  io.use(makeAuthMiddleware({ hostToken: opts.hostToken, inviteTokens }));

  const state: RouterState = { daemonSocket: null, inviteTokens };
  attachHandlers(io, state);

  const port = await new Promise<number>((resolve) => {
    http.listen(opts.port ?? 0, () => {
      const addr = http.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else resolve(opts.port ?? RELAY_PORT_DEFAULT);
    });
  });

  return {
    port,
    http,
    io,
    inviteTokens,
    registerInvite: (token, claims) => inviteTokens.set(token, claims),
    revokeInvite: (token) => inviteTokens.delete(token),
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => http.close(() => resolve()));
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hostToken = process.env.RELAY_HOST_TOKEN;
  if (!hostToken) {
    console.error("RELAY_HOST_TOKEN env required");
    process.exit(1);
  }
  const port = Number(process.env.RELAY_PORT ?? RELAY_PORT_DEFAULT);
  startRelay({ port, hostToken }).then((h) => {
    console.log(JSON.stringify({ name: "relay", port: h.port }));
  });
}
