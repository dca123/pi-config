import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createCheckpoint,
  getRepoRoot,
  git,
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
  const base = await mkdtemp(join(tmpdir(), "pi-rewind-jj-smoke-"));
  const repoPath = join(base, "repo");
  run("jj", ["git", "init", "--no-colocate", repoPath]);
  const root = realpathSync(repoPath);

  const plainGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  assert(plainGit.status !== 0, "fixture must be a non-colocated JJ repo");

  writeFileSync(resolve(root, "a.txt"), "one\n");

  const sessionId = "11111111-1111-4111-8111-111111111111";
  assert(await isGitRepo(root), "JJ repo should be rewind-available");
  assert((await getRepoRoot(root)) === root, "JJ root should be used as worktree root");

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

  const all = await loadAllCheckpoints(root, sessionId);
  assert(all.length === 2, `expected 2 checkpoints, got ${all.length}`);

  await restoreCheckpoint(root, cp1);
  assert(readFileSync(resolve(root, "a.txt"), "utf8") === "one\n", "cp1 should restore a.txt");
  assert(!existsSync(resolve(root, "b.txt")), "cp1 should clean files created after the checkpoint");
  assert(existsSync(resolve(root, ".jj")), "restore must not delete JJ metadata");

  await restoreCheckpoint(root, cp2);
  assert(readFileSync(resolve(root, "a.txt"), "utf8") === "two\n", "cp2 should restore a.txt");
  assert(readFileSync(resolve(root, "b.txt"), "utf8") === "new\n", "cp2 should restore b.txt");

  const treePaths = await git(`ls-tree -r --name-only ${cp2.worktreeTreeSha}`, root);
  assert(!treePaths.includes(".jj"), "checkpoints must not capture JJ metadata");

  console.log(`shadow jj smoke ok: ${cp1.description}, ${cp2.description}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
