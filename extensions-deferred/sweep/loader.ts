/**
 * Loads, validates, and caches agent-generated derivation functions.
 * Uses dynamic import (jiti handles .ts) + Zod validation on the return value.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SweepTaskSchema, type DeriveFn, type SweepTask } from "./schema.ts";

export interface SweepManifest {
  id: string;
  dir: string;
  derivePath: string;
  rulesPath: string;
  historyPath: string;
  name: string;
}

const SWEEP_DIR_NAME = "sweep";

/** Resolve the sweep base directory for a project */
export function sweepBaseDir(cwd: string): string {
  return path.join(cwd, ".pi", SWEEP_DIR_NAME);
}

/** Generate a short alphanumeric ID (like handoff IDs) */
export function generateId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

/** Slugify a human name for directory naming */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Discover all sweep directories under .pi/sweep/ */
export function discoverSweeps(cwd: string): SweepManifest[] {
  const base = sweepBaseDir(cwd);
  if (!fs.existsSync(base)) return [];

  const entries = fs.readdirSync(base, { withFileTypes: true });
  const sweeps: SweepManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const derivePath = path.join(dir, "derive.ts");
    if (!fs.existsSync(derivePath)) continue;

    sweeps.push({
      id: entry.name,
      dir,
      derivePath,
      rulesPath: path.join(dir, "rules.md"),
      historyPath: path.join(dir, "derive.history.json"),
      name: entry.name,
    });
  }

  return sweeps;
}

/** Find a sweep by ID (exact or prefix match) */
export function findSweep(
  cwd: string,
  idOrPrefix: string,
): SweepManifest | null {
  const sweeps = discoverSweeps(cwd);
  return (
    sweeps.find((s) => s.id === idOrPrefix) ??
    sweeps.find((s) => s.id.startsWith(idOrPrefix)) ??
    null
  );
}

/**
 * Dynamically import a derive.ts and validate its output.
 * Returns the validated SweepTask or throws with a descriptive error.
 *
 * Uses a temp-copy strategy for cache busting: copies derive.ts to a
 * timestamped temp file so both jiti and Bun treat it as a fresh module.
 * The temp file is cleaned up after import.
 */
export async function loadAndRunDerive(
  derivePath: string,
): Promise<SweepTask> {
  const tmpPath = derivePath.replace(/\.ts$/, `.${Date.now()}.ts`);
  fs.copyFileSync(derivePath, tmpPath);

  let mod: Record<string, unknown>;
  try {
    mod = await import(tmpPath);
  } catch (err) {
    throw new Error(
      `Failed to import derive.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
  }

  const fn = mod.default as DeriveFn | undefined;
  if (typeof fn !== "function") {
    throw new Error(
      `derive.ts must export a default function. Got: ${typeof fn}`,
    );
  }

  let raw: unknown;
  try {
    raw = await fn();
  } catch (err) {
    throw new Error(
      `derive() threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = SweepTaskSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`derive() returned invalid SweepTask:\n${issues}`);
  }

  return result.data;
}

/** Read rules.md if it exists */
export function readRules(manifest: SweepManifest): string | null {
  if (!fs.existsSync(manifest.rulesPath)) return null;
  return fs.readFileSync(manifest.rulesPath, "utf-8");
}
