const { createServer } = require("node:http");
const { mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { dirname } = require("node:path");

const [portArg, host, logPath, statePath] = process.argv.slice(2);
const port = Number(portArg);

async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function appendLog(label, data) {
  await ensureDir(logPath);
  const ts = new Date().toISOString();
  const line =
    data !== undefined
      ? `[${ts}] ${label} | ${JSON.stringify(data)}\n`
      : `[${ts}] ${label}\n`;

  let prev = "";
  try {
    prev = await readFile(logPath, "utf8");
  } catch {}

  await writeFile(logPath, prev + line, "utf8");
}

async function writeState(serverPort) {
  await ensureDir(statePath);
  const loopbackUrl = `http://localhost:${serverPort}/debug`;
  await writeFile(
    statePath,
    JSON.stringify(
      {
        pid: process.pid,
        host,
        port: serverPort,
        debugUrl: loopbackUrl,
        loopbackUrl,
        startedAt: new Date().toISOString(),
        logPath,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function cleanup() {
  try {
    await rm(statePath, { force: true });
  } catch {}
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  if (req.method === "GET" && url === "/health") {
    send(res, 200, JSON.stringify({ status: "ok" }), "application/json; charset=utf-8");
    return;
  }

  if (req.method === "POST" && (url === "/debug" || url === "/")) {
    const body = await readJsonBody(req);
    if (!body || !body.label) {
      send(res, 400, JSON.stringify({ error: "Missing label" }), "application/json; charset=utf-8");
      return;
    }
    await appendLog(body.label, body.data);
    send(res, 200, JSON.stringify({ received: true }), "application/json; charset=utf-8");
    return;
  }

  send(res, 404, "Not found");
});

server.listen(port, host, async () => {
  const address = server.address();
  const serverPort = address && typeof address === "object" ? address.port : port;
  await writeState(serverPort);
});

async function shutdown() {
  server.close(async () => {
    await cleanup();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", () => {
  void cleanup();
});
