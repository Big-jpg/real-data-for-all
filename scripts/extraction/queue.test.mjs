import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { acquireQueueLock, createQueueStore, perthDate, writeJsonAtomic } from "./queue-store.mjs";
import { startQueueServer } from "./server.mjs";

const directories = [];
const servers = [];
const catalogue = [
  { id: "hocking-6065", suburb: "HOCKING", postcode: "6065" },
  { id: "treeby-6164", suburb: "TREEBY", postcode: "6164" },
  { id: "bushmead-6055", suburb: "BUSHMEAD", postcode: "6055" },
  { id: "yokine-6060", suburb: "YOKINE", postcode: "6060" },
];
const sha = (content) => createHash("sha256").update(content).digest("hex");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "rea-queue-test-"))) throw new Error("Refusing cleanup outside queue test directory.");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rea-queue-test-"));
  directories.push(directory);
  return directory;
}

async function completeManifest(job, { rows = 2, status = "complete", tampered = false } = {}) {
  const plan = JSON.parse(await fs.readFile(path.join(job.outputDirectory, "plan.json"), "utf8"));
  const slices = [];
  for (const slice of plan.slices) {
    const file = `pages/${slice.name}/page-001.json`;
    const saved = { evidence: { httpStatus: 200, transport: "chrome-bootstrap-response" }, capture: { listings: Array.from({ length: rows }, (_, index) => ({ id: index + 1 })) } };
    const content = `${JSON.stringify(saved)}\n`;
    await fs.mkdir(path.dirname(path.join(job.outputDirectory, file)), { recursive: true });
    await fs.writeFile(path.join(job.outputDirectory, file), content);
    slices.push({ ...slice, status, pages: [{ file, pageNumber: 1, rows, sha256: tampered ? "invalid" : sha(content) }], summary: { capturedRows: rows } });
  }
  await writeJsonAtomic(path.join(job.outputDirectory, "manifest.json"), { runId: job.runId, planSha256: sha(JSON.stringify(plan)), status, slices });
}

function fakeWorkerFactory({ stopAfterChallenge = false } = {}) {
  const instances = [];
  const factory = async (options) => {
    const plan = JSON.parse(await fs.readFile(options.planPath, "utf8"));
    const job = { ...plan, outputDirectory: options.outputDirectory };
    let state = "idle";
    let pauseRequested = false;
    let running = null;
    let release;
    let retried = false;
    const blocked = new Promise((resolve) => { release = resolve; });
    const status = () => ({ state, status: state, progress: { committedPages: state === "idle" ? 0 : 1 }, active: null, manifestPath: path.join(options.outputDirectory, "manifest.json"), error: null });
    const worker = {
      options, released: false, closed: false, retryNames: [], status,
      run() {
        if (running) throw new Error("Duplicate fake worker run.");
        running = (async () => {
          state = "running";
          await options.onState(status());
          await blocked;
          await completeManifest(job, { status: stopAfterChallenge && !retried ? "failed" : pauseRequested ? "running" : "complete" });
          state = stopAfterChallenge && !retried ? "source-challenge" : pauseRequested ? "paused" : "complete";
          await options.onUpdate(status());
          await options.onState(status());
          return status();
        })().finally(() => { running = null; });
        return running;
      },
      resume() { pauseRequested = false; return this.run(); },
      async pause() { pauseRequested = true; release(); await running; return status(); },
      async retry(names) { this.retryNames = names; retried = true; state = "idle"; return status(); },
      release() { this.released = true; release(); },
      async close() { this.closed = true; if (running) await this.pause(); state = "closed"; await options.onState(status()); },
    };
    instances.push(worker);
    return worker;
  };
  return { factory, instances };
}

async function waitFor(server, predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = server.controller.state();
    if (predicate(state)) return state;
    await tick();
  }
  throw new Error("Queue did not reach expected state.");
}

describe("local extraction queue persistence", () => {
  it("uses Perth dates, creates immutable unique run plans and validates the catalogue scope", async () => {
    expect(perthDate(new Date("2026-10-11T17:00:00Z"))).toBe("2026-10-12");
    const root = await temporaryDirectory();
    const store = await createQueueStore({ root, catalogue, now: () => new Date("2026-10-11T17:00:00Z") });
    const first = await store.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065", "hocking-6065"] });
    const second = await store.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    expect(first.localityIds).toEqual(["hocking-6065"]);
    expect(first.outputDirectory).not.toBe(second.outputDirectory);
    expect(path.basename(first.outputDirectory)).toBe(`2026-10-12-${first.id}`);
    const plan = JSON.parse(await fs.readFile(path.join(first.outputDirectory, "plan.json"), "utf8"));
    expect(plan.slices[0]).toMatchObject({ state: "WA", propertyType: "house", includeSurrounding: false, maxSoldAge: "6-month" });
    expect(plan.baseline).toContain("2026-07-baseline/manifest.json");
    await expect(store.createJob({ name: "Bad", kind: "pilot", localityIds: catalogue.map((item) => item.id) })).rejects.toThrow("three localities");
    await expect(store.createJob({ name: "Bad", localityIds: ["../arbitrary-path"] })).rejects.toThrow("verified catalogue");
    await expect(store.createJob({ name: "Bad", localityIds: ["hocking-6065"], delayMs: 1 })).rejects.toThrow("5000");
  });

  it("treats the manifest as authoritative and marks a crashed running job resumable", async () => {
    const root = await temporaryDirectory();
    const store = await createQueueStore({ root, catalogue });
    const job = await store.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    await store.updateJob(job.id, { status: "running" });
    await completeManifest(job, { rows: 3, status: "running" });
    const restarted = await createQueueStore({ root, catalogue });
    expect(restarted.getJob(job.id)).toMatchObject({ status: "interrupted", progress: { committedPages: 1, capturedRows: 3 }, slices: [{ pages: 1, rows: 3 }] });
    expect(restarted.snapshot().pilot.passed).toBe(false);
  });

  it("requires verified nonempty Chrome capture pages to unlock a wide run", async () => {
    const root = await temporaryDirectory();
    const store = await createQueueStore({ root, catalogue });
    const job = await store.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    await store.updateJob(job.id, { status: "complete" });
    expect((await store.refreshPilot()).passed).toBe(false);
    await completeManifest(job, { rows: 0 });
    await store.syncManifest(job.id);
    expect((await store.refreshPilot()).passed).toBe(false);
    await completeManifest(job, { tampered: true });
    expect((await store.refreshPilot()).passed).toBe(false);
    await completeManifest(job);
    await store.syncManifest(job.id);
    expect(await store.refreshPilot()).toEqual({ passed: true, jobId: job.id });
  });

  it("refuses a duplicate process and reclaims a dead PID lock", async () => {
    const root = await temporaryDirectory();
    const release = await acquireQueueLock(root);
    await expect(acquireQueueLock(root)).rejects.toThrow("already running");
    await release();
    await fs.writeFile(path.join(root, "queue.lock"), JSON.stringify({ pid: 2147483647, token: "dead" }));
    const releaseReplacement = await acquireQueueLock(root);
    expect(JSON.parse(await fs.readFile(path.join(root, "queue.lock"), "utf8")).pid).toBe(process.pid);
    await releaseReplacement();
  });
});

describe("local extraction queue server", () => {
  it("runs, pauses safely, resumes checkpoints and unlocks a wide run only after the pilot", async () => {
    const root = await temporaryDirectory();
    const fake = fakeWorkerFactory();
    const server = await startQueueServer({ root, port: 0, catalogue, workerFactory: fake.factory });
    servers.push(server);
    const wide = await server.controller.createJob({ name: "Perth", kind: "perth-wide" });
    const custom = await server.controller.createJob({ name: "Custom", kind: "custom", localityIds: catalogue.map((item) => item.id) });
    await expect(server.controller.action(wide.id, "start")).rejects.toThrow("small live pilot");
    await expect(server.controller.action(custom.id, "start")).rejects.toThrow("small live pilot");
    const pilot = await server.controller.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065", "treeby-6164"] });
    await server.controller.action(pilot.id, "start");
    await expect(server.controller.action(pilot.id, "start")).rejects.toThrow("already running");
    await server.controller.action(pilot.id, "pause");
    expect(server.controller.state().jobs.find((job) => job.id === pilot.id)).toMatchObject({ status: "paused", progress: { committedPages: 2, capturedRows: 4 } });
    expect(fake.instances[0].closed).toBe(false);
    await fake.instances[0].options.onState({ ...fake.instances[0].status(), state: "running" });
    expect(server.controller.state().jobs.find((job) => job.id === pilot.id).status).toBe("paused");
    await server.controller.action(pilot.id, "resume");
    await waitFor(server, (state) => state.pilot.passed);
    await server.controller.action(wide.id, "start");
    expect(fake.instances[0].closed).toBe(true);
    expect(fake.instances).toHaveLength(2);
    await server.close();
    expect(fake.instances[1].closed).toBe(true);
    const saved = JSON.parse(await fs.readFile(server.statePath, "utf8"));
    expect(saved.jobs.find((job) => job.id === wide.id).status).toBe("paused");
    await expect(fs.stat(path.join(root, "queue.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops on a source challenge and only retries through an explicit action", async () => {
    const root = await temporaryDirectory();
    const fake = fakeWorkerFactory({ stopAfterChallenge: true });
    const server = await startQueueServer({ root, port: 0, catalogue, workerFactory: fake.factory });
    servers.push(server);
    const pilot = await server.controller.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    await server.controller.action(pilot.id, "start");
    fake.instances[0].release();
    await waitFor(server, (state) => state.jobs[0].status === "source-challenge");
    expect(server.controller.state().pilot.passed).toBe(false);
    await expect(server.controller.action(pilot.id, "resume")).rejects.toThrow("Retry source challenges explicitly");
    await server.controller.action(pilot.id, "retry", {});
    await waitFor(server, (state) => state.pilot.passed);
    expect(fake.instances[0].retryNames).toEqual(["hocking-6065-houses"]);
  });

  it("serves the console locally and rejects cross-origin actions, invalid paths and non-JSON input", async () => {
    const root = await temporaryDirectory();
    const uiDirectory = path.join(root, "ui");
    await fs.mkdir(uiDirectory);
    await fs.writeFile(path.join(uiDirectory, "index.html"), "<h1>Local queue</h1>");
    const server = await startQueueServer({ root, port: 0, catalogue, uiDirectory, workerFactory: fakeWorkerFactory().factory });
    servers.push(server);
    expect(server.server.address().address).toBe("127.0.0.1");
    const home = await fetch(server.url);
    expect(await home.text()).toContain("Local queue");
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const foreign = await fetch(`${server.url}/api/jobs`, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: "{}" });
    expect(foreign.status).toBe(403);
    const noOrigin = await fetch(`${server.url}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noOrigin.status).toBe(403);
    const nonJson = await fetch(`${server.url}/api/jobs`, { method: "POST", headers: { origin: server.url, "content-type": "text/plain" }, body: "{}" });
    expect(nonJson.status).toBe(415);
    const valid = await fetch(`${server.url}/api/jobs`, { method: "POST", headers: { origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ name: "Pilot", kind: "pilot", localityIds: ["treeby-6164"] }) });
    expect(valid.status).toBe(201);
    const state = await fetch(`${server.url}/api/state`).then((response) => response.json());
    expect(state.jobs).toHaveLength(1);
    expect(state.catalogue).toHaveLength(4);
    expect((await fetch(`${server.url}/queue.json`)).status).toBe(404);
    const hostileHost = await new Promise((resolve, reject) => {
      const request = http.get(`${server.url}/api/state`, { headers: { host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
    });
    expect(hostileHost).toBe(403);
    await expect(startQueueServer({ root, port: 0, catalogue })).rejects.toThrow("already running");
  });

  it("retries a failed Chrome startup without inventing failed slices", async () => {
    const root = await temporaryDirectory();
    const fake = fakeWorkerFactory();
    let attempts = 0;
    const server = await startQueueServer({ root, port: 0, catalogue, workerFactory: async (options) => {
      if (++attempts === 1) throw new Error("Chrome profile could not open.");
      return fake.factory(options);
    } });
    servers.push(server);
    const pilot = await server.controller.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    await expect(server.controller.action(pilot.id, "start")).rejects.toThrow("Chrome profile");
    expect(server.controller.state().jobs[0]).toMatchObject({ status: "failed", slices: [{ status: "pending" }] });
    await server.controller.action(pilot.id, "retry");
    expect(fake.instances[0].retryNames).toEqual([]);
    fake.instances[0].release();
    await waitFor(server, (state) => state.pilot.passed);
    expect(attempts).toBe(2);
  });

  it("releases the process lock even if browser shutdown throws", async () => {
    const root = await temporaryDirectory();
    const fake = fakeWorkerFactory();
    const server = await startQueueServer({ root, port: 0, catalogue, workerFactory: fake.factory });
    const pilot = await server.controller.createJob({ name: "Pilot", kind: "pilot", localityIds: ["hocking-6065"] });
    await server.controller.action(pilot.id, "start");
    fake.instances[0].release();
    await waitFor(server, (state) => state.pilot.passed);
    fake.instances[0].close = async () => { throw new Error("Chrome close failed."); };
    await expect(server.close()).rejects.toThrow("Chrome close failed");
    const release = await acquireQueueLock(root);
    await release();
  });
});
