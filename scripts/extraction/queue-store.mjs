import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const ACTIVE_STATUSES = new Set(["starting", "running", "pausing"]);
const hash = (text) => createHash("sha256").update(text).digest("hex");

export class QueueError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function perthDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/** A separate exclusive reclaim file prevents two servers removing a newly acquired lock. */
export async function acquireQueueLock(root) {
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, "queue.lock");
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  async function claim() {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.close();
  }
  try { await claim(); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const reclaimPath = `${lockPath}.reclaim`;
    let reclaim;
    try { reclaim = await fs.open(reclaimPath, "wx"); } catch (reclaimError) {
      if (reclaimError.code === "EEXIST") throw new QueueError("Another queue server is acquiring the capture lock. Try again shortly.", 409);
      throw reclaimError;
    }
    try {
      let previous;
      try { previous = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch (readError) {
        if (readError.code !== "ENOENT") throw new QueueError("Capture lock is unreadable; inspect queue.lock before removing it.", 409);
      }
      if (previous && processAlive(previous.pid)) throw new QueueError(`A queue server is already running (PID ${previous.pid}).`, 409);
      if (previous) await fs.unlink(lockPath);
      try { await claim(); } catch (claimError) {
        if (claimError.code === "EEXIST") throw new QueueError("Another queue server acquired the capture lock.", 409);
        throw claimError;
      }
    } finally {
      await reclaim.close();
      await fs.rm(reclaimPath, { force: true });
    }
  }
  return async () => {
    let current;
    try { current = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current?.token === owner.token) await fs.unlink(lockPath);
  };
}

function zeroProgress(sliceCount) {
  return { pending: sliceCount, running: 0, complete: 0, partial: 0, failed: 0, capped: 0, attempted: 0, committedPages: 0, capturedRows: 0 };
}

function progressFor(slices) {
  const statuses = ["pending", "running", "complete", "partial", "failed", "capped"];
  return { ...Object.fromEntries(statuses.map((status) => [status, slices.filter((slice) => slice.status === status).length])),
    attempted: slices.filter((slice) => slice.status !== "pending").length,
    committedPages: slices.reduce((sum, slice) => sum + slice.pages.length, 0),
    capturedRows: slices.reduce((sum, slice) => sum + (slice.summary?.capturedRows ?? slice.pages.reduce((count, page) => count + (page.rows ?? 0), 0)), 0) };
}

export async function createQueueStore({ root, catalogue, now = () => new Date() }) {
  const directory = path.resolve(root);
  const statePath = path.join(directory, "queue.json");
  await fs.mkdir(directory, { recursive: true });
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  state ??= { schemaVersion: 1, jobs: [], pilot: { passed: false, jobId: null } };
  if (state.schemaVersion !== 1 || !Array.isArray(state.jobs)) throw new QueueError("Unsupported local queue state.", 500);
  const localityMap = new Map(catalogue.map((locality) => [locality.id, locality]));
  let pendingWrite = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(state);
    const write = pendingWrite.then(() => writeJsonAtomic(statePath, snapshot));
    pendingWrite = write.catch(() => {});
    return write;
  };
  const findJob = (id) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw new QueueError("Queue job does not exist.", 404);
    return job;
  };
  const checkedDirectory = (job) => {
    const resolved = path.resolve(job.outputDirectory);
    if (path.dirname(resolved) !== directory || path.basename(resolved) !== `${job.captureDate}-${job.id}`) throw new QueueError("Queue capture path is outside its dated run directory.", 500);
    return resolved;
  };

  async function syncManifest(id, { status, error } = {}) {
    const job = findJob(id);
    const captureDirectory = checkedDirectory(job);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(captureDirectory, "manifest.json"), "utf8")); } catch (readError) { if (readError.code !== "ENOENT") throw readError; }
    if (manifest) {
      if (manifest.runId !== job.runId) throw new QueueError("Capture manifest belongs to a different run.", 500);
      job.progress = progressFor(manifest.slices);
      job.slices = manifest.slices.map((slice) => ({ name: slice.name, suburb: slice.suburb, postcode: slice.postcode,
        status: slice.status, pages: slice.pages.length, rows: slice.summary?.capturedRows ?? slice.pages.reduce((sum, page) => sum + (page.rows ?? 0), 0), failure: slice.failure ?? null }));
      if (!status && !ACTIVE_STATUSES.has(job.status) && !["paused", "interrupted"].includes(job.status)) job.status = manifest.status;
    }
    if (status) job.status = status;
    if (error !== undefined) job.error = error;
    job.updatedAt = now().toISOString();
    await persist();
    return structuredClone(job);
  }

  async function verifyPilot(job) {
    if (job.kind !== "pilot" || job.status !== "complete" || job.localityIds.length > 3 || job.progress.capturedRows < 1 || job.progress.committedPages < 1) return false;
    const captureDirectory = checkedDirectory(job);
    let manifest, plan;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(captureDirectory, "manifest.json"), "utf8"));
      plan = JSON.parse(await fs.readFile(path.join(captureDirectory, "plan.json"), "utf8"));
    } catch { return false; }
    const planSha256 = hash(JSON.stringify(plan));
    if (job.planSha256 !== planSha256 || manifest.planSha256 !== planSha256) return false;
    if (manifest.runId !== job.runId || manifest.status !== "complete" || !manifest.slices.length || !manifest.slices.every((slice) => slice.status === "complete") || manifest.slices.length !== job.localityIds.length) return false;
    let nonemptyPage = false;
    for (const slice of manifest.slices) {
      const planned = plan.slices.find((item) => item.name === slice.name);
      if (!planned || ["suburb", "postcode", "state", "propertyType", "includeSurrounding", "maxSoldAge", "soldDateFrom"].some((key) => planned[key] !== slice[key])) return false;
      for (const page of slice.pages) {
        const file = path.resolve(captureDirectory, page.file);
        if (!file.startsWith(`${captureDirectory}${path.sep}`)) return false;
        let content;
        try { content = await fs.readFile(file, "utf8"); } catch { return false; }
        if (hash(content) !== page.sha256) return false;
        let saved;
        try { saved = JSON.parse(content); } catch { return false; }
        if (saved.evidence?.httpStatus !== 200 || !["chrome-graphql-response", "chrome-bootstrap-response"].includes(saved.evidence?.transport)) return false;
        if (saved.capture?.listings?.length) nonemptyPage = true;
      }
    }
    return nonemptyPage;
  }

  async function refreshPilot() {
    state.pilot = { passed: false, jobId: null };
    for (const job of state.jobs.toReversed()) {
      if (await verifyPilot(job)) { state.pilot = { passed: true, jobId: job.id }; break; }
    }
    await persist();
    return structuredClone(state.pilot);
  }

  for (const job of state.jobs) {
    checkedDirectory(job);
    const interrupted = ACTIVE_STATUSES.has(job.status);
    await syncManifest(job.id, interrupted ? { status: "interrupted", error: "The local worker stopped. Resume from the last committed page." } : {});
  }
  await refreshPilot();

  return {
    directory, statePath,
    getJob: (id) => structuredClone(findJob(id)),
    snapshot: () => structuredClone(state),
    syncManifest,
    refreshPilot,
    flush: () => pendingWrite,
    async updateJob(id, fields) {
      const job = findJob(id);
      Object.assign(job, fields, { updatedAt: now().toISOString() });
      await persist();
      return structuredClone(job);
    },
    async createJob(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new QueueError("Provide a JSON job object.");
      const kind = input.kind ?? "custom";
      if (!["pilot", "custom", "perth-wide"].includes(kind)) throw new QueueError("Choose pilot, custom or perth-wide capture.");
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 100) throw new QueueError("Job name must contain 1–100 characters.");
      let localityIds = kind === "perth-wide" ? [...localityMap.keys()] : input.localityIds;
      if (!Array.isArray(localityIds) || !localityIds.length || localityIds.some((id) => typeof id !== "string" || !localityMap.has(id))) throw new QueueError("Choose at least one locality from the verified catalogue.");
      localityIds = [...new Set(localityIds)];
      if (kind === "pilot" && localityIds.length > 3) throw new QueueError("A pilot capture is limited to three localities.");
      const delayMs = input.delayMs ?? 5000;
      const maxPages = input.maxPages ?? 100;
      if (!Number.isSafeInteger(delayMs) || delayMs < 5000 || delayMs > 60000) throw new QueueError("Page delay must be between 5000 and 60000 milliseconds.");
      if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new QueueError("Page limit must be between 1 and 100.");
      const created = now();
      const captureDate = perthDate(created);
      const id = randomUUID();
      const runId = `perth-houses-${captureDate}-${id}`;
      const outputDirectory = path.join(directory, `${captureDate}-${id}`);
      const comparisonCutoff = "2026-06-01";
      const slices = localityIds.map((localityId) => {
        const locality = localityMap.get(localityId);
        return { name: `${locality.id}-houses`, suburb: locality.suburb, postcode: locality.postcode, state: "WA",
          propertyType: "house", includeSurrounding: false, maxSoldAge: "6-month", soldDateFrom: comparisonCutoff };
      });
      const baseline = path.relative(outputDirectory, path.join(directory, "..", "2026-07-baseline", "manifest.json")).replaceAll(path.sep, "/");
      const plan = { schemaVersion: 1, runId, createdAt: created.toISOString(), kind, comparisonCutoff, settings: { delayMs, maxPages, concurrency: 1, comparisonCutoff }, baseline, slices };
      await fs.mkdir(outputDirectory);
      await writeJsonAtomic(path.join(outputDirectory, "plan.json"), plan);
      const job = { id, name, kind, status: "queued", createdAt: created.toISOString(), updatedAt: created.toISOString(), captureDate, runId,
        outputDirectory, localityIds, delayMs, maxPages, planSha256: hash(JSON.stringify(plan)), progress: zeroProgress(slices.length), error: null,
        slices: slices.map((slice) => ({ name: slice.name, suburb: slice.suburb, postcode: slice.postcode, status: "pending", pages: 0, rows: 0, failure: null })) };
      state.jobs.push(job);
      await persist();
      return structuredClone(job);
    },
  };
}
