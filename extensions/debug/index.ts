import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

type PersistedState = {
  pid: number;
  host: string;
  port: number;
  debugUrl: string;
  loopbackUrl: string;
  startedAt: string;
  logPath: string;
};

const logPath = join(getAgentDir(), "debug", "debug.log");
const statePath = join(getAgentDir(), "debug", "debug-state.json");
const serverScriptPath = join(getAgentDir(), "extensions", "debug", "server.js");

const START_PARAMS = Type.Object({
  port: Type.Optional(Type.Number({ description: "Preferred port. Defaults to 9876." })),
  host: Type.Optional(Type.String({ description: "Host to bind. Defaults to 0.0.0.0." })),
  publicHost: Type.Optional(
    Type.String({ description: "Optional LAN/public host to use in returned probe URL." }),
  ),
});

const READ_PARAMS = Type.Object({
  tail: Type.Optional(Type.Number({ description: "Show last N lines only." })),
});

async function ensureLogDir() {
  await mkdir(dirname(logPath), { recursive: true });
}

async function readState(): Promise<PersistedState | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

async function clearState() {
  await rm(statePath, { force: true });
}

function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function buildUrls(state: PersistedState, publicHost?: string | null) {
  const lanHost = publicHost || getLanIp();
  const lanUrl = lanHost ? `http://${lanHost}:${state.port}/debug` : null;
  return {
    loopbackUrl: state.loopbackUrl,
    lanUrl,
    recommendedUrl: lanUrl ?? state.loopbackUrl,
  };
}

type DebugStatus = {
  active: boolean;
  logPath: string;
  port: number | null;
  pid?: number;
  startedAt?: string;
  loopbackUrl?: string;
  lanUrl?: string | null;
  recommendedUrl?: string;
};

async function isHealthy(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number) {
  for (let i = 0; i < 40; i += 1) {
    if (await isHealthy(port)) return true;
    await sleep(100);
  }
  return false;
}

async function startServer(port: number, host: string) {
  const child = spawn(process.execPath, [serverScriptPath, String(port), host, logPath, statePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ok = await waitForServer(port);
  if (!ok) {
    throw new Error(`Debug server failed to start on port ${port}`);
  }
}

async function terminateServer(state: PersistedState) {
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}

  for (let i = 0; i < 20; i += 1) {
    const healthy = await isHealthy(state.port);
    const alive = await isPidAlive(state.pid);
    if (!healthy && !alive) break;
    await sleep(100);
  }
}

async function stopServer() {
  const state = await readState();
  if (!state) return false;

  await terminateServer(state);
  await clearState();
  return true;
}

async function readLogLines(): Promise<{ lines: string[]; error?: string }> {
  try {
    const text = await readFile(logPath, "utf8");
    return { lines: text.split("\n").filter(Boolean) };
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : undefined;
    if (code === "ENOENT") {
      return { lines: [] };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { lines: [], error: `Failed to read log: ${msg}` };
  }
}

function formatStatusText(status: DebugStatus) {
  if (!status.active) return `Debug mode inactive\nLog: ${logPath}`;
  return [
    "Debug mode active",
    `Recommended URL: ${status.recommendedUrl}`,
    `Loopback URL: ${status.loopbackUrl}`,
    ...(status.lanUrl ? [`LAN URL: ${status.lanUrl}`] : []),
    `Port: ${status.port}`,
    `PID: ${status.pid}`,
    `Log: ${logPath}`,
  ].join("\n");
}

async function getStatus(publicHost?: string | null): Promise<DebugStatus> {
  const state = await readState();
  if (!state) {
    return { active: false, logPath, port: null };
  }

  const active = await isHealthy(state.port);
  if (!active) {
    await clearState();
    return { active: false, logPath, port: null };
  }

  const urls = buildUrls(state, publicHost ?? null);
  return {
    active: true,
    ...urls,
    logPath,
    port: state.port,
    pid: state.pid,
    startedAt: state.startedAt,
  };
}

export default function debugExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "debug_start",
    label: "debug_start",
    description: "Start local debug server for runtime probes.",
    promptSnippet: "Start a local HTTP debug server and return the URL for fetch probes.",
    promptGuidelines: [
      "Use this before inserting runtime fetch probes.",
      "Use the returned URL exactly in fetch POST calls.",
    ],
    parameters: START_PARAMS,
    async execute(_toolCallId, params) {
      await ensureLogDir();

      const existingState = await readState();
      if (existingState && (await isHealthy(existingState.port))) {
        const status = await getStatus(params.publicHost ?? null);
        return {
          content: [{ type: "text", text: formatStatusText(status) }],
          details: status,
        };
      }

      if (existingState) {
        await terminateServer(existingState);
        await clearState();
      }

      const port = params.port ?? 9876;
      const host = params.host ?? "0.0.0.0";
      await startServer(port, host);

      const status = await getStatus(params.publicHost ?? null);
      if (!status.active) throw new Error("Debug server started but status check failed");

      return {
        content: [{ type: "text", text: formatStatusText(status) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "debug_status",
    label: "debug_status",
    description: "Check debug server status.",
    promptSnippet: "Check whether the debug server is running and get its URL.",
    parameters: Type.Object({}),
    async execute() {
      const status = await getStatus();
      return {
        content: [{ type: "text", text: formatStatusText(status) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "debug_read",
    label: "debug_read",
    description: "Read captured debug logs.",
    promptSnippet: "Read captured runtime debug logs.",
    parameters: READ_PARAMS,
    async execute(_toolCallId, params) {
      const { lines, error } = await readLogLines();
      const out = params.tail && params.tail > 0 ? lines.slice(-params.tail) : lines;

      const status = await getStatus();
      const raw = out.length > 0 ? out.join("\n") : "Debug log empty";
      const truncation = truncateTail(raw);
      const logText = truncation.truncated
        ? `${truncation.content}\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines. Use tail param to narrow.]`
        : truncation.content;

      const errorText = error ? `\n⚠️ ${error}` : "";

      return {
        content: [{ type: "text", text: `${logText}${errorText}\n\n${formatStatusText(status)}` }],
        details: { count: out.length, total: lines.length, truncated: truncation.truncated, error: error ?? null, ...status },
      };
    },
  });

  pi.registerTool({
    name: "debug_clear",
    label: "debug_clear",
    description: "Clear captured debug logs.",
    promptSnippet: "Clear the debug log before a fresh repro.",
    parameters: Type.Object({}),
    async execute() {
      await ensureLogDir();
      await writeFile(logPath, "", "utf8");

      const status = await getStatus();

      return {
        content: [{ type: "text", text: `Cleared\n${formatStatusText(status)}` }],
        details: { cleared: true, ...status },
      };
    },
  });

  pi.registerTool({
    name: "debug_stop",
    label: "debug_stop",
    description: "Stop debug server.",
    promptSnippet: "Stop the local debug server after debugging.",
    parameters: Type.Object({}),
    async execute() {
      await stopServer();
      const status = await getStatus();
      return {
        content: [{ type: "text", text: `Stopped\n${formatStatusText(status)}` }],
        details: status,
      };
    },
  });

}
