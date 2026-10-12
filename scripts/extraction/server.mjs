import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QueueError, acquireQueueLock, createQueueStore } from "./queue-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "../..");
const ACTIONS = new Set(["start", "pause", "resume", "retry"]);
const BUSY = new Set(["starting", "running", "pausing"]);
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

async function defaultWorkerFactory(options) {
  const { createExtractionWorker } = await import("./worker.mjs");
  return createExtractionWorker(options);
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new QueueError("Use Content-Type: application/json.", 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new QueueError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new QueueError("Provide valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QueueError("Provide a JSON object.");
  return value;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function startQueueServer({ port = Number(process.env.EXTRACTION_QUEUE_PORT ?? 4318),
  root = path.join(REPOSITORY, "captures", "queues"), profileDirectory = path.join(root, "_chrome-profile"),
  uiDirectory = path.join(HERE, "ui"), catalogue, workerFactory = defaultWorkerFactory, now } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new QueueError("Port must be an integer between 0 and 65535.");
  const captureRoot = path.resolve(root);
  const releaseLock = await acquireQueueLock(captureRoot);
  let store;
  try {
    catalogue ??= JSON.parse(await fs.readFile(path.join(HERE, "catalogue.json"), "utf8")).localities;
    store = await createQueueStore({ root: captureRoot, catalogue, now });
  } catch (error) { await releaseLock(); throw error; }
  let activeJobId = null;
  let worker = null;
  let workerSnapshot = { state: "idle", visibleChrome: true, error: null };
  let runPromise = null;
  let controls = Promise.resolve();
  let stateUpdates = Promise.resolve();
  let closing = false;
  const serialControl = (operation) => {
    const result = controls.then(operation);
    controls = result.catch(() => {});
    return result;
  };
  const serialState = (operation) => {
    const result = stateUpdates.then(operation);
    stateUpdates = result.catch(() => {});
    return result;
  };
  const updateJob = (id, fields) => serialState(() => store.updateJob(id, fields));
  const refreshPilot = () => serialState(() => store.refreshPilot());
  const snapshot = () => ({ ...store.snapshot(), activeJobId, catalogue: structuredClone(catalogue), worker: structuredClone(workerSnapshot) });

  const applyWorkerSnapshot = (id, update, terminal = false) => serialState(async () => {
    if (activeJobId !== id) return;
    const job = store.getJob(id);
    const state = update?.state;
    // Observer callbacks may be queued while Pause is being committed. A late running
    // callback may refresh progress, but cannot reverse a requested or completed pause.
    if (!terminal && state === "running" && ["pausing", "paused", "source-challenge", "complete", "finished-with-exceptions", "failed"].includes(job.status)) {
      await store.syncManifest(id, { status: job.status });
      return;
    }
    workerSnapshot = { ...update, visibleChrome: true };
    let status = ["running", "pausing", "paused", "source-challenge", "complete", "finished-with-exceptions"].includes(state) ? state : undefined;
    if (state === "error") status = "failed";
    await store.syncManifest(id, { status, error: update?.error ?? null });
    if (state === "complete") await store.refreshPilot();
  });

  async function ensureWorker(id) {
    if (activeJobId === id && worker && worker.status().state !== "error") return worker;
    if (activeJobId && BUSY.has(store.getJob(activeJobId).status)) throw new QueueError("Pause the active capture before starting another job.", 409);
    if (worker) { await worker.close(); worker = null; }
    const job = store.getJob(id);
    activeJobId = id;
    workerSnapshot = { state: "starting", visibleChrome: true, error: null };
    await updateJob(id, { status: "starting", error: null });
    try {
      worker = await workerFactory({ planPath: path.join(job.outputDirectory, "plan.json"), outputDirectory: job.outputDirectory,
        profileDirectory: path.resolve(profileDirectory), delayMs: job.delayMs, maxPages: job.maxPages,
        onUpdate: (update) => applyWorkerSnapshot(id, update), onState: (update) => applyWorkerSnapshot(id, update) });
      return worker;
    } catch (error) {
      workerSnapshot = { state: "error", visibleChrome: true, error: String(error.message ?? error) };
      await updateJob(id, { status: "failed", error: workerSnapshot.error });
      activeJobId = null;
      throw error;
    }
  }

  function launchRun(id, method) {
    runPromise = (async () => {
      try {
        const final = await worker[method]();
        await applyWorkerSnapshot(id, final ?? worker.status(), true);
      } catch (error) {
        workerSnapshot = { state: "error", visibleChrome: true, error: String(error.message ?? error) };
        await serialState(() => store.syncManifest(id, { status: "failed", error: workerSnapshot.error }));
      }
    })();
    // The capture runs independently from its HTTP request; errors are persisted above.
    runPromise.catch((error) => { workerSnapshot = { state: "error", visibleChrome: true, error: String(error.message ?? error) }; });
  }

  const controller = {
    state: snapshot,
    createJob: (input) => serialControl(async () => {
      if (closing) throw new QueueError("The queue server is shutting down.", 503);
      return store.createJob(input);
    }),
    action: (id, action, body = {}) => serialControl(async () => {
      if (closing) throw new QueueError("The queue server is shutting down.", 503);
      if (!ACTIONS.has(action)) throw new QueueError("Unknown queue action.", 404);
      const job = store.getJob(id);
      if (action === "pause") {
        if (activeJobId !== id || !worker || !BUSY.has(job.status)) throw new QueueError("This capture is not running.", 409);
        await updateJob(id, { status: "pausing" });
        await applyWorkerSnapshot(id, await worker.pause(), true);
        await runPromise;
        return store.getJob(id);
      }
      if (BUSY.has(job.status)) throw new QueueError("This capture is already running.", 409);
      if ((job.kind === "perth-wide" || job.localityIds.length > 3) && !(await refreshPilot()).passed) throw new QueueError("Complete a small live pilot before starting a capture larger than three localities.", 409);
      if (action === "start" && job.status !== "queued") throw new QueueError("Use Resume or Retry for an existing capture.", 409);
      if (action === "resume" && !["paused", "interrupted"].includes(job.status)) throw new QueueError("Only a paused or interrupted capture can resume. Retry source challenges explicitly.", 409);
      if (action === "retry" && !["paused", "source-challenge", "finished-with-exceptions", "failed", "interrupted"].includes(job.status)) throw new QueueError("This capture has no retryable exception.", 409);
      let retryNames;
      if (action === "retry") {
        retryNames = body.sliceNames ?? job.slices.filter((slice) => ["failed", "partial"].includes(slice.status)).map((slice) => slice.name);
        if ((!retryNames.length && job.slices.some((slice) => slice.status === "capped")) || (Array.isArray(retryNames) && retryNames.some((name) => job.slices.some((slice) => slice.name === name && slice.status === "capped")))) throw new QueueError("Capped slices reached this capture's immutable page limit. Create a new dated capture with a higher page limit.", 409);
        const interruptedStartup = job.status === "failed" && body.sliceNames === undefined && !retryNames.length && job.slices.some((slice) => ["pending", "running"].includes(slice.status));
        if (!Array.isArray(retryNames) || (!retryNames.length && !interruptedStartup) || retryNames.some((name) => typeof name !== "string" || !job.slices.some((slice) => slice.name === name && ["failed", "partial"].includes(slice.status)))) throw new QueueError("Select failed or partial slices to retry.");
        retryNames = [...new Set(retryNames)];
        if (worker && activeJobId === id && worker.status().active) { await worker.close(); worker = null; }
      }
      await ensureWorker(id);
      if (action === "retry" && retryNames.length) await worker.retry(retryNames);
      await updateJob(id, { status: "running", error: null });
      workerSnapshot = { ...worker.status(), state: "running", visibleChrome: true, error: null };
      launchRun(id, action === "start" ? "run" : "resume");
      return store.getJob(id);
    }),
  };

  const server = http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      const host = request.headers.host;
      if (!hosts.has(host)) throw new QueueError("Access the queue through its local loopback address.", 403);
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${host}`) || request.headers["sec-fetch-site"] === "cross-site") throw new QueueError("Cross-origin access is not allowed.", 403);
      if (request.method === "POST" && origin !== `http://${host}`) throw new QueueError("Queue actions require the local console Origin header.", 403);
      const url = new URL(request.url, `http://${host}`);
      if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, snapshot());
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        const job = await controller.createJob(await readJson(request));
        return sendJson(response, 201, { job });
      }
      const action = /^\/api\/jobs\/([a-f0-9-]{36})\/(start|pause|resume|retry)$/.exec(url.pathname);
      if (request.method === "POST" && action) {
        const job = await controller.action(action[1], action[2], await readJson(request));
        return sendJson(response, ["start", "resume", "retry"].includes(action[2]) ? 202 : 200, { job });
      }
      const asset = ASSETS.get(url.pathname);
      if (request.method === "GET" && asset) {
        const content = await fs.readFile(path.join(uiDirectory, asset[0]));
        response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" });
        return response.end(content);
      }
      throw new QueueError("Route does not exist.", 404);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.statusCode ?? 500, { error: String(error.message ?? error) });
      else response.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  } catch (error) { await releaseLock(); throw error; }
  const url = `http://127.0.0.1:${server.address().port}`;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    closing = true;
    // Stop accepting work immediately; drain the active page before releasing its process lock.
    const serverClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    try {
      await controls;
      if (worker) {
        if (activeJobId && BUSY.has(store.getJob(activeJobId).status)) {
          await updateJob(activeJobId, { status: "pausing" });
          await applyWorkerSnapshot(activeJobId, await worker.pause(), true);
        }
        await runPromise;
        await worker.close();
      }
      await stateUpdates;
      workerSnapshot = { state: "closed", visibleChrome: true, error: null };
      await store.flush();
      await serverClosed;
    } finally {
      await releaseLock();
    }
  })();
  return { server, controller, url, close, statePath: store.statePath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let port = Number(process.env.EXTRACTION_QUEUE_PORT ?? 4318);
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--port" || index + 1 >= args.length) throw new Error("Usage: node scripts/extraction/server.mjs [--port 4318]");
    port = Number(args[++index]);
  }
  const queue = await startQueueServer({ port });
  process.stdout.write(`Local extraction queue: ${queue.url}\nVisible Chrome uses a dedicated profile. Ctrl+C pauses safely and closes the worker.\n`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await queue.close(); process.exitCode = 0; } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
