// lazy-all.js — single eager extension that consolidates loading of all the
// real extensions (kept out of settings.json `packages`) plus the local
// Plannotator checkout. They are imported lazily (dynamic import) but their
// factories run inside THIS factory body, which pi awaits during the initial
// extension load phase. That is mandatory: slash commands registered after the
// initial load phase never reach the interactive TUI command set (only
// `/reload` or RPC get_commands pick them up). See CHANGELOG — registerProvider
// and registerTool flush late, registerCommand does not.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const AGENT = join(HOME, ".pi", "agent");
const DEFERRED = join(AGENT, "extensions-deferred");
const LOCAL_REWIND_ENTRY = join(AGENT, "extensions-local/pi-rewind/src/index.ts");

// Resolve an extension entry file from a deferred entry (file or directory).
function resolveEntry(path) {
	if (!existsSync(path)) return null;
	const st = statSync(path);
	if (st.isFile()) return path;
	// directory: package.json#pi.extensions, else index.ts/js
	const pkg = join(path, "package.json");
	if (existsSync(pkg)) {
		try {
			const manifest = JSON.parse(readFileSync(pkg, "utf8"));
			const list = manifest?.pi?.extensions;
			if (Array.isArray(list) && list[0]) {
				const p = join(path, list[0]);
				if (existsSync(p)) return p;
				if (existsSync(join(p, "index.ts"))) return join(p, "index.ts");
			}
		} catch {}
	}
	for (const name of ["index.ts", "index.js", "extension.ts"]) {
		const p = join(path, name);
		if (existsSync(p)) return p;
	}
	return null;
}

// Discover deferred local extensions.
function discoverDeferred() {
	if (!existsSync(DEFERRED)) return [];
	const out = [];
	for (const name of readdirSync(DEFERRED)) {
		if (name.startsWith(".") || name === "lazy-all.js") continue;
		if (name.endsWith(".test.ts") || name.endsWith(".test.js")) continue;
		const entry = resolveEntry(join(DEFERRED, name));
		if (entry) out.push(entry);
	}
	return out;
}

// Package extensions (npm/git) + the local Plannotator checkout.
const PACKAGE_ENTRIES = [
	join(AGENT, "npm/node_modules/@ogulcancelik/pi-session-recall/session-recall.ts"),
	join(AGENT, "git/github.com/davebcn87/pi-autoresearch/extensions/pi-autoresearch/index.ts"),
	existsSync(LOCAL_REWIND_ENTRY) ? LOCAL_REWIND_ENTRY : join(AGENT, "npm/node_modules/pi-rewind/src/index.ts"),
	join(AGENT, "npm/node_modules/pi-mono-multi-edit/index.ts"),
	join(AGENT, "npm/node_modules/pi-nvim/extension.ts"),
].filter(existsSync);

const PLANNOTATOR_ENTRY = [
	join(HOME, "Projects/plannotator/apps/pi-extension/index.ts"),
	join(HOME, "projects/plannotator/apps/pi-extension/index.ts"),
].find(existsSync);

const FAST_ENTRIES = [...discoverDeferred(), ...PACKAGE_ENTRIES];

let started = false;

function isTruthy(v) { return v === "1" || v === "true" || v === "yes"; }
function logTiming(msg) { if (isTruthy(process.env.PI_LAZY_EXTENSION_TIMING)) console.error(msg); }

function importUrlFor(path) {
	const url = pathToFileURL(path);
	try { url.searchParams.set("mtime", String(statSync(path).mtimeMs)); }
	catch { url.searchParams.set("mtime", String(Date.now())); }
	return url.href;
}

async function loadFactory(path) {
	const mod = await import(importUrlFor(path));
	const factory = mod.default;
	if (typeof factory !== "function") throw new Error(`${path} has no default extension factory`);
	return factory;
}

async function loadEntry(pi, path) {
	const start = Date.now();
	const factory = await loadFactory(path);
	await factory(pi);
	logTiming(`[lazy-extension] ${Date.now() - start}ms ${path}`);
}

// Extensions that register slash commands MUST run their factory during pi's
// initial extension load phase, otherwise their commands never reach the
// interactive TUI command set (only `/reload` or RPC get_commands see them;
// see CHANGELOG: registerProvider/registerTool flush late, registerCommand
// does not). So we load every extension factory here in lazy-all's own
// factory body — which pi awaits before emitting session_start — instead of
// deferring them into post-startup timers. Each sub-extension registers its
// own session_start handler, which pi then fires normally.
async function loadAll(pi) {
	for (const path of [...FAST_ENTRIES, ...(PLANNOTATOR_ENTRY ? [PLANNOTATOR_ENTRY] : [])]) {
		try { await loadEntry(pi, path); }
		catch (e) { console.error(`Failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`); }
	}
}

export default async function lazyAll(pi) {
	if (started) return;
	started = true;
	// Register Plannotator's --plan flag eagerly so it's available immediately.
	try {
		pi.registerFlag("plan", { description: "Start in plan mode", type: "boolean", default: false });
	} catch {}
	await loadAll(pi);
}
