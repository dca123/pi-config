import type { ExtensionAPI } from "/Users/devindasenanayake/.nvm/versions/node/v22.21.1/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js";
import { getAgentDir } from "/Users/devindasenanayake/.nvm/versions/node/v22.21.1/lib/node_modules/@mariozechner/pi-coding-agent/dist/index.js";
import { Type } from "/Users/devindasenanayake/.nvm/versions/node/v22.21.1/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@sinclair/typebox/build/cjs/index.js";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function stopServer() {
  const state = await readState();
  if (!state) return false;

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}

  for (let i = 0; i < 20; i += 1) {
    const healthy = await isHealthy(state.port);
    if (!healthy) break;
    await sleep(100);
  }

  await clearState();
  return true;
}

async function readLogLines() {
  try {
    const text = await readFile(logPath, "utf8");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function formatStatusText(active: boolean, urls?: ReturnType<typeof buildUrls>, state?: PersistedState | null) {
  if (!active || !state || !urls) return `Debug mode inactive\nLog: ${logPath}`;
  return [
    "Debug mode active",
    `Recommended URL: ${urls.recommendedUrl}`,
    `Loopback URL: ${urls.loopbackUrl}`,
    ...(urls.lanUrl ? [`LAN URL: ${urls.lanUrl}`] : []),
    `Log: ${logPath}`,
  ].join("\n");
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
        const urls = buildUrls(existingState, params.publicHost ?? null);
        return {
          content: [{ type: "text", text: formatStatusText(true, urls, existingState) }],
          details: { active: true, ...urls, logPath, port: existingState.port, pid: existingState.pid },
        };
      }

      if (existingState && !(await isPidAlive(existingState.pid))) {
        await clearState();
      }

      const port = params.port ?? 9876;
      const host = params.host ?? "0.0.0.0";
      await startServer(port, host);

      const nextState = await readState();
      if (!nextState) throw new Error("Debug server started but state file missing");

      const urls = buildUrls(nextState, params.publicHost ?? null);
      return {
        content: [{ type: "text", text: formatStatusText(true, urls, nextState) }],
        details: { active: true, ...urls, logPath, port: nextState.port, pid: nextState.pid },
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
      const state = await readState();
      if (!state) {
        return {
          content: [{ type: "text", text: formatStatusText(false) }],
          details: { active: false, url: null, logPath, port: null },
        };
      }

      const active = await isHealthy(state.port);
      if (!active) {
        await clearState();
        return {
          content: [{ type: "text", text: formatStatusText(false) }],
          details: { active: false, url: null, logPath, port: null },
        };
      }

      const urls = buildUrls(state, null);
      return {
        content: [{ type: "text", text: formatStatusText(true, urls, state) }],
        details: { active: true, ...urls, logPath, port: state.port, pid: state.pid },
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
      const lines = await readLogLines();
      const out = params.tail && params.tail > 0 ? lines.slice(-params.tail) : lines;
      return {
        content: [{ type: "text", text: out.length > 0 ? out.join("\n") : "Debug log empty" }],
        details: { count: out.length, total: lines.length, logPath },
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
      return {
        content: [{ type: "text", text: `Cleared\nLog: ${logPath}` }],
        details: { cleared: true, logPath },
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
      return {
        content: [{ type: "text", text: `Stopped\nLog: ${logPath}` }],
        details: { active: false, logPath },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    await stopServer().catch(() => {});
  });
}
