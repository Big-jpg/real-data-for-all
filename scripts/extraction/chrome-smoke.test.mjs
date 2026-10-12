import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import * as core from "../../src/lib/rea-listing-capture";
import { listingUrl } from "../chrome-listing-collector.mjs";
import { createPlaywrightTransport } from "./playwright-transport.mjs";
import { createExtractionWorker } from "./worker.mjs";

// These synthetic browser fixtures cannot qualify the live queue's pilot gate.
// Run explicitly: EXTRACTION_CHROME_SMOKE=1 node node_modules/vitest/vitest.mjs run scripts/extraction/chrome-smoke.test.mjs
const smoke = process.env.EXTRACTION_CHROME_SMOKE === "1" ? describe : describe.skip;
const ENDPOINT = "https://lexa.realestate.com.au/graphql";
const ORIGIN = "https://www.realestate.com.au";
const SLICE = { name: "hocking-6065-houses", suburb: "Hocking", state: "WA", postcode: "6065", propertyType: "house",
  includeSurrounding: false, maxSoldAge: "6-month", soldDateFrom: "2026-06-01" };
const activeWorkers = new Set();
const sha = (text) => createHash("sha256").update(text).digest("hex");

afterEach(async () => { for (const worker of activeWorkers) { await worker.close(); activeWorkers.delete(worker); } });

function query(page) {
  return { channel: "sold", page, pageSize: 25, sortType: "sold-date-desc",
    filters: { propertyTypes: ["house"], maxSoldAge: { value: 6, unit: "month" }, surroundingSuburbs: false, excludeNoSalePrice: false },
    localities: [{ searchLocation: "Hocking, wa 6065" }] };
}

function payload(page) {
  const start = page === 1 ? 1 : 26;
  const count = page === 1 ? 25 : 1;
  return { data: { soldSearch: {
    resolvedQuery: { localities: [{ name: "Hocking", seoName: "Hocking", display: "Hocking, WA 6065", state: "WA" }],
      metadata: { savedSearchQuery: JSON.stringify(query(page)) } },
    results: { totalResultsCount: 26, pagination: { page, maxPageNumberAvailable: 2, moreResultsAvailable: page === 1 },
      exact: { items: Array.from({ length: count }, (_, index) => {
        const id = String(152180000 + start + index);
        return { listing: { id, address: { display: { shortAddress: `${start + index} Synthetic Fixture Street` }, suburb: "Hocking", state: "WA", postcode: "6065" },
          price: { display: "$1,100,000" }, dateSold: { display: "13 Sep 2026" }, propertyType: { display: "House" },
          generalFeatures: { bedrooms: { value: 4 }, bathrooms: { value: 2 }, parkingSpaces: { value: 2 } },
          propertySizes: { land: { displayValue: "426", sizeUnit: { displayValue: "m²" } } },
          _links: { canonical: { path: `/sold/property-house-wa-hocking-${id}` } } } };
      }) }, surrounding: null },
  } } };
}

function fixtureHtml(page) {
  const exchange = { "resi-property_listing-experience-web": { urqlClientCache: JSON.stringify({ fixture: { data: JSON.stringify(payload(page).data) } }) } };
  const request = { operationName: "soldSearchByQuery", variables: { query: JSON.stringify(query(2)) },
    extensions: { persistedQuery: { version: 1, sha256Hash: "synthetic-fixture-only" } } };
  const next = page === 1 ? `<a id="next" aria-label="Go to next page" href="${listingUrl(SLICE, 2)}">Next synthetic page</a>
    <script>document.getElementById("next").addEventListener("click", async (event) => {
      event.preventDefault();
      const response = await fetch(${JSON.stringify(ENDPOINT)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(request))} });
      await response.json();
      // Deliberately lag the response so the collector must wait for SPA URL readiness.
      setTimeout(() => { history.pushState({}, "", ${JSON.stringify(listingUrl(SLICE, 2))}); document.getElementById("fixture-page").textContent = "Synthetic page 2"; }, 250);
    });</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OFFLINE SYNTHETIC EXTRACTION TEST</title></head><body>
    <h1>Offline synthetic extraction fixture</h1><p>No real listing data or external network is used.</p><p id="fixture-page">Synthetic page ${page}</p>
    <script>window.ArgonautExchange=${JSON.stringify(exchange)};</script>${next}</body></html>`;
}

async function fixture(name) {
  const root = path.resolve("captures/_smoke", `${name}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const planPath = path.join(root, "plan.json");
  const outputDirectory = path.join(root, "synthetic-capture");
  const profileDirectory = path.join(root, "synthetic-chrome-profile");
  const plan = { schemaVersion: 1, runId: `synthetic-${name}-${randomUUID()}`, fixtureOnly: true,
    comparisonCutoff: "2026-06-01", baseline: "synthetic-fixture-has-no-live-baseline", slices: [SLICE] };
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await fs.writeFile(path.join(root, "README.txt"), "OFFLINE SYNTHETIC FIXTURE ONLY. Not real property data. Not a live pilot. Do not ingest or publish.\n");
  const requests = [];
  const transportFactory = async (options) => createPlaywrightTransport({ ...options, launchPersistentContext: async (profile, launchOptions) => {
    const context = await chromium.launchPersistentContext(profile, { ...launchOptions, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let kind = "blocked-unrelated-request";
      if (url.href === ENDPOINT && request.method() === "OPTIONS") {
        kind = "synthetic-preflight";
        await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" }, body: "" });
      } else if (url.href === ENDPOINT && request.method() === "POST") {
        kind = "synthetic-graphql";
        await route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": ORIGIN }, body: JSON.stringify(payload(2)) });
      } else if (url.origin === ORIGIN && request.isNavigationRequest() && /\/list-[12]$/.test(url.pathname)) {
        kind = "synthetic-document";
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml(Number(/list-(\d+)$/.exec(url.pathname)[1])) });
      } else await route.abort("blockedbyclient");
      requests.push({ url: url.href, method: request.method(), kind, forwarded: false });
    });
    return context;
  } });
  const worker = async (onUpdate) => {
    const instance = await createExtractionWorker({ planPath, outputDirectory, profileDirectory, core, transportFactory, delayMs: 0, maxPages: 10, onUpdate });
    activeWorkers.add(instance); return instance;
  };
  const manifest = async () => JSON.parse(await fs.readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
  const report = async (result) => fs.writeFile(path.join(root, "result.json"), `${JSON.stringify({ fixtureOnly: true, realSourceAcceptanceTested: false, chromeVisible: true,
    networkForwarded: false, completedAt: new Date().toISOString(), ...result, requests }, null, 2)}\n`);
  return { root, outputDirectory, worker, manifest, report, requests };
}

smoke("visible Chrome offline extraction smoke", () => {
  it("pauses after page commit, shuts down, and resumes the same immutable checkpoint in a new browser", async () => {
    const test = await fixture("restart");
    let first, pausePromise;
    first = await test.worker((update) => {
      if (update.progress?.committedPages === 1 && update.state === "running" && !pausePromise) pausePromise = first.pause();
    });
    expect(await first.run()).toMatchObject({ state: "paused", progress: { committedPages: 1, capturedRows: 25 } });
    await pausePromise;
    const pausedManifest = await test.manifest();
    const firstPagePath = path.join(test.outputDirectory, pausedManifest.slices[0].pages[0].file);
    const before = await fs.readFile(firstPagePath, "utf8");
    const beforeCapture = JSON.parse(before).capture;
    expect(pausedManifest.slices[0].pages[0].sha256).toBe(sha(before));
    await first.close(); activeWorkers.delete(first);
    const restarted = await test.worker();
    expect(restarted.status().state).toBe("paused");
    expect(await restarted.resume()).toMatchObject({ state: "complete", progress: { complete: 1, committedPages: 2, capturedRows: 26 } });
    const after = await fs.readFile(firstPagePath, "utf8");
    expect(after).toBe(before);
    expect(JSON.parse(after).capture.capturedAt).toBe(beforeCapture.capturedAt);
    const complete = await test.manifest();
    expect(complete.slices[0].summary).toMatchObject({ status: "complete", capturedRows: 26, uniqueListingIds: 26, terminalPageReached: true });
    const csv = await fs.readFile(path.join(test.outputDirectory, complete.slices[0].csv.file), "utf8");
    expect(sha(csv)).toBe(complete.slices[0].csv.sha256);
    expect(test.requests.filter((request) => request.kind === "synthetic-document").map((request) => /list-(\d+)/.exec(request.url)[1])).toEqual(["1", "2"]);
    expect(test.requests.some((request) => request.forwarded)).toBe(false);
    await test.report({ status: "passed", scenario: "pause-shutdown-restart-resume", immutablePageSha256: sha(before), immutableCapturedAt: beforeCapture.capturedAt, progress: complete.progress });
    await restarted.close(); activeWorkers.delete(restarted);
  }, 60000);

  it("captures SPA GraphQL page 2 through real Chrome CDP after waiting for its delayed URL", async () => {
    const test = await fixture("spa");
    const worker = await test.worker();
    expect(await worker.run()).toMatchObject({ state: "complete", progress: { complete: 1, committedPages: 2, capturedRows: 26 } });
    const complete = await test.manifest();
    const second = JSON.parse(await fs.readFile(path.join(test.outputDirectory, complete.slices[0].pages[1].file), "utf8"));
    expect(second.evidence.transport).toBe("chrome-graphql-response");
    expect(second.evidence.httpStatus).toBe(200);
    expect(second.capture).toMatchObject({ sourceUrl: listingUrl(SLICE, 2), pageNumber: 2, totalResultsCount: 26, resolvedScopeVerified: true });
    expect(second.capture.listingIds).toEqual(["152180026"]);
    expect(test.requests.filter((request) => request.kind === "synthetic-document")).toHaveLength(1);
    expect(test.requests.filter((request) => request.kind === "synthetic-graphql")).toHaveLength(1);
    expect(test.requests.some((request) => request.forwarded)).toBe(false);
    await test.report({ status: "passed", scenario: "spa-graphql-response-delayed-url", transport: second.evidence.transport, progress: complete.progress });
    await worker.close(); activeWorkers.delete(worker);
  }, 60000);
});
