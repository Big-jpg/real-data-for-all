import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

// Local frontend smoke with synthetic API fixtures; never queries the serving database.
// Start the dev server, then run: node scripts/check-suburb-comparison.mjs http://127.0.0.1:3012
const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3012");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname), "Use a local development server");
const output = path.resolve("deliverables/suburb-comparison");
await fs.mkdir(output, { recursive: true });
const suburbs = [
  { suburb_key: "hocking-6065", suburb: "HOCKING", canonical_postcode: "6065", sale_count: 1200 },
  { suburb_key: "alkimos-6038", suburb: "ALKIMOS", canonical_postcode: "6038", sale_count: 800 },
  { suburb_key: "unpriced-6000", suburb: "UNPRICED", canonical_postcode: "6000", sale_count: 30 },
  { suburb_key: "emptyvale-6001", suburb: "EMPTYVALE", canonical_postcode: "6001", sale_count: 0 },
];
const requests = [];
const failures = [];
let failComparison = false;
let delayComparison = false;
let delayedRequest;
let releaseDelayed;
let delayStarted;

function rowsFor(query) {
  const suburb = suburbs.find(item => item.suburb_key === query.get("suburb_key"));
  assert.ok(suburb, "A known suburb key must be requested");
  if (suburb.suburb_key === "emptyvale-6001") return [];
  const cursor = new Date(`${query.get("from")}T00:00:00Z`);
  const end = new Date(`${query.get("to")}T00:00:00Z`);
  const result = [];
  let index = 0;
  while (cursor <= end) {
    const comparison = suburb.suburb_key === "alkimos-6038";
    const missingMonth = comparison ? index === 3 : index === 2;
    if (!missingMonth) {
      const unpriced = suburb.suburb_key === "unpriced-6000" || (comparison && index === 4);
      const median = unpriced ? null : (comparison ? 2_000_000 : 1_000_000) + index * 10_000;
      result.push({ suburb: suburb.suburb, postcode: suburb.canonical_postcode,
        sale_month: cursor.toISOString().slice(0, 10), sale_count: (comparison ? 20 : 10) + index % 4,
        median_price_aud: median, average_price_aud: median == null ? null : median + 25_000,
        minimum_price_aud: median == null ? null : median - 100_000,
        maximum_price_aud: median == null ? null : median + 100_000 });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    index++;
  }
  return result;
}

function insightsFor(query) {
  const rows = rowsFor(query);
  const count = rows.reduce((total, row) => total + row.sale_count, 0);
  const priced = rows.filter(row => row.median_price_aud != null);
  const median = priced.at(-1)?.median_price_aud ?? null;
  const priorFrom = new Date(`${query.get("from")}T00:00:00Z`);
  priorFrom.setUTCMonth(priorFrom.getUTCMonth() - Number(query.get("months")));
  const priorTo = new Date(`${query.get("from")}T00:00:00Z`);
  priorTo.setUTCDate(priorTo.getUTCDate() - 1);
  return {
    summary: { sale_count: count, priced_sales: priced.reduce((total, row) => total + row.sale_count, 0),
      median_price_aud: median, average_price_aud: median == null ? null : median + 25_000,
      land_sample: 0, land_price_correlation: null, median_land_size_sqm: null },
    rolling: rows.length ? { current_from: query.get("from"), current_to: query.get("to"),
      prior_from: priorFrom.toISOString().slice(0, 10), prior_to: priorTo.toISOString().slice(0, 10),
      current_sale_count: count, current_priced_sales: priced.length,
      current_median_price_aud: median, prior_sale_count: Math.round(count * 0.8),
      prior_priced_sales: priced.length, prior_median_price_aud: median == null ? null : median - 50_000 } : null,
    bedrooms: rows.length ? [3, 4].filter(value => !query.has("bedrooms") || String(value) === query.get("bedrooms"))
      .map(value => ({ segment_label: value, sale_count: query.get("suburb_key") === "alkimos-6038" ? value * 20 : value * 10,
        median_price_aud: median })) : [],
  };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", error => failures.push(error.message));
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.origin !== baseUrl.origin) return route.abort("blockedbyclient");
  if (!url.pathname.startsWith("/api/analytics/")) return route.continue();
  const query = url.searchParams;
  requests.push({ endpoint: url.pathname, filters: Object.fromEntries(query) });
  if (url.pathname.endsWith("/suburbs")) return route.fulfill({ json: { data: suburbs } });
  if (delayComparison && query.get("suburb_key") === "alkimos-6038") {
    delayStarted?.();
    await delayedRequest;
  }
  if (failComparison && query.get("suburb_key") === "alkimos-6038") return route.fulfill({ status: 503, json: { error: "Synthetic unavailable fixture" } });
  return route.fulfill({ json: url.pathname.endsWith("/suburb-sales") ? { data: rowsFor(query) } : insightsFor(query) });
});

async function ready() {
  await page.locator(".dashboard-snapshot[aria-busy=false]").waitFor();
  assert.equal(await page.locator(".service-error[role=alert]").count(), 0);
}

async function compare(name) {
  await page.locator('.comparison-selection summary[aria-label^="Compare:"]').click();
  const input = page.getByRole("searchbox", { name: "Search comparison suburb or postcode", exact: true });
  await input.fill(name);
  await page.locator(".comparison-selection .picker-results").getByRole("button", { name: new RegExp(`^${name} `, "i") }).click();
}

async function chartGeometry(selector) {
  return page.locator(`${selector} svg`).evaluateAll(svgs => svgs.flatMap(svg => Array.from(svg.querySelectorAll("path, rect, circle"))
    .map(node => ({ tag: node.tagName, mark: node.closest("[data-mark-id]")?.getAttribute("data-mark-id"),
      fill: node.getAttribute("fill"), stroke: node.getAttribute("stroke"), d: node.getAttribute("d"),
      x: node.getAttribute("x"), y: node.getAttribute("y"), width: node.getAttribute("width"), height: node.getAttribute("height"),
      cx: node.getAttribute("cx"), cy: node.getAttribute("cy"), dash: node.getAttribute("stroke-dasharray"),
      bounds: { x: node.getBBox().x, y: node.getBBox().y, width: node.getBBox().width, height: node.getBBox().height } }))));
}

try {
  await page.goto(baseUrl.href);
  await ready();
  assert.match(await page.locator("h1").innerText(), /^Hocking/);
  assert.equal(await page.locator(".suburb-metrics").count(), 1);
  assert.equal(await page.locator(".volume-card svg").count(), 1);
  const singleGeometry = await chartGeometry(".volume-card");

  await page.locator('summary[aria-label="Compare: Add suburb"]').click();
  assert.equal(await page.locator(".comparison-selection .picker-results").getByRole("button", { name: /Hocking/ }).count(), 0);
  await page.getByRole("searchbox", { name: "Search comparison suburb or postcode", exact: true }).fill("Alkimos");
  await page.locator(".comparison-selection .picker-results").getByRole("button", { name: "Alkimos 6038", exact: true }).click();
  await ready();
  assert.match(await page.locator("h1").innerText(), /Hocking vs Alkimos/);
  assert.equal(await page.locator(".suburb-metrics").count(), 2);
  assert.equal(await page.locator(".month-readout").count(), 2);
  await page.getByRole("checkbox", { name: "Average price", exact: true }).check();
  const pairedGeometry = await chartGeometry(".volume-card");
  const priceGeometry = await chartGeometry(".price-card");
  const periodGeometry = await chartGeometry(".comparison-metric");
  const bedroomGeometry = await chartGeometry(".bedroom-card");
  assert.ok(pairedGeometry.length > singleGeometry.length, "Comparison adds chart marks");
  assert.ok(priceGeometry.some(node => node.stroke === "var(--secondary)"), "Comparison has its own price line");
  for (const [geometry, barsPerSuburb] of [[pairedGeometry, 12], [bedroomGeometry, 2]]) {
    const primary = geometry.filter(node => node.tag === "path" && node.fill === "var(--accent)");
    const comparison = geometry.filter(node => node.tag === "path" && node.fill === "var(--secondary)");
    assert.equal(primary.length, barsPerSuburb);
    assert.equal(comparison.length, barsPerSuburb);
    assert.ok(primary.every((node, index) => node.bounds.x + node.bounds.width <= comparison[index].bounds.x), "Suburb bars sit beside each other");
  }
  assert.equal(periodGeometry.filter(node => node.tag === "path" && ["var(--accent)", "var(--secondary)"].includes(node.fill)).length, 8);
  assert.ok(priceGeometry.some(node => node.stroke === "var(--accent)" && node.dash), "Primary average is dashed");
  assert.ok(priceGeometry.some(node => node.stroke === "var(--secondary)" && node.dash), "Comparison average is dashed");
  await page.locator(".data-table summary").click();
  assert.equal(await page.locator(".data-table tbody tr").count(), 24);
  assert.equal(await page.locator(".data-table tbody tr").filter({ hasText: "Alkimos" }).count(), 12);
  assert.ok((await page.locator(".data-table tbody").innerText()).includes("$2,110,000"));
  const firstMonth = requests.find(request => request.filters.suburb_key === "hocking-6065").filters.from;
  const firstLabel = new Date(`${firstMonth}T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
  await page.locator(".data-table tbody tr").filter({ hasText: "Hocking" }).getByRole("button", { name: firstLabel, exact: true }).click();
  assert.match(await page.locator(".chart-controls").innerText(), /Month pinned/);
  assert.ok((await page.locator(".month-readout").filter({ hasText: "Hocking" }).innerText()).includes("$1,000,000"));
  assert.ok((await page.locator(".month-readout").filter({ hasText: "Alkimos" }).innerText()).includes("$2,000,000"));
  const firstPoint = priceGeometry.find(node => node.tag === "circle" && node.fill === "var(--accent)");
  // Hover the chart surface: the line itself legitimately overlays its point.
  await page.locator(".price-card svg").hover({ position: { x: Number(firstPoint.cx), y: Number(firstPoint.cy) } });
  await page.locator(".market-tooltip").filter({ hasText: "Hocking · Median" }).waitFor();
  const tooltipText = await page.locator(".market-tooltip").filter({ hasText: "Hocking · Median" }).innerText();
  assert.ok(tooltipText.includes("$1,000,000") && tooltipText.includes("Alkimos · Median") && tooltipText.includes("$2,000,000"));
  await page.locator("h1").hover();
  await page.locator(".month-readout").filter({ hasText: "Hocking" }).getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.locator(".export-menu summary").click();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const csv = await csvDownload;
  const csvPath = path.join(output, "synthetic-comparison.csv");
  await csv.saveAs(csvPath);
  const csvText = await fs.readFile(csvPath, "utf8");
  assert.ok(csvText.includes('"HOCKING","6065"') && csvText.includes('"ALKIMOS","6038"'));
  assert.match(csv.suggestedFilename(), /hocking-6065-vs-alkimos-6038/);
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG", exact: true }).click();
  const png = await pngDownload;
  const pngPath = path.join(output, "synthetic-comparison.png");
  await png.saveAs(pngPath);
  assert.match(png.suggestedFilename(), /hocking-6065-vs-alkimos-6038/);
  assert.deepEqual((await fs.readFile(pngPath)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await page.locator(".export-menu summary").click();
  await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator(".comparison-selection").isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile dashboard fits the viewport");
  await page.screenshot({ path: path.join(output, "mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });

  const sharedStart = requests.length;
  await page.getByRole("button", { name: "6m", exact: true }).click();
  await ready();
  await page.locator(".toolbar-filters").getByRole("button", { name: "4", exact: true }).click();
  await ready();
  const shared = requests.slice(sharedStart).filter(request => request.filters.bedrooms === "4");
  assert.equal(shared.length, 4);
  assert.equal(new Set(shared.map(request => JSON.stringify({ from: request.filters.from, to: request.filters.to,
    months: request.filters.months, bedrooms: request.filters.bedrooms }))).size, 1);
  assert.ok(shared.every(request => request.filters.months === "6"));
  assert.equal(await page.locator(".data-table tbody tr").count(), 12);

  await page.getByRole("button", { name: "Remove comparison suburb", exact: true }).click();
  await ready();
  assert.equal(await page.locator(".suburb-metrics").count(), 1);
  assert.equal(await page.locator(".data-table tbody tr").count(), 6);

  delayComparison = true;
  delayedRequest = new Promise(resolve => { releaseDelayed = resolve; });
  const started = new Promise(resolve => { delayStarted = resolve; });
  await compare("Alkimos");
  await started;
  await page.getByRole("button", { name: "Remove comparison suburb", exact: true }).click();
  await ready();
  delayComparison = false;
  releaseDelayed();
  await page.waitForFunction(() => document.querySelector(".dashboard-snapshot")?.getAttribute("aria-busy") === "false");
  assert.doesNotMatch(await page.locator("h1").innerText(), /Alkimos/);
  assert.equal(await page.locator(".suburb-metrics").count(), 1);

  failComparison = true;
  await compare("Alkimos");
  await page.locator(".service-error[role=alert]").waitFor();
  assert.match(await page.locator(".service-error[role=alert]").innerText(), /Alkimos analytics are temporarily unavailable/);
  await page.locator(".export-menu summary").click();
  assert.ok(await page.getByRole("button", { name: "Download CSV", exact: true }).isDisabled());
  assert.ok(await page.getByRole("button", { name: "Download PNG", exact: true }).isDisabled());
  await page.locator(".export-menu summary").click();
  failComparison = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await ready();
  assert.equal(await page.locator(".suburb-metrics").count(), 2);

  await compare("Unpriced");
  await ready();
  assert.ok((await page.locator(".month-readout").filter({ hasText: "Unpriced" }).innerText()).includes("—"));
  await compare("Emptyvale");
  await ready();
  assert.ok((await page.locator(".month-readout").filter({ hasText: "Emptyvale" }).innerText()).includes("No recorded observations"));
  assert.equal(await page.locator(".data-table tbody tr").count(), 12);
  await page.locator('summary[aria-label="Suburb: Hocking"]').click();
  await page.getByRole("searchbox", { name: "Search suburb or postcode", exact: true }).fill("Unpriced");
  await page.locator(".suburb-selection > .suburb-picker .picker-results").getByRole("button", { name: "Unpriced 6000", exact: true }).click();
  await ready();
  assert.equal(await page.locator(".price-card svg").count(), 0);
  assert.match(await page.locator(".price-card .chart-empty").innerText(), /No disclosed prices/);
  assert.deepEqual(failures, []);
  const report = { fixtureOnly: true, servingDatabaseQueried: false, status: "passed", browser: browser.version(),
    scenarios: ["single suburb", "comparison excludes primary", "two series with grouped geometry", "average lines", "aligned monthly table", "selected month and tooltip", "CSV identities", "PNG export",
      "desktop and mobile layout", "shared period and bedroom filters", "comparison removal", "delayed response cancellation",
      "named service error and Retry", "undisclosed prices", "empty comparison", "no disclosed prices"],
    chartGeometry: { singleVolume: singleGeometry, pairedVolume: pairedGeometry, price: priceGeometry,
      period: periodGeometry, bedrooms: bedroomGeometry }, requests, pageErrors: failures };
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios, output }));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, "failure.json"), `${JSON.stringify({ message: error.message, pageErrors: failures,
    requests, visibleText: (await page.locator("body").innerText()).slice(0, 10000) }, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
}
