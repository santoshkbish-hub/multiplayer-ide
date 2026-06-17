import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import type {
  WireEvent,
  ChatMessage,
  AgentPrompt,
  Capability,
} from "@collab/shared";
import { startRelay, type RelayHandle } from "./index.js";

const HOST_TOKEN = "host-secret";

function dummyCap(session_id: string, user_id: string): Capability {
  return {
    session_id,
    user_id,
    role: "owner",
    scope: ["prompt"],
    owner_epoch: 1,
    exp: Date.now() + 60_000,
    sig: "dummy",
  };
}

function connectClient(port: number, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = ioc(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      auth: { kind: "client", token },
      reconnection: false,
    });
    sock.once("connect", () => resolve(sock));
    sock.once("connect_error", (e) => reject(e));
  });
}

function connectDaemon(port: number, hostToken: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = ioc(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      auth: { kind: "daemon", token: hostToken },
      reconnection: false,
    });
    sock.once("connect", () => resolve(sock));
    sock.once("connect_error", (e) => reject(e));
  });
}

function nextEvent(sock: ClientSocket, predicate?: (ev: WireEvent) => boolean, timeoutMs = 500): Promise<WireEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off("event", handler);
      reject(new Error("timeout"));
    }, timeoutMs);
    const handler = (ev: WireEvent) => {
      if (!predicate || predicate(ev)) {
        clearTimeout(t);
        sock.off("event", handler);
        resolve(ev);
      }
    };
    sock.on("event", handler);
  });
}

function waitNoEvent(sock: ClientSocket, ms = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (ev: WireEvent) => {
      // presence is a free side-channel emitted on connect/disconnect; ignore here.
      if (ev.type === "presence.update") return;
      clearTimeout(t);
      sock.off("event", handler);
      reject(new Error(`unexpected event: ${ev.type} for ${ev.session_id}`));
    };
    sock.on("event", handler);
    const t = setTimeout(() => {
      sock.off("event", handler);
      resolve();
    }, ms);
  });
}

describe("relay M1", () => {
  let relay: RelayHandle;

  beforeAll(async () => {
    relay = await startRelay({ port: 0, hostToken: HOST_TOKEN });
    relay.registerInvite("tA-owner", { session_id: "sessA", user_id: "alice", role: "owner" });
    relay.registerInvite("tA-reader", { session_id: "sessA", user_id: "bob", role: "reader" });
    relay.registerInvite("tB-owner", { session_id: "sessB", user_id: "carol", role: "owner" });
  });

  afterAll(async () => {
    await relay.close();
  });

  it("rejects bad auth", async () => {
    await expect(connectClient(relay.port, "nope")).rejects.toThrow();
  });

  it("isolates rooms: sessA traffic doesn't reach sessB clients", async () => {
    const daemon = await connectDaemon(relay.port, HOST_TOKEN);
    daemon.emit("daemon.join", "sessA");
    daemon.emit("daemon.join", "sessB");

    const aOwner = await connectClient(relay.port, "tA-owner");
    const bOwner = await connectClient(relay.port, "tB-owner");

    const msg: ChatMessage = { type: "chat.message", session_id: "sessA", user_id: "alice", text: "hi A" };
    const got = nextEvent(aOwner, (ev) => ev.type === "chat.message");
    const none = waitNoEvent(bOwner);
    aOwner.emit("event", msg);
    const ev = await got;
    expect(ev.type).toBe("chat.message");
    expect(ev.session_id).toBe("sessA");
    await none;

    daemon.disconnect();
    aOwner.disconnect();
    bOwner.disconnect();
  });

  it("forwards agent.prompt from owner to daemon", async () => {
    const daemon = await connectDaemon(relay.port, HOST_TOKEN);
    daemon.emit("daemon.join", "sessA");
    const aOwner = await connectClient(relay.port, "tA-owner");

    const prompt: AgentPrompt = {
      type: "agent.prompt",
      session_id: "sessA",
      prompt_id: "p1",
      capability: dummyCap("sessA", "alice"),
      text: "do the thing",
    };
    const got = nextEvent(daemon, (ev) => ev.type === "agent.prompt");
    aOwner.emit("event", prompt);
    const ev = await got;
    expect(ev.type).toBe("agent.prompt");
    expect((ev as AgentPrompt).text).toBe("do the thing");

    daemon.disconnect();
    aOwner.disconnect();
  });

  it("drops agent.prompt from a reader and sends error back", async () => {
    const daemon = await connectDaemon(relay.port, HOST_TOKEN);
    daemon.emit("daemon.join", "sessA");
    const aReader = await connectClient(relay.port, "tA-reader");

    const prompt: AgentPrompt = {
      type: "agent.prompt",
      session_id: "sessA",
      prompt_id: "p2",
      capability: dummyCap("sessA", "bob"),
      text: "sneaky",
    };

    const daemonNothing = waitNoEvent(daemon, 200);
    const errBack = nextEvent(aReader, (ev) => ev.type === "error");
    aReader.emit("event", prompt);
    const err = await errBack;
    expect(err.type).toBe("error");
    await daemonNothing;

    daemon.disconnect();
    aReader.disconnect();
  });
});
