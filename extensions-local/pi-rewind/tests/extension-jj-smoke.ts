import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import extension from "../src/index.ts";
import { getRepoRoot, loadAllCheckpoints } from "../src/core.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout.trim();
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "pi-rewind-extension-jj-"));
  const root = resolve(base, "repo");
  run("jj", ["git", "init", "--no-colocate", root]);
  writeFileSync(resolve(root, "a.txt"), "one\n");

  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerShortcut() {},
  };
  extension(pi as any);

  const sessionId = "22222222-2222-4222-8222-222222222222";
  const ctx = {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  };

  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ reason: "startup" }, ctx);
  }

  const repoRoot = await getRepoRoot(root);
  let checkpoints = await loadAllCheckpoints(repoRoot, sessionId);
  assert(checkpoints.length === 1, `expected resume checkpoint, got ${checkpoints.length}`);

  for (const handler of handlers.get("before_agent_start") ?? []) {
    await handler({ prompt: "write b" }, ctx);
  }
  for (const handler of handlers.get("turn_start") ?? []) {
    await handler({ turnIndex: 1 }, ctx);
  }
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "tool-1", toolName: "write", input: { path: "b.txt" } }, ctx);
  }

  writeFileSync(resolve(root, "b.txt"), "created by extension smoke\n");

  for (const handler of handlers.get("tool_execution_end") ?? []) {
    await handler({ toolCallId: "tool-1", toolName: "write" }, ctx);
  }
  for (const handler of handlers.get("turn_end") ?? []) {
    await handler({ turnIndex: 1 }, ctx);
  }

  checkpoints = await loadAllCheckpoints(repoRoot, sessionId);
  assert(checkpoints.length === 2, `expected turn checkpoint, got ${checkpoints.length}`);
  assert(
    checkpoints.some((cp) => cp.description?.includes("write → b.txt")),
    "turn checkpoint should include mutating tool label",
  );

  console.log("extension jj smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
