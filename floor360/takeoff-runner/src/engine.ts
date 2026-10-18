// The takeoff engine is the OpenTakeoff MCP server, run as a CHILD PROCESS over
// stdio — the same binary and the same tool surface an agent uses. A child
// rather than in-process because the flood engine and pdf.js are synchronous,
// CPU-bound and memory-hungry: in-process they would block the job API's event
// loop (no status, no cancel during a long detect_rooms) and a crash or OOM
// would take the API down with it. As a child, cancel and the 60-minute budget
// are a kill, memory is returned when the job ends, and every job starts from
// a fresh session.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface Engine {
  /** Call a tool and return its structured reply. Tool refusals throw EngineToolError. */
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** Call an image tool (view_sheet) and return the PNG as base64. */
  image(tool: string, args: Record<string, unknown>): Promise<string>;
  /** The engine's own version (opentakeoff-mcp). */
  version(): string;
  close(): Promise<void>;
}

/** A tool answered isError: a refusal or a withheld answer, worded by the engine. */
export class EngineToolError extends Error {
  constructor(readonly tool: string, message: string) {
    super(message);
    this.name = "EngineToolError";
  }
}

export interface McpLaunch {
  command: string;
  args: string[];
  cwd?: string;
  signal: AbortSignal;
  /** Per-call ceiling; the job's own budget aborts sooner through signal. */
  callTimeoutMs?: number;
  log?: (msg: string) => void;
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string; data?: string }[];
};

function textOf(r: ToolResult): string {
  return (r.content || []).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
}

function errorText(r: ToolResult): string {
  const t = textOf(r);
  try {
    const j = JSON.parse(t);
    if (j && typeof j.error === "string") return j.error;
  } catch { /* plain text */ }
  return t || "the engine refused this step";
}

export async function startMcpEngine(o: McpLaunch): Promise<Engine> {
  const transport = new StdioClientTransport({
    command: o.command,
    args: o.args,
    cwd: o.cwd,
    // only the SDK's safe defaults: none of the runner's own settings (its
    // token, key file paths) reach the engine process
    env: { ...getDefaultEnvironment(), NODE_ENV: "production", OPENTAKEOFF_ONE_CLICK: "1" },
    stderr: "pipe",
    maxBufferSize: 64 * 1024 * 1024,
  });
  // pdf.js chatter goes to stderr; keep only a short tail for a failure reason
  let stderrTail = "";
  transport.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-2000); });
  const client = new Client({ name: "floor360-takeoff-runner", version: "0.1.0" }, { capabilities: {} });
  const onAbort = () => { transport.close().catch(() => {}); };
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport, { signal: o.signal, timeout: 120_000 });
  } catch (e) {
    o.signal.removeEventListener("abort", onAbort);
    await transport.close().catch(() => {});
    if (o.signal.aborted) throw o.signal.reason;
    throw new Error(`The takeoff engine did not start (${(e as Error).message}). ${stderrTail.split("\n").filter(Boolean).slice(-1)[0] || ""}`.trim());
  }
  const timeout = o.callTimeoutMs ?? 30 * 60_000;
  const raw = async (tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (o.signal.aborted) throw o.signal.reason;
    try {
      return (await client.callTool({ name: tool, arguments: args }, undefined, { signal: o.signal, timeout })) as ToolResult;
    } catch (e) {
      if (o.signal.aborted) throw o.signal.reason;
      throw e;
    }
  };
  return {
    async call(tool, args = {}) {
      const r = await raw(tool, args);
      if (r.isError) throw new EngineToolError(tool, errorText(r));
      if (r.structuredContent !== undefined) return r.structuredContent as never;
      return JSON.parse(textOf(r) || "null");
    },
    async image(tool, args) {
      const r = await raw(tool, args);
      if (r.isError) throw new EngineToolError(tool, errorText(r));
      const img = (r.content || []).find((c) => c.type === "image" && typeof c.data === "string");
      if (!img?.data) throw new EngineToolError(tool, "no image in the reply");
      return img.data;
    },
    version: () => client.getServerVersion()?.version ?? "unknown",
    async close() {
      o.signal.removeEventListener("abort", onAbort);
      await client.close().catch(() => {});
    },
  };
}
