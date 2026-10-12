import { describe, expect, it, vi } from "vitest";
import { createExtractionWorker } from "./worker.mjs";

function fixture() {
  let status = "running", paused = false;
  const collector = {
    manifestPath: "/capture/manifest.json",
    status: () => ({ status, progress: { committedPages: 0 }, active: "hocking-6065-houses" }),
    resume: vi.fn(() => { paused = false; }),
    pause: vi.fn(async () => { paused = true; status = "paused"; }),
    runBatch: vi.fn(async () => { status = paused ? "paused" : "complete"; return { done: !paused, paused }; }),
    retryExceptions: vi.fn(async () => { status = "paused"; return { retried: 1 }; }),
    stop: vi.fn(async () => {}),
  };
  const transport = { tab: {}, cdp: {}, close: vi.fn(async () => {}) };
  const options = { planPath: "/plan.json", outputDirectory: "/capture", profileDirectory: "/profile", core: {},
    transportFactory: vi.fn(async () => transport), collectorFactory: vi.fn(async () => collector) };
  return { collector, transport, options, setStatus: (next) => { status = next; } };
}

describe("local extraction worker lifecycle", () => {
  it("publishes page progress and keeps Chrome open until explicit shutdown", async () => {
    const test = fixture(); const onUpdate = vi.fn(), onState = vi.fn();
    const worker = await createExtractionWorker({ ...test.options, onUpdate, onState });
    expect(await worker.run()).toMatchObject({ state: "complete", status: "complete", manifestPath: "/capture/manifest.json" });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onState.mock.calls.map(([value]) => value.state)).toEqual(["running", "complete"]);
    expect(test.transport.close).not.toHaveBeenCalled();
    await worker.close(); await worker.close();
    expect(test.collector.stop).toHaveBeenCalledTimes(1);
    expect(test.transport.close).toHaveBeenCalledTimes(1);
    await expect(worker.run()).rejects.toThrow("closed");
  });

  it("waits for an active page on pause, refuses duplicate runs and permits deliberate resume", async () => {
    const test = fixture(); let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const pageGate = new Promise((resolve) => { release = resolve; });
    test.collector.runBatch.mockImplementationOnce(async () => { entered(); await pageGate; return { paused: true, done: false }; });
    const worker = await createExtractionWorker(test.options);
    const run = worker.run(); await started;
    await expect(worker.run()).rejects.toThrow("already active");
    await expect(worker.retry()).rejects.toThrow("Pause the worker");
    const pause = worker.pause();
    expect(worker.status().state).toBe("pausing");
    expect(test.transport.close).not.toHaveBeenCalled();
    release();
    expect(await run).toMatchObject({ state: "paused" });
    expect(await pause).toMatchObject({ state: "paused" });
    expect(await worker.resume()).toMatchObject({ state: "complete" });
    await worker.close();
  });

  it("halts a source challenge until explicit retry and never automatically closes or relaunches Chrome", async () => {
    const test = fixture();
    test.collector.runBatch.mockImplementationOnce(async () => { test.setStatus("source-challenge"); return { stopped: true, reason: "SOURCE_CHALLENGE: HTTP 429" }; });
    const worker = await createExtractionWorker(test.options);
    expect(await worker.run()).toMatchObject({ state: "source-challenge", error: "SOURCE_CHALLENGE: HTTP 429" });
    await expect(worker.resume()).rejects.toThrow("Retry the challenged slice explicitly");
    expect(test.collector.runBatch).toHaveBeenCalledTimes(1);
    expect(test.transport.close).not.toHaveBeenCalled();
    expect(await worker.retry(["hocking-6065-houses"])).toMatchObject({ retried: 1, state: "paused", error: null });
    expect(test.collector.retryExceptions).toHaveBeenCalledWith(["hocking-6065-houses"]);
    expect(await worker.resume()).toMatchObject({ state: "complete" });
    expect(test.options.transportFactory).toHaveBeenCalledTimes(1);
    await worker.close();
  });

  it("closes Chrome when initial checkpoint loading fails", async () => {
    const test = fixture(); test.options.collectorFactory.mockRejectedValueOnce(new Error("bad checkpoint"));
    await expect(createExtractionWorker(test.options)).rejects.toThrow("bad checkpoint");
    expect(test.transport.close).toHaveBeenCalledTimes(1);
  });
});
