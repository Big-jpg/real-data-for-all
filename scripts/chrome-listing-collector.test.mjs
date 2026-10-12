import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as captureCore from "../src/lib/rea-listing-capture";
import { createChromeCollector, listingUrl, listingUrlMatches, readBootstrapResponse, requestMatches } from "./chrome-listing-collector.mjs";

const ENDPOINT = "https://lexa.realestate.com.au/graphql";
const CAPTURED_AT = "2026-10-11T17:00:00.000Z";
const hocking = { name: "hocking-6065-houses", suburb: "Hocking", state: "WA", postcode: "6065", propertyType: "house", includeSurrounding: false, maxSoldAge: "6-month", soldDateFrom: "2026-06-01" };
const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    const expectedPrefix = path.join(path.resolve(os.tmpdir()), "rea-collector-test-");
    if (!resolved.startsWith(expectedPrefix)) throw new Error("Refusing cleanup outside the collector test directory");
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

function queryFor(slice = hocking, page = 1) {
  return { channel: "sold", page, pageSize: 25, sortType: "sold-date-desc", filters: {
    propertyTypes: ["house"], maxSoldAge: { value: 6, unit: "month" }, surroundingSuburbs: false, excludeNoSalePrice: false,
  }, localities: [{ searchLocation: `${slice.suburb}, wa ${slice.postcode}` }] };
}

function requestFor(query = queryFor()) {
  return { url: ENDPOINT, postData: JSON.stringify({ operationName: "soldSearchByQuery", variables: { query: JSON.stringify(query) },
    extensions: { persistedQuery: { version: 1, sha256Hash: "observed-public-query-hash" } } }) };
}

function responseFor({ page = 1, count = 1, total = count, start = 1, more = false, suburb = "Hocking", postcode = "6065" } = {}) {
  const items = Array.from({ length: count }, (_, index) => {
    const id = String(152180000 + start + index);
    return { listing: {
      id, address: { display: { shortAddress: `${start + index} Example Street` }, suburb, state: "WA", postcode },
      price: { display: "$1,100,000" }, dateSold: { display: "13 Sep 2026" }, propertyType: { display: "House" },
      generalFeatures: { bedrooms: { value: 4 }, bathrooms: { value: 2 }, parkingSpaces: { value: 2 } },
      propertySizes: { land: { displayValue: "426", sizeUnit: { displayValue: "m²" } } },
      _links: { canonical: { path: `/sold/property-house-wa-hocking-${id}`, href: `https://www.realestate.com.au/sold/property-house-wa-hocking-${id}` } },
      listingCompany: { unnecessaryContact: "must not cross the bridge" }, trackingData: "must not cross the bridge",
    } };
  });
  return { data: { soldSearch: {
    resolvedQuery: { localities: [{ name: suburb, seoName: suburb, display: `${suburb}, WA ${postcode}`, state: "WA" }],
      metadata: { savedSearchQuery: JSON.stringify(queryFor({ ...hocking, suburb, postcode }, page)) } },
    results: { totalResultsCount: total, pagination: { page, maxPageNumberAvailable: Math.ceil(total / 25), moreResultsAvailable: more }, exact: { items }, surrounding: null },
  } } };
}

async function workspace(slices = [hocking]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rea-collector-test-"));
  temporaryDirectories.push(directory);
  const planPath = path.join(directory, "plan.json");
  const outputDirectory = path.join(directory, "capture");
  await fs.writeFile(planPath, JSON.stringify({ runId: "perth-houses-2026-10-12-test", slices }));
  return { directory, planPath, outputDirectory };
}

/** Deliver events in separate reads so response-body availability cannot be assumed from AX readiness. */
function browserFixture(routes) {
  let url = "https://www.realestate.com.au/sold/";
  let sequence = 0;
  let requestNumber = 0;
  const events = [];
  const pendingChunks = [];
  const bodies = new Map();
  const completed = new Set();
  const navigations = [];
  const bodyReads = [];
  function navigate(target) {
    url = target;
    navigations.push(target);
    const route = routes.get(target);
    if (!route) throw new Error(`No fixture for ${target}`);
    const requestId = `fixture-${++requestNumber}`;
    const page = Number(/\/list-(\d+)/.exec(target)[1]);
    const query = route.query ?? queryFor(hocking, page);
    const response = { method: "Network.responseReceived", params: { requestId, type: "Fetch", response: {
      url: ENDPOINT, status: route.status ?? 200, mimeType: "application/json",
    } } };
    pendingChunks.push([
      { method: "Network.requestWillBeSent", params: { requestId, wallTime: Date.parse(CAPTURED_AT) / 1000 + page, request: requestFor(query) } },
      response,
    ]);
    if ((route.status ?? 200) === 200) pendingChunks.push([{ method: "Network.loadingFinished", params: { requestId } }]);
    bodies.set(requestId, JSON.stringify(route.payload));
  }
  const cdp = {
    send: vi.fn(async (method, parameters) => {
      if (method !== "Network.getResponseBody") return {};
      expect(completed.has(parameters.requestId)).toBe(true);
      bodyReads.push(parameters.requestId);
      return { body: bodies.get(parameters.requestId), base64Encoded: false };
    }),
    readEvents: vi.fn(async ({ afterSequence } = {}) => {
      if (afterSequence === undefined) return { cursor: sequence, events: [], hasMore: false, truncated: false };
      for (const event of pendingChunks.shift() ?? []) {
        event.sequence = ++sequence;
        events.push(event);
        if (event.method === "Network.loadingFinished") completed.add(event.params.requestId);
      }
      return { cursor: sequence, events: events.filter((event) => event.sequence > afterSequence), hasMore: false, truncated: false };
    }),
  };
  const tab = {
    url: async () => url,
    goto: vi.fn(async (target) => navigate(target)),
    reload: vi.fn(async () => navigate(url)),
    getAXState: vi.fn(async () => ({})),
    playwright: {
      evaluate: vi.fn(async () => { throw new Error("The GraphQL fixture must not use a bootstrap fallback"); }),
      getByRole: vi.fn((role, options) => {
        expect(role).toBe("link");
        expect(options).toMatchObject({ name: "Go to next page", exact: true });
        return { click: async () => navigate(listingUrl(hocking, Number(/\/list-(\d+)/.exec(url)[1]) + 1)) };
      }),
    },
  };
  return { tab, cdp, navigations, bodyReads };
}

async function manifestAt(outputDirectory) {
  return JSON.parse(await fs.readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
}

describe("Chrome listing response transport", () => {
  it("accepts query parameter ordering while rejecting a changed page or source scope", () => {
    const target = listingUrl(hocking);
    const reordered = new URL(target); reordered.searchParams.sort();
    expect(listingUrlMatches(reordered.href, target)).toBe(true);
    expect(listingUrlMatches(listingUrl(hocking, 2), target)).toBe(false);
    reordered.searchParams.set("includeSurrounding", "true");
    expect(listingUrlMatches(reordered.href, target)).toBe(false);
  });
  it("matches the complete observed query scope and rejects stale pages or different filters", () => {
    expect(requestMatches(requestFor(), hocking, 1)).toBe(true);
    const changedName = queryFor(); changedName.localities[0].searchLocation = "  HOCKING,   WA 6065  ";
    expect(requestMatches(requestFor(changedName), hocking, 1)).toBe(true);
    for (const change of [
      { page: 2 }, { pageSize: 50 }, { channel: "buy" }, { sortType: "featured" },
      { localities: [{ searchLocation: "Perth, wa 6000" }] },
      { filters: { ...queryFor().filters, surroundingSuburbs: true } },
      { filters: { ...queryFor().filters, excludeNoSalePrice: true } },
      { filters: { ...queryFor().filters, propertyTypes: ["house", "townhouse"] } },
      { filters: { ...queryFor().filters, maxSoldAge: { value: 3, unit: "month" } } },
    ]) expect(requestMatches(requestFor({ ...queryFor(), ...change }), hocking, 1)).toBe(false);
    expect(requestMatches({ postData: "not JSON" }, hocking, 1)).toBe(false);
  });

  it("crosses the DOM bridge as JSON text and retains deeply nested listing fields without contacts", async () => {
    const data = responseFor().data;
    const exchange = { "resi-property_listing-experience-web": { urqlClientCache: JSON.stringify({ query: { data: JSON.stringify(data) } }) } };
    vi.stubGlobal("document", { scripts: [{ textContent: `window.ArgonautExchange=${JSON.stringify(exchange)};` }] });
    const evaluate = vi.fn(async (read) => {
      const bridgeValue = read();
      expect(typeof bridgeValue).toBe("string");
      return bridgeValue;
    });
    const payload = await readBootstrapResponse({ playwright: { evaluate } });
    const listing = payload.data.soldSearch.results.exact.items[0].listing;
    expect(listing.propertySizes.land.sizeUnit.displayValue).toBe("m²");
    expect(listing.generalFeatures.bedrooms.value).toBe(4);
    expect(listing).not.toHaveProperty("listingCompany");
    expect(listing).not.toHaveProperty("trackingData");
    vi.stubGlobal("document", { scripts: [] });
    expect(await readBootstrapResponse({ playwright: { evaluate: async (read) => read() } })).toBeNull();
  });

  it("waits for body completion and resumes a durable page without rewriting its timestamp", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([
      [listingUrl(hocking, 1), { payload: responseFor({ count: 25, total: 26, more: true }) }],
      [listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26 }) }],
    ]));
    const projected = vi.fn(captureCore.adaptProjectedPage);
    const core = { ...captureCore, adaptProjectedPage: projected };
    const first = await createChromeCollector({ ...browser, core, ...files, delayMs: 0 });
    expect(await first.runBatch({ maxCommittedPages: 1 })).toMatchObject({ done: false, committedThisBatch: 1 });
    const checkpoint = await manifestAt(files.outputDirectory);
    expect(checkpoint.slices[0]).toMatchObject({ status: "running", pages: [{ pageNumber: 1, rows: 25 }] });
    const pagePath = path.join(files.outputDirectory, checkpoint.slices[0].pages[0].file);
    const before = await fs.readFile(pagePath, "utf8");
    expect(createHash("sha256").update(before).digest("hex")).toBe(checkpoint.slices[0].pages[0].sha256);
    await first.stop();

    const restarted = await createChromeCollector({ ...browser, core, ...files, delayMs: 0 });
    restarted.resume();
    expect(await restarted.runBatch()).toMatchObject({ done: true, progress: { complete: 1, committedPages: 2, capturedRows: 26 } });
    expect(projected).toHaveBeenCalledTimes(1);
    expect(browser.navigations).toEqual([listingUrl(hocking, 1), listingUrl(hocking, 2)]);
    expect(browser.bodyReads).toHaveLength(2);
    expect(await fs.readFile(pagePath, "utf8")).toBe(before);
    const complete = await manifestAt(files.outputDirectory);
    const csv = await fs.readFile(path.join(files.outputDirectory, complete.slices[0].csv.file), "utf8");
    expect(csv).toContain("2026-10-11T17:00:01.000Z");
    expect(complete.slices[0].summary).toMatchObject({ status: "complete", capturedRows: 26, uniqueListingIds: 26, terminalPageReached: true });
  });

  it("keeps an invalid page out of the checkpoint and retries from the last valid page", async () => {
    const files = await workspace();
    const routes = new Map([
      [listingUrl(hocking, 1), { payload: responseFor({ count: 25, total: 26, more: true }) }],
      [listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26, suburb: "Perth", postcode: "6000" }) }],
    ]);
    const browser = browserFixture(routes);
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    expect(await collector.runBatch()).toMatchObject({ done: true, progress: { partial: 1, committedPages: 1, capturedRows: 25 } });
    const failed = await manifestAt(files.outputDirectory);
    expect(failed.slices[0].pages).toHaveLength(1);
    expect(failed.slices[0].failure).toContain("Resolved search locality does not match");
    await expect(fs.access(path.join(files.outputDirectory, "pages", hocking.name, "page-002.json"))).rejects.toMatchObject({ code: "ENOENT" });

    routes.set(listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26 }) });
    await collector.retryExceptions([hocking.name]);
    expect(await collector.runBatch()).toMatchObject({ done: true, progress: { complete: 1, capturedRows: 26, committedPages: 2 } });
    expect(browser.navigations).toEqual([listingUrl(hocking, 1), listingUrl(hocking, 2), listingUrl(hocking, 2)]);
    const recovered = await manifestAt(files.outputDirectory);
    expect(recovered.slices[0]).not.toHaveProperty("failure");
  });

  it("stops on a source challenge before attempting the next suburb", async () => {
    const perth = { ...hocking, name: "perth-6000-houses", suburb: "Perth", postcode: "6000" };
    const files = await workspace([hocking, perth]);
    const browser = browserFixture(new Map([[listingUrl(hocking), { status: 429, payload: null }]]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    const stopped = await collector.runBatch();
    expect(stopped).toMatchObject({ stopped: true, reason: "SOURCE_CHALLENGE: listing response 429", progress: { failed: 1, pending: 1, committedPages: 0 } });
    expect(browser.navigations).toEqual([listingUrl(hocking)]);
    expect(browser.bodyReads).toEqual([]);
    const manifest = await manifestAt(files.outputDirectory);
    expect(manifest.status).toBe("source-challenge");
    expect(manifest.slices[1].status).toBe("pending");
  });

  it("refuses a modified committed page when resuming", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([[listingUrl(hocking), { payload: responseFor({ count: 25, total: 26, more: true }) }]]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await collector.runBatch({ maxCommittedPages: 1 });
    const checkpoint = await manifestAt(files.outputDirectory);
    const committedPath = path.join(files.outputDirectory, checkpoint.slices[0].pages[0].file);
    await fs.appendFile(committedPath, " ");
    const restarted = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await expect(restarted.runBatch()).rejects.toThrow("Committed page checksum failed");
    expect(browser.navigations).toHaveLength(1);
  });

  it("finalizes a terminal checkpoint after restart without requesting an extra page", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([[listingUrl(hocking), { payload: responseFor() }]]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await collector.runBatch();
    const checkpoint = await manifestAt(files.outputDirectory);
    const originalPage = await fs.readFile(path.join(files.outputDirectory, checkpoint.slices[0].pages[0].file), "utf8");
    // Reconstruct the durable state between the terminal page commit and slice finalization.
    await fs.unlink(path.join(files.outputDirectory, checkpoint.slices[0].csv.file));
    checkpoint.slices[0].status = "running";
    delete checkpoint.slices[0].csv;
    delete checkpoint.slices[0].finishedAt;
    checkpoint.status = "running";
    await fs.writeFile(path.join(files.outputDirectory, "manifest.json"), JSON.stringify(checkpoint));

    const restarted = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    expect(await restarted.runBatch()).toMatchObject({ done: true, committedThisBatch: 0, progress: { complete: 1, capturedRows: 1, committedPages: 1 } });
    expect(browser.navigations).toEqual([listingUrl(hocking)]);
    const recovered = await manifestAt(files.outputDirectory);
    expect(await fs.readFile(path.join(files.outputDirectory, recovered.slices[0].pages[0].file), "utf8")).toBe(originalPage);
    expect(await fs.readFile(path.join(files.outputDirectory, recovered.slices[0].csv.file), "utf8")).toContain("1 Example Street, Hocking");
  });

  it("defers the next page when the batch lacks a full action budget, without failing the slice", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([
      [listingUrl(hocking, 1), { payload: responseFor({ count: 25, total: 26, more: true }) }],
      [listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26 }) }],
    ]));
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    browser.tab.getAXState.mockImplementation(async () => { clock += 20_000; return {}; });
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });

    expect(await collector.runBatch({ maxMs: 45_000 })).toMatchObject({ done: false, committedThisBatch: 1, progress: { running: 1, failed: 0, partial: 0, committedPages: 1 } });
    expect(browser.navigations).toEqual([listingUrl(hocking, 1)]);
    const checkpoint = await manifestAt(files.outputDirectory);
    expect(checkpoint.slices[0]).not.toHaveProperty("failure");
    expect(await collector.runBatch({ maxMs: 45_000 })).toMatchObject({ done: true, committedThisBatch: 1, progress: { complete: 1, committedPages: 2 } });
    expect(browser.navigations).toEqual([listingUrl(hocking, 1), listingUrl(hocking, 2)]);
  });

  it("pauses after committing an in-flight page and rejects overlapping batches or retry resets", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([
      [listingUrl(hocking, 1), { payload: responseFor({ count: 25, total: 26, more: true }) }],
      [listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26 }) }],
    ]));
    let release, entered;
    const navigationGate = new Promise((resolve) => { release = resolve; });
    const navigationStarted = new Promise((resolve) => { entered = resolve; });
    const navigate = browser.tab.goto.getMockImplementation();
    browser.tab.goto.mockImplementationOnce(async (target) => { await navigate(target); entered(); await navigationGate; });
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    const run = collector.runBatch();
    await navigationStarted;
    await expect(collector.runBatch()).rejects.toThrow("already running");
    await expect(collector.retryExceptions([hocking.name])).rejects.toThrow("Pause the collector");
    const paused = collector.pause();
    release();
    expect(await run).toMatchObject({ paused: true, done: false, committedThisBatch: 1 });
    await paused;
    const checkpoint = await manifestAt(files.outputDirectory);
    expect(checkpoint).toMatchObject({ status: "paused", progress: { committedPages: 1, capturedRows: 25 } });
    expect(browser.navigations).toEqual([listingUrl(hocking, 1)]);
    const pageFile = path.join(files.outputDirectory, checkpoint.slices[0].pages[0].file);
    const firstPage = await fs.readFile(pageFile, "utf8");
    collector.resume();
    expect(await collector.runBatch()).toMatchObject({ done: true, progress: { complete: 1, committedPages: 2 } });
    expect(await fs.readFile(pageFile, "utf8")).toBe(firstPage);
    await collector.stop();
    await expect(collector.runBatch()).rejects.toThrow("closed");
  });

  it("requires an explicit challenged-slice retry before any further navigation", async () => {
    const files = await workspace();
    const routes = new Map([[listingUrl(hocking), { status: 429, payload: null }]]);
    const browser = browserFixture(routes);
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await collector.runBatch();
    expect(await collector.runBatch()).toMatchObject({ stopped: true });
    expect(() => collector.resume()).toThrow("Retry the challenged slice explicitly");
    await collector.retryExceptions([]);
    expect(await collector.runBatch()).toMatchObject({ stopped: true });
    expect(browser.navigations).toHaveLength(1);
    await expect(collector.retryExceptions(["unknown-slice"])).rejects.toThrow("unknown slice");
    routes.set(listingUrl(hocking), { payload: responseFor() });
    expect(await collector.retryExceptions([hocking.name])).toEqual({ retried: 1 });
    collector.resume();
    expect(await collector.runBatch()).toMatchObject({ done: true, progress: { complete: 1 } });
  });

  it("uses the dated plan's comparison metadata and resumes a saved pause deliberately", async () => {
    const files = await workspace();
    const plan = JSON.parse(await fs.readFile(files.planPath, "utf8"));
    plan.comparisonCutoff = "2026-10-01";
    plan.baseline = "../2026-07-baseline/manifest.json";
    await fs.writeFile(files.planPath, JSON.stringify(plan));
    const browser = browserFixture(new Map([[listingUrl(hocking), { payload: responseFor() }]]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await collector.pause();
    const restarted = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    expect(await restarted.runBatch()).toMatchObject({ paused: true, committedThisBatch: 0 });
    expect(browser.navigations).toEqual([]);
    restarted.resume();
    await restarted.runBatch();
    expect(await manifestAt(files.outputDirectory)).toMatchObject({ baseline: plan.baseline, settings: { comparisonCutoff: "2026-10-01" } });
  });

  it("does not navigate when a pause arrives during the between-page delay", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([
      [listingUrl(hocking, 1), { payload: responseFor({ count: 25, total: 26, more: true }) }],
      [listingUrl(hocking, 2), { payload: responseFor({ page: 2, start: 26, total: 26 }) }],
    ]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 5000 });
    await collector.runBatch({ maxCommittedPages: 1 });
    let release, entered;
    const delayStarted = new Promise((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "setTimeout").mockImplementationOnce((resolve, delay) => { expect(delay).toBeGreaterThan(0); release = resolve; entered(); return 0; });
    const run = collector.runBatch();
    await delayStarted;
    const paused = collector.pause(); release();
    expect(await run).toMatchObject({ paused: true, committedThisBatch: 0 });
    await paused;
    expect(browser.navigations).toEqual([listingUrl(hocking, 1)]);
    expect((await manifestAt(files.outputDirectory)).slices[0]).not.toHaveProperty("failure");
  });

  it("rejects checkpoint path traversal and altered scope before making another request", async () => {
    const files = await workspace();
    const browser = browserFixture(new Map([[listingUrl(hocking), { payload: responseFor({ count: 25, total: 26, more: true }) }]]));
    const collector = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await collector.runBatch({ maxCommittedPages: 1 });
    const checkpoint = await manifestAt(files.outputDirectory);
    checkpoint.slices[0].pages[0].file = "../outside.json";
    await fs.writeFile(path.join(files.outputDirectory, "manifest.json"), JSON.stringify(checkpoint));
    const restarted = await createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 });
    await expect(restarted.runBatch()).rejects.toThrow("Committed page path or sequence is invalid");
    checkpoint.slices[0].suburb = "Perth";
    await fs.writeFile(path.join(files.outputDirectory, "manifest.json"), JSON.stringify(checkpoint));
    await expect(createChromeCollector({ ...browser, core: captureCore, ...files, delayMs: 0 })).rejects.toThrow("slice scope does not match");
    expect(browser.navigations).toHaveLength(1);
  });
});
