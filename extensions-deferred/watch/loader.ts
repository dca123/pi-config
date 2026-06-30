/**
 * Loads, validates, and caches agent-generated check functions.
 * Mirrors sweep/loader.ts: dynamic import (jiti handles .ts) + Zod validation
 * on the return value, with a temp-copy strategy for cache busting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  WatchStatusSchema,
  type CheckFn,
  type WatchStatus,
  type WatchMeta,
} from "./schema.ts";

export interface WatchManifest {
  id: string;
  dir: string;
  checkPath: string;
  metaPath: string;
  historyPath: string;
  name: string;
}

const WATCH_DIR_NAME = "watch";

export function watchBaseDir(cwd: string): string {
  return path.join(cwd, ".pi", WATCH_DIR_NAME);
}

export function generateId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function manifestFor(dir: string, id: string, name: string): WatchManifest {
  return {
    id,
    dir,
    checkPath: path.join(dir, "check.ts"),
    metaPath: path.join(dir, "meta.json"),
    historyPath: path.join(dir, "check.history.json"),
    name,
  };
}

export function discoverWatches(cwd: string): WatchManifest[] {
  const base = watchBaseDir(cwd);
  if (!fs.existsSync(base)) return [];

  const out: WatchManifest[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (!fs.existsSync(path.join(dir, "check.ts"))) continue;
    out.push(manifestFor(dir, entry.name, entry.name));
  }
  return out;
}

export function findWatch(cwd: string, idOrPrefix: string): WatchManifest | null {
  const all = discoverWatches(cwd);
  return (
    all.find((w) => w.id === idOrPrefix) ??
    all.find((w) => w.id.startsWith(idOrPrefix)) ??
    null
  );
}

export function readMeta(manifest: WatchManifest): WatchMeta | null {
  try {
    return JSON.parse(fs.readFileSync(manifest.metaPath, "utf-8")) as WatchMeta;
  } catch {
    return null;
  }
}

export function writeMeta(manifest: WatchManifest, meta: WatchMeta): void {
  fs.writeFileSync(manifest.metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Dynamically import a check.ts and validate its output.
 * Temp-copy cache busting so edits (watch_improve) take effect without process
 * restart, identical to sweep's loadAndRunDerive.
 */
export async function loadAndRunCheck(checkPath: string): Promise<WatchStatus> {
  const tmpPath = checkPath.replace(/\.ts$/, `.${Date.now()}.ts`);
  fs.copyFileSync(checkPath, tmpPath);

  let mod: Record<string, unknown>;
  try {
    mod = await import(tmpPath);
  } catch (err) {
    throw new Error(
      `Failed to import check.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort
    }
  }

  const fn = mod.default as CheckFn | undefined;
  if (typeof fn !== "function") {
    throw new Error(`check.ts must export a default function. Got: ${typeof fn}`);
  }

  let raw: unknown;
  try {
    raw = await fn();
  } catch (err) {
    throw new Error(
      `check() threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = WatchStatusSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`check() returned invalid WatchStatus:\n${issues}`);
  }

  return result.data;
}
