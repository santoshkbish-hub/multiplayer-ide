import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Capability, PermissionPolicy, Role } from "@collab/shared";

export interface CreateSessionInput {
  owner_user_id: string;
  policy?: PermissionPolicy;
}

export interface CreateSessionOutput {
  session_id: string;
  branch_name: string;
  worktree_path: string;
}

export interface IssueInviteInput {
  user_id: string;
  role: Role;
  chat_id?: string;
}

export interface IssueInviteOutput {
  invite_token: string;
  capability: Capability;
}

export interface DelegateInput {
  new_owner_user_id: string;
}

export interface DelegateOutput {
  new_epoch: number;
  cancelled_prompt_ids: string[];
  capability: Capability;
}

export interface EndSessionInput {
  reason?: string;
}

export interface SessionSummary {
  session_id: string;
  branch_name: string;
  owner_user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_head_sha?: string;
}

export interface FileEntry {
  path: string;
  size: number;
  mode: "rw" | "ro";
}

export interface ListFilesOutput {
  files: FileEntry[];
}

export interface ReadFileOutput {
  path: string;
  content: string;
  truncated: boolean;
  mode: "rw" | "ro";
}

export interface AdminHandlers {
  createSession: (input: CreateSessionInput) => Promise<CreateSessionOutput>;
  listSessions: () => Promise<{ sessions: SessionSummary[] }>;
  issueInvite: (sessionId: string, input: IssueInviteInput) => Promise<IssueInviteOutput>;
  publish: (sessionId: string) => Promise<unknown>;
  delegate: (sessionId: string, input: DelegateInput) => Promise<DelegateOutput>;
  endSession: (sessionId: string, input: EndSessionInput) => Promise<{ ok: true }>;
  listFiles: (sessionId: string) => Promise<ListFilesOutput>;
  readFile: (sessionId: string, path: string) => Promise<ReadFileOutput>;
}

export interface AdminOptions {
  port: number;
  token: string;
  handlers: AdminHandlers;
}

export class AdminServer {
  private http: Server | null = null;
  port = 0;

  constructor(private opts: AdminOptions) {}

  async start(): Promise<number> {
    this.http = createServer((req, res) => {
      void this.dispatch(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String((e as Error).message ?? e));
      });
    });
    this.port = await new Promise<number>((resolve) => {
      this.http!.listen(this.opts.port, () => {
        const addr = this.http!.address();
        resolve(typeof addr === "object" && addr ? addr.port : this.opts.port);
      });
    });
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    await new Promise<void>((r) => this.http!.close(() => r()));
    this.http = null;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.opts.token}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const body = await readBody(req);

    if (req.method === "POST" && url.pathname === "/sessions") {
      const input = parseJson<CreateSessionInput>(body);
      const out = await this.opts.handlers.createSession(input);
      return json(res, 200, out);
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      const out = await this.opts.handlers.listSessions();
      return json(res, 200, out);
    }

    const invMatch = url.pathname.match(/^\/sessions\/([^/]+)\/invites$/);
    if (req.method === "POST" && invMatch) {
      const sid = invMatch[1]!;
      const input = parseJson<IssueInviteInput>(body);
      const out = await this.opts.handlers.issueInvite(sid, input);
      return json(res, 200, out);
    }

    const pubMatch = url.pathname.match(/^\/sessions\/([^/]+)\/publish$/);
    if (req.method === "POST" && pubMatch) {
      const sid = pubMatch[1]!;
      const out = await this.opts.handlers.publish(sid);
      return json(res, 200, out);
    }

    const delMatch = url.pathname.match(/^\/sessions\/([^/]+)\/delegate$/);
    if (req.method === "POST" && delMatch) {
      const sid = delMatch[1]!;
      const input = parseJson<DelegateInput>(body);
      const out = await this.opts.handlers.delegate(sid, input);
      return json(res, 200, out);
    }

    const endMatch = url.pathname.match(/^\/sessions\/([^/]+)\/end$/);
    if (req.method === "POST" && endMatch) {
      const sid = endMatch[1]!;
      const input = parseJson<EndSessionInput>(body);
      const out = await this.opts.handlers.endSession(sid, input);
      return json(res, 200, out);
    }

    const filesMatch = url.pathname.match(/^\/sessions\/([^/]+)\/files$/);
    if (req.method === "GET" && filesMatch) {
      const sid = filesMatch[1]!;
      const out = await this.opts.handlers.listFiles(sid);
      return json(res, 200, out);
    }

    const fileMatch = url.pathname.match(/^\/sessions\/([^/]+)\/file$/);
    if (req.method === "GET" && fileMatch) {
      const sid = fileMatch[1]!;
      const p = url.searchParams.get("path") ?? "";
      const out = await this.opts.handlers.readFile(sid, p);
      return json(res, 200, out);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseJson<T>(body: string): T {
  if (!body) return {} as T;
  return JSON.parse(body) as T;
}
