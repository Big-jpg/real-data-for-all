import { createChromeCollector } from "../chrome-listing-collector.mjs";
import { createPlaywrightTransport } from "./playwright-transport.mjs";

/** A single local worker. Its browser stays open during pauses and source verification. */
export async function createExtractionWorker({ planPath, outputDirectory, profileDirectory, delayMs = 5000, maxPages = 100,
  onUpdate = () => {}, onState = () => {}, channel = "chrome", core, transportFactory = createPlaywrightTransport,
  collectorFactory = createChromeCollector } = {}) {
  if (!planPath || !outputDirectory || !profileDirectory) throw new Error("Worker requires a plan, capture directory and dedicated Chrome profile");
  const captureCore = core ?? await import(new URL("../../captures/_runtime/rea-listing-capture.mjs", import.meta.url).href);
  const transport = await transportFactory({ profileDirectory, channel });
  let collector;
  try { collector = await collectorFactory({ ...transport, core: captureCore, planPath, outputDirectory, delayMs, maxPages }); }
  catch (error) { await transport.close(); throw error; }
  let state = collector.status().status === "source-challenge" ? "source-challenge" : collector.status().status === "paused" ? "paused" : "idle";
  let error = null;
  let runPromise = null;
  let closing = false;

  const status = () => ({ state, ...collector.status(), manifestPath: collector.manifestPath, error });
  // A failed observer must not make an already committed page appear to have failed extraction.
  const emit = (callback) => {
    try { Promise.resolve(callback(status())).catch((failure) => console.error("Extraction observer failed:", failure.message)); }
    catch (failure) { console.error("Extraction observer failed:", failure.message); }
  };
  const setState = (next) => { state = next; emit(onState); };

  async function runLoop() {
    try {
      collector.resume(); error = null; setState("running");
      while (state === "running" || state === "pausing") {
        const result = await collector.runBatch({ maxMs: 90000, maxCommittedPages: 1 });
        emit(onUpdate);
        if (result.stopped) { error = result.reason; setState("source-challenge"); break; }
        if (result.done) { setState(collector.status().status); break; }
        if (result.paused || state === "pausing") { setState("paused"); break; }
      }
      return status();
    } catch (failure) {
      error = String(failure.message ?? failure); setState("error"); emit(onUpdate);
      throw failure;
    }
  }

  async function run() {
    if (closing || state === "closed") throw new Error("Worker is closed");
    if (runPromise) throw new Error("An extraction run is already active");
    if (state === "source-challenge") throw new Error("Retry the challenged slice explicitly before resuming");
    const task = runLoop(); runPromise = task;
    try { return await task; } finally { if (runPromise === task) runPromise = null; }
  }

  async function pause() {
    if (state === "closed") return status();
    if (runPromise) setState("pausing");
    await collector.pause();
    if (runPromise) await runPromise;
    const persisted = collector.status().status;
    if (["complete", "finished-with-exceptions", "source-challenge"].includes(persisted)) setState(persisted);
    else setState("paused");
    emit(onUpdate); return status();
  }

  async function retry(names) {
    if (closing || state === "closed") throw new Error("Worker is closed");
    if (runPromise) throw new Error("Pause the worker before retrying exceptions");
    const result = await collector.retryExceptions(names);
    if (result.retried > 0) { error = null; setState("paused"); }
    emit(onUpdate); return { ...status(), retried: result.retried };
  }

  async function close() {
    if (state === "closed" || closing) return;
    closing = true;
    try {
      await pause();
      await collector.stop();
    } finally { await transport.close(); setState("closed"); }
  }

  emit(onUpdate);
  return { run, pause, resume: run, retry, close, status };
}
