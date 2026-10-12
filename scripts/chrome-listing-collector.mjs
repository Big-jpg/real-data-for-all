import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ENDPOINT = "https://lexa.realestate.com.au/graphql";
const METHODS = ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"];
// A page may need a 15-second click, a 15-second response wait and time to commit.
const PAGE_CAPTURE_BUDGET_MS = 35_000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const normalise = (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function listingUrl(slice, page = 1) {
  const slug = encodeURIComponent(slice.suburb.toLowerCase()).replaceAll("%20", "+");
  return `https://www.realestate.com.au/sold/property-house-in-${slug},+wa+${slice.postcode}/list-${page}?includeSurrounding=false&maxSoldAge=6-month&activeSort=solddate`;
}

export function requestMatches(request, slice, page) {
  try {
    const body = JSON.parse(request.postData);
    const query = JSON.parse(body.variables.query);
    const expected = `${slice.suburb}, wa ${slice.postcode}`;
    return body.operationName === "soldSearchByQuery" && query.channel === "sold" && query.page === page && query.pageSize === 25 &&
      query.sortType === "sold-date-desc" && query.filters?.surroundingSuburbs === false &&
      query.filters?.maxSoldAge?.value === 6 && query.filters?.maxSoldAge?.unit === "month" &&
      query.filters?.excludeNoSalePrice === false && query.filters?.propertyTypes?.length === 1 && query.filters.propertyTypes[0] === "house" &&
      query.localities?.length === 1 && normalise(query.localities[0].searchLocation) === normalise(expected);
  } catch { return false; }
}

async function writeJson(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8" });
  await fs.rename(temporary, file);
  return { sha256: hash(content), bytes: Buffer.byteLength(content) };
}

/** Parse only the structured response shipped in an observed DOM script; never execute the script. */
export async function readBootstrapResponse(tab) {
  const projected = await tab.playwright.evaluate(() => {
    const prefix = "window.ArgonautExchange=";
    const script = Array.from(document.scripts).find((item) => item.textContent.startsWith(prefix));
    if (!script) return null;
    const exchange = JSON.parse(script.textContent.slice(prefix.length).replace(/;\s*$/, ""));
    const component = exchange["resi-property_listing-experience-web"];
    if (!component?.urqlClientCache) return null;
    const entries = Object.values(JSON.parse(component.urqlClientCache));
    const payloads = entries.map((entry) => typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data).filter((entry) => entry?.soldSearch);
    if (payloads.length !== 1) return null;
    const search = payloads[0].soldSearch;
    // Retain listing fields, scope and pagination; agent contacts and tracking never cross the bridge.
    const selectListing = (listing) => ({
      id: listing.id, address: listing.address, price: listing.price, dateSold: listing.dateSold,
      propertyType: listing.propertyType, generalFeatures: listing.generalFeatures,
      propertySizes: { land: listing.propertySizes?.land }, _links: { canonical: listing._links?.canonical },
    });
    // Cross the browser bridge as text so deeply nested fields are not depth-truncated.
    return JSON.stringify({ data: { soldSearch: {
      resolvedQuery: { localities: search.resolvedQuery?.localities, metadata: { savedSearchQuery: search.resolvedQuery?.metadata?.savedSearchQuery } },
      results: { totalResultsCount: search.results?.totalResultsCount, pagination: search.results?.pagination,
        exact: search.results?.exact == null ? search.results?.exact : { items: search.results.exact.items?.map((item) => ({ listing: selectListing(item.listing) })) },
        surrounding: search.results?.surrounding == null ? null : { items: search.results.surrounding.items?.map((item) => ({ listing: selectListing(item.listing) })) } },
    } } });
  });
  return projected === null ? null : JSON.parse(projected);
}

function bootstrapMatches(payload, slice, page, url) {
  if (url !== listingUrl(slice, page)) return false;
  try {
    const query = JSON.parse(payload.data.soldSearch.resolvedQuery.metadata.savedSearchQuery);
    return query.channel === "sold" && query.page === page && query.pageSize === 25 && query.filters?.surroundingSuburbs === false &&
      query.filters?.propertyTypes?.length === 1 && query.filters.propertyTypes[0] === "house" &&
      query.filters?.maxSoldAge?.value === 6 && query.filters?.maxSoldAge?.unit === "month" &&
      query.filters?.excludeNoSalePrice === false;
  } catch { return false; }
}

function safeResolved(payload) {
  return payload.data?.soldSearch?.resolvedQuery?.localities?.map((item) => ({ name: item.name, seoName: item.seoName, display: item.display, state: item.state, urlValue: item.urlValue, precision: item.precision }));
}

export async function createChromeCollector({ tab, cdp, core, planPath, outputDirectory, delayMs = 5000, maxPages = 100 }) {
  const root = path.resolve(outputDirectory);
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  if (!plan.slices?.length || new Set(plan.slices.map((slice) => slice.name)).size !== plan.slices.length) throw new Error("Plan needs uniquely named slices");
  for (const slice of plan.slices) {
    if (slice.state !== "WA" || slice.propertyType !== "house" || slice.includeSurrounding !== false || slice.maxSoldAge !== "6-month" || !/^\d{4}$/.test(slice.postcode) || !/^[a-z0-9'-]+$/.test(slice.name)) throw new Error(`Unsupported plan scope: ${slice.name}`);
  }
  await fs.mkdir(root, { recursive: true });
  const manifestPath = path.join(root, "manifest.json");
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const planHash = hash(JSON.stringify(plan));
  if (manifest && manifest.planSha256 !== planHash) throw new Error("Existing dated capture has a different plan; use another run directory");
  if (!manifest) {
    manifest = { schemaVersion: 1, runId: plan.runId, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "running", planSha256: planHash,
      source: { endpoint: ENDPOINT, transport: "Normal Chrome navigation; structured initial response and matching GraphQL responses", cookiesOrChallengeHeadersSaved: false, fullRawResponsesSaved: false },
      settings: { concurrency: 1, delayMs, maxPages, comparisonCutoff: "2026-06-01" },
      baseline: "../2026-07-baseline/manifest.json", slices: plan.slices.map((slice) => ({ ...slice, status: "pending", pages: [], summary: null })) };
    await writeJson(manifestPath, manifest);
    await writeJson(path.join(root, "plan.json"), plan);
  }
  let current = null;
  let lastNavigationAt = 0;
  await cdp.send("Network.enable");

  async function persist() {
    manifest.updatedAt = new Date().toISOString();
    const counts = Object.fromEntries(["pending", "running", "complete", "partial", "failed", "capped"].map((status) => [status, manifest.slices.filter((slice) => slice.status === status).length]));
    manifest.progress = { ...counts, attempted: manifest.slices.filter((slice) => slice.status !== "pending").length,
      committedPages: manifest.slices.reduce((sum, slice) => sum + slice.pages.length, 0),
      capturedRows: manifest.slices.reduce((sum, slice) => sum + (slice.summary?.capturedRows ?? 0), 0) };
    await writeJson(manifestPath, manifest);
  }

  async function loadPages(slice) {
    const pages = [];
    for (const committed of slice.pages) {
      const content = await fs.readFile(path.join(root, committed.file), "utf8");
      if (hash(content) !== committed.sha256) throw new Error(`Committed page checksum failed: ${committed.file}`);
      const saved = JSON.parse(content);
      const capture = saved.capture;
      pages.push(core.adaptProjectedPage({ totalResultsCount: capture.totalResultsCount, pagination: capture.pagination,
        rows: capture.listings.map((listing) => core.LISTING_PROJECTION_COLUMNS.map((column) => listing[column])),
        resolvedLocalities: saved.evidence.resolvedLocalities, surroundingCount: 0,
        sourceWarnings: capture.sourceWarnings,
      }, core.LISTING_PROJECTION_COLUMNS, { suburb: slice.suburb, postcode: slice.postcode, pageNumber: committed.pageNumber,
        capturedAt: capture.capturedAt, sourceUrl: capture.sourceUrl, pageSize: capture.pageSize }));
    }
    return pages;
  }

  async function eventsAfter(cursor) {
    const collected = [];
    let chunk;
    do {
      chunk = await cdp.readEvents({ afterSequence: cursor, limit: 1000, methods: METHODS });
      if (chunk.truncated) throw new Error("Chrome network events were evicted before capture");
      collected.push(...chunk.events); cursor = chunk.cursor;
    } while (chunk.hasMore);
    return { events: collected, cursor };
  }

  async function capturePage(slice, page, cold) {
    const wait = Math.max(0, delayMs - (Date.now() - lastNavigationAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const cursor = (await cdp.readEvents({ methods: METHODS })).cursor;
    const target = listingUrl(slice, page);
    lastNavigationAt = Date.now();
    if (cold || page === 1) {
      if (await tab.url() === target) await tab.reload(); else await tab.goto(target);
    } else {
      await tab.playwright.getByRole("link", { name: "Go to next page", exact: true }).click({ timeoutMs: 15000 });
    }
    await tab.getAXState({ emit: false });
    const url = await tab.url();
    let observed = await eventsAfter(cursor);
    const events = observed.events;
    const matchingRequest = () => events.find((event) => event.method === "Network.requestWillBeSent" && event.params?.request?.url === ENDPOINT && requestMatches(event.params.request, slice, page));
    const matchingDocument = () => events.find((event) => event.method === "Network.responseReceived" && event.params?.type === "Document" && event.params.response?.url === url);
    const bodyFinished = (id) => events.some((event) => event.method === "Network.loadingFinished" && event.params?.requestId === id);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const candidate = matchingRequest();
      const response = candidate ? events.find((event) => event.method === "Network.responseReceived" && event.params?.requestId === candidate.params.requestId) : matchingDocument();
      if (response && ([403, 429].includes(response.params.response.status) || bodyFinished(response.params.requestId))) break;
      const failed = candidate && events.find((event) => event.method === "Network.loadingFailed" && event.params?.requestId === candidate.params.requestId);
      if (failed) throw new Error("Chrome listing request failed before its response body completed");
      const chunk = await cdp.readEvents({ afterSequence: observed.cursor, limit: 1000, methods: METHODS, timeoutMs: 1000 });
      if (chunk.truncated) throw new Error("Chrome network events were evicted before capture");
      events.push(...chunk.events); observed = { cursor: chunk.cursor };
      if (chunk.hasMore) {
        const more = await eventsAfter(chunk.cursor); events.push(...more.events); observed = more;
      }
    }
    const request = matchingRequest();
    let payload, evidence;
    if (request) {
      const response = events.find((event) => event.method === "Network.responseReceived" && event.params?.requestId === request.params.requestId)?.params.response;
      if (response?.status === 429 || response?.status === 403) throw new Error(`SOURCE_CHALLENGE: listing response ${response.status}`);
      if (response?.status !== 200 || !response.mimeType.includes("json")) throw new Error("Matching listing response did not return HTTP 200 JSON");
      if (!bodyFinished(request.params.requestId)) throw new Error("Matching listing response body did not finish before timeout");
      const body = await cdp.send("Network.getResponseBody", { requestId: request.params.requestId });
      payload = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
      const requestBody = JSON.parse(request.params.request.postData);
      evidence = { transport: "chrome-graphql-response", httpStatus: response.status, capturedAt: new Date(request.params.wallTime * 1000).toISOString(),
        request: { endpoint: ENDPOINT, operationName: requestBody.operationName, query: JSON.parse(requestBody.variables.query), persistedQuery: requestBody.extensions?.persistedQuery ?? null } };
    } else {
      const documentEvent = matchingDocument();
      const documentResponse = documentEvent?.params.response;
      if (documentResponse?.status === 429 || documentResponse?.status === 403) throw new Error(`SOURCE_CHALLENGE: document response ${documentResponse.status}`);
      payload = await readBootstrapResponse(tab);
      if (!payload) {
        const visible = await tab.playwright.evaluate(() => document.body.innerText.slice(0, 1500));
        if (/verify (?:that )?you are human|unusual traffic|pardon our interruption|access denied|captcha|please enable cookies/i.test(visible)) throw new Error("SOURCE_CHALLENGE: Chrome displays a verification page");
      }
      if (!payload || !bootstrapMatches(payload, slice, page, url)) throw new Error("Chrome page has no matching structured listing response; scope may be unresolved or redirected");
      if (documentResponse?.status !== 200) throw new Error("Initial structured response lacks HTTP 200 document evidence");
      if (!bodyFinished(documentEvent.params.requestId)) throw new Error("Initial document response body did not finish before timeout");
      const docRequest = events.find((event) => event.method === "Network.requestWillBeSent" && event.params?.requestId === documentEvent.params.requestId);
      evidence = { transport: "chrome-bootstrap-response", httpStatus: documentResponse.status, capturedAt: docRequest ? new Date(docRequest.params.wallTime * 1000).toISOString() : new Date().toISOString(),
        request: { sourceUrl: url, scopeEvidence: "Verified URL parameters and response savedSearchQuery", persistedQuery: null } };
    }
    const capture = core.adaptListingPage(payload, { suburb: slice.suburb, postcode: slice.postcode, pageNumber: page, capturedAt: evidence.capturedAt, sourceUrl: url, pageSize: 25 });
    evidence.resolvedLocalities = safeResolved(payload);
    return { capture, evidence };
  }

  async function completeSlice(slice, pages, failure) {
    slice.summary = core.validateSliceCapture(pages, { suburb: slice.suburb, postcode: slice.postcode, soldDateFrom: slice.soldDateFrom, maxPages, failure });
    slice.status = slice.summary.status;
    if (failure) slice.failure = failure;
    slice.finishedAt = new Date().toISOString();
    const csv = core.serialiseCaptureCsv(pages.flatMap((item) => item.rows));
    const file = `source/rea-sold-${slice.suburb.replace(/[^A-Z0-9-]/gi, "-")}-WA-_${slice.postcode}_-${plan.runId}.csv`;
    await fs.mkdir(path.join(root, "source"), { recursive: true });
    await fs.writeFile(path.join(root, file), csv);
    slice.csv = { file, sha256: hash(csv), bytes: Buffer.byteLength(csv), rows: slice.summary.capturedRows };
    current = null;
    await persist();
  }

  async function runBatch({ maxMs = 45000, maxCommittedPages = 10 } = {}) {
    const deadline = Date.now() + maxMs;
    let committed = 0;
    const finished = [];
    while (Date.now() < deadline && committed < maxCommittedPages) {
      if (!current) {
        const slice = manifest.slices.find((item) => item.status === "pending" || item.status === "running");
        if (!slice) break;
        current = { slice, pages: await loadPages(slice), cold: true };
        slice.status = "running"; await persist();
      }
      const { slice, pages } = current;
      const page = pages.length + 1;
      try {
        // A restart may follow the terminal page commit but precede CSV finalization.
        if (pages.length && !pages.at(-1).pagination.moreResultsAvailable) {
          await completeSlice(slice, pages);
          finished.push({ name: slice.name, status: slice.status, rows: slice.summary.capturedRows });
          continue;
        }
        if (pages.length >= maxPages) { await completeSlice(slice, pages); finished.push({ name: slice.name, status: slice.status }); continue; }
        const pendingDelay = Math.max(0, delayMs - (Date.now() - lastNavigationAt));
        if (deadline - Date.now() < PAGE_CAPTURE_BUDGET_MS + pendingDelay) break;
        const response = await capturePage(slice, page, current.cold);
        current.cold = false;
        const file = `pages/${slice.name}/page-${String(page).padStart(3, "0")}.json`;
        // A page is immutable once committed. Persist its data before advancing the manifest.
        const integrity = await writeJson(path.join(root, file), response);
        pages.push(response.capture);
        slice.pages.push({ pageNumber: page, file, ...integrity, capturedAt: response.capture.capturedAt, rows: response.capture.rows.length });
        slice.summary = core.validateSliceCapture(pages, { suburb: slice.suburb, postcode: slice.postcode, soldDateFrom: slice.soldDateFrom, maxPages });
        committed++; await persist();
        if (!response.capture.pagination.moreResultsAvailable) { await completeSlice(slice, pages); finished.push({ name: slice.name, status: slice.status, rows: slice.summary.capturedRows }); }
      } catch (error) {
        const failure = String(error.message ?? error);
        await completeSlice(slice, pages, failure);
        finished.push({ name: slice.name, status: slice.status, failure });
        if (failure.startsWith("SOURCE_CHALLENGE:")) { manifest.status = "source-challenge"; await persist(); return { stopped: true, reason: failure, finished, progress: manifest.progress }; }
      }
    }
    const remaining = manifest.slices.filter((slice) => slice.status === "pending" || slice.status === "running").length;
    manifest.status = remaining ? "running" : manifest.slices.every((slice) => slice.status === "complete") ? "complete" : "finished-with-exceptions";
    if (!remaining) manifest.finishedAt = new Date().toISOString();
    await persist();
    return { done: remaining === 0, committedThisBatch: committed, finished, progress: manifest.progress, active: current?.slice.name ?? null };
  }
  async function retryExceptions(names) {
    if (current) throw new Error("Finish the active slice before resetting exceptions");
    for (const slice of manifest.slices) {
      if (names.includes(slice.name) && ["failed", "partial", "capped"].includes(slice.status)) {
        slice.status = "pending"; delete slice.failure; delete slice.finishedAt;
      }
    }
    manifest.status = "running"; await persist();
  }
  return { runBatch, retryExceptions, manifestPath, status: () => ({ status: manifest.status, progress: manifest.progress, active: current?.slice.name ?? null }), stop: async () => { await persist(); await cdp.send("Network.disable"); } };
}
