import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createCheckpoint,
  getRepoRoot,
  isGitRepo,
  loadAllCheckpoints,
  restoreCheckpoint,
} from "../src/core.ts";

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
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-rewind-git-smoke-"));
  const root = realpathSync(tempRoot);
  run("git", ["init", "--quiet"], root);
  run("git", ["config", "user.email", "test@example.com"], root);
  run("git", ["config", "user.name", "Test"], root);
  writeFileSync(resolve(root, "a.txt"), "one\n");
  run("git", ["add", "a.txt"], root);
  run("git", ["commit", "--quiet", "-m", "initial"], root);

  const sessionId = "33333333-3333-4333-8333-333333333333";
  assert(await isGitRepo(root), "Git repo should be rewind-available");
  assert((await getRepoRoot(root)) === root, "Git root should be used as worktree root");

  const cp1 = await createCheckpoint({
    root,
    id: `turn-${sessionId}-1-1000`,
    sessionId,
    trigger: "tool",
    turnIndex: 1,
    description: "first",
  });

  writeFileSync(resolve(root, "a.txt"), "two\n");
  writeFileSync(resolve(root, "b.txt"), "new\n");

  const cp2 = await createCheckpoint({
    root,
    id: `turn-${sessionId}-2-2000`,
    sessionId,
    trigger: "tool",
    turnIndex: 2,
    description: "second",
  });

  const actualRefs = run("git", ["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints"], root);
  assert(actualRefs === "", "checkpoint refs should stay out of the project Git repo");

  const all = await loadAllCheckpoints(root, sessionId);
  assert(all.length === 2, `expected 2 checkpoints, got ${all.length}`);

  await restoreCheckpoint(root, cp1);
  assert(readFileSync(resolve(root, "a.txt"), "utf8") === "one\n", "cp1 should restore a.txt");
  assert(!existsSync(resolve(root, "b.txt")), "cp1 should clean files created after the checkpoint");
  assert(existsSync(resolve(root, ".git")), "restore must not delete Git metadata");

  await restoreCheckpoint(root, cp2);
  assert(readFileSync(resolve(root, "a.txt"), "utf8") === "two\n", "cp2 should restore a.txt");
  assert(readFileSync(resolve(root, "b.txt"), "utf8") === "new\n", "cp2 should restore b.txt");

  console.log(`shadow git smoke ok: ${cp1.branch}, ${cp2.branch}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
