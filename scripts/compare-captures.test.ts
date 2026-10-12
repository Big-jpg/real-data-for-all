import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SOURCE_COLUMNS, type SourceRow } from "../src/lib/source";
import { adaptProjectedPage, LISTING_PROJECTION_COLUMNS, serialiseCaptureCsv } from "../src/lib/rea-listing-capture";
import { buildComparison, changedFields, compareCaptureDirectories, latestByListing, reportedHouseMetrics, type ComparisonObservation, type ComparisonScope } from "./compare-captures";

const values = (overrides: Partial<SourceRow> = {}): SourceRow => ({
  ...Object.fromEntries(SOURCE_COLUMNS.map((column) => [column, ""])),
  sourceUrl: "https://www.realestate.com.au/sold/property-house-in-hocking,+wa+6065/list-1",
  pageNumber: "1", ordinalOnPage: "1", price: "$800,000", priceValue: "800000", address: "1 Example Street, Hocking",
  detailPath: "/sold/property-house-wa-hocking-123", detailUrl: "https://www.realestate.com.au/sold/property-house-wa-hocking-123",
  bedrooms: "3", bathrooms: "2", carSpaces: "2", landSize: "500m2", landSizeSqm: "500", propertyType: "House",
  soldDate: "1 Jun 2026", soldDateISO: "2026-06-01", scrapedAt: "2026-07-06T17:35:58.691Z", ...overrides,
} as SourceRow);
const observation = (id: string, overrides: Partial<SourceRow> = {}): ComparisonObservation => ({
  listingId: id, values: values({ detailPath: `/sold/property-house-wa-hocking-${id}`, detailUrl: `https://www.realestate.com.au/sold/property-house-wa-hocking-${id}`, ...overrides }),
  scopeKey: "HOCKING|WA|6065", file: "source/hocking.csv",
});
const scope = (currentRows: ComparisonObservation[], baselineRows: ComparisonObservation[], overrides: Partial<ComparisonScope> = {}): ComparisonScope => ({
  name: "hocking-6065", suburb: "Hocking", postcode: "6065", status: "complete", baselineExactOnly: true,
  baselineCaptureCutoff: "2026-07-07", currentCapturedRows: currentRows.length, currentRows, baselineRows, excludedHistoricalSurroundingRows: 0, ...overrides,
});
const options = { soldDateFrom: "2026-06-01", baselineGlobalCaptureCutoff: "2026-07-10" };

describe("dated listing capture comparison", () => {
  it("deduplicates query overlap and compares the latest correction rather than the first July observation", () => {
    const first = observation("123", { price: "$800,000", scrapedAt: "2026-07-02T12:00:00.000Z" });
    const corrected = observation("123", { price: "$850,000", priceValue: "850000", scrapedAt: "2026-07-08T12:00:00.000Z" });
    const october = observation("123", { price: "$850,000", priceValue: "850000", scrapedAt: "2026-10-11T17:00:00.000Z", sourceUrl: "https://www.realestate.com.au/sold/list-2", pageNumber: "2", ordinalOnPage: "7" });
    expect(latestByListing([corrected, first]).get("123")).toBe(corrected);
    const result = buildComparison([scope([october], [first, corrected])], [first, corrected], options);
    expect(result.counts.reobservedListingIds).toBe(1);
    expect(result.counts.changedReobservedListingIds).toBe(0);
    expect(result.alignedWindow.baseline.reportedHouseListingCount).toBe(1);
  });

  it("retains corrections to dates and disclosed prices without classifying capture metadata as changed data", () => {
    const before = values({ price: "Contact agent", priceValue: "", soldDateISO: "2026-06-02" });
    const after = values({ price: "$900,000", priceValue: "900000", soldDateISO: "2026-06-01", scrapedAt: "2026-10-11T17:00:00.000Z", pageNumber: "3", landSize: "500 m²" });
    expect(changedFields(before, after).map((change) => change.field)).toEqual(["priceDisplay", "disclosedPriceValue", "soldDateISO"]);
  });

  it("separates delayed disclosure from newly occurring sales and uses each suburb's July capture day", () => {
    const delayed = observation("100", { soldDateISO: "2026-06-29", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const betweenJulyCaptures = observation("101", { soldDateISO: "2026-07-09", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const laterSale = observation("102", { soldDateISO: "2026-09-13", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const baselineHouse = observation("999", { soldDateISO: "2026-06-01" });
    const result = buildComparison([scope([delayed, betweenJulyCaptures, laterSale], [baselineHouse])], [baselineHouse], options);
    expect(result.counts.newlyObservedListingIds).toBe(3);
    expect(result.counts.reportedSalesDatedAfterGlobalJulyCaptureDay).toBe(1);
    expect(result.counts.reportedSalesDatedAfterScopeJulyCaptureDay).toBe(2);
    expect(result.counts.newlyObservedWithSaleDateOnOrBeforeGlobalJulyCaptureDay).toBe(2);
  });

  it("excludes incomplete scopes from headline metrics and limits absence checks to the aligned overlap window", () => {
    const historicalMay = observation("201", { soldDateISO: "2026-05-01" });
    const historicalJune = observation("202", { soldDateISO: "2026-06-01" });
    const complete = scope([], [historicalMay, historicalJune]);
    const unfinishedRows = [observation("301", { soldDateISO: "2026-09-01" })];
    const partial = scope(unfinishedRows, [], { name: "unfinished", suburb: "Yokine", postcode: "6060", status: "partial" });
    const result = buildComparison([complete, partial], [historicalMay, historicalJune], options);
    expect(result.counts.completeSliceUniqueListingIds).toBe(0);
    expect(result.counts.incompleteSlices).toBe(1);
    expect(result.slices[1].currentCapturedRows).toBe(1);
    expect(result.slices[1].includedInHeadlines).toBe(false);
    expect(result.absentFromCurrentWindow.map((row) => row.listingId)).toEqual(["202"]);
    expect(result.absentFromCurrentWindow[0].comparison).toBe("absent-from-current-window");
  });

  it("excludes historical price range midpoints, preserves disclosed-price denominators, and retains April context separately", () => {
    const june = [observation("401", { price: "$800,000 - $900,000", priceValue: "850000" }), observation("402", { price: "$1,000,000", priceValue: "1000000" }), observation("403", { price: "Contact agent", priceValue: "" })];
    expect(reportedHouseMetrics(june)).toEqual({ reportedHouseListingCount: 3, disclosedPriceCount: 1, undisclosedOrNonExactPriceCount: 2, disclosedPriceMedian: 1000000 });
    const april = observation("404", { soldDateISO: "2026-04-19", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const result = buildComparison([scope([...june, april], june)], june, options);
    expect(result.alignedWindow.current.reportedHouseListingCount).toBe(3);
    expect(result.counts.completeSliceUniqueListingIds).toBe(4);
    expect(result.counts.newlyObservedListingIds).toBe(1);
    expect(result.counts.identityCountWindow).toContain("Full six-month capture");
    expect(result.alignedWindow.identityCounts).toMatchObject({ uniqueListingIds: 3, newlyObservedListingIds: 0, reobservedListingIds: 3 });
    expect(result.earlierSixMonthContext.reportedHouseListingCount).toBe(1);
    expect(result.monthly.map((row) => row.month)).toEqual(["2026-06"]);
    expect(result.monthly[0].current.disclosedPriceCount).toBe(1);
  });

  it("preserves Other results and classification corrections while excluding their prices and counts from House headlines", () => {
    const previousHouse = observation("500", { propertyType: "House" });
    const reclassified = observation("500", { propertyType: "Other", price: "$100,000,000", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const newOther = observation("501", { propertyType: "Other", price: "$200,000,000", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const house = observation("502", { propertyType: "House", price: "$800,000", scrapedAt: "2026-10-11T17:00:00.000Z" });
    const result = buildComparison([scope([reclassified, newOther, house], [previousHouse])], [previousHouse], options);
    expect(result.counts.completeSliceUniqueListingIds).toBe(1);
    expect(result.counts.newlyObservedListingIds).toBe(1);
    expect(result.counts.changedReobservedListingIds).toBe(0);
    expect(result.sourceCoverage).toMatchObject({ allActualTypesUniqueListingIds: 3, nonHouseUniqueListingIds: 2, actualPropertyTypeCounts: { House: 1, Other: 2 } });
    expect(result.alignedWindow.current).toMatchObject({ reportedHouseListingCount: 1, disclosedPriceCount: 1, disclosedPriceMedian: 800000 });
    expect(result.monthly[0].current.disclosedPriceMedian).toBe(800000);
    expect(result.listings.find((row) => row.listingId === "500")?.changedFields.some((field) => field.field === "propertyType")).toBe(true);
    expect(result.absentFromCurrentWindow).toHaveLength(0);
    expect(reportedHouseMetrics([previousHouse, reclassified]).reportedHouseListingCount).toBe(0);
  });

  it("marks the rolling search's first month and the capture month as partial while retaining intervening months", () => {
    const july = observation("590");
    const current = ["2026-04-11", "2026-05-01", "2026-06-01", "2026-09-30", "2026-10-01"].map((soldDateISO, index) =>
      observation(String(591 + index), { soldDateISO, scrapedAt: "2026-10-11T17:00:00.000Z" }));
    const result = buildComparison([scope(current, [july])], [july], options);
    expect(result.currentObservationWindow).toMatchObject({ captureDay: "2026-10-12", rollingBoundaryMonth: "2026-04" });
    expect(result.currentMonthly.map((month) => [month.month, month.currentCouldObserveWholeMonth])).toEqual([
      ["2026-04", false], ["2026-05", true], ["2026-06", true], ["2026-09", true], ["2026-10", false],
    ]);
    expect(result.monthly.find((month) => month.month === "2026-06")?.currentCouldObserveWholeMonth).toBe(true);
    expect(result.counts.completeSliceUniqueListingIds).toBe(5);
  });

  it("separates expanded locality coverage from temporal change and leaves its July coverage unavailable", () => {
    const july = observation("601");
    const currentKnown = observation("602", { scrapedAt: "2026-10-11T17:00:00.000Z" });
    const currentExpanded = { ...observation("603", { address: "2 Example Street, Carine", scrapedAt: "2026-10-11T17:00:00.000Z" }), scopeKey: "CARINE|WA|6020" };
    const expandedScope = scope([currentExpanded], [], { name: "carine-6020", suburb: "Carine", postcode: "6020", baselineAvailable: false, baselineCaptureCutoff: null });
    const result = buildComparison([scope([currentKnown], [july]), expandedScope], [july], options);
    expect(result.counts.newlyObservedListingIds).toBe(2);
    expect(result.alignedWindow.identityCounts.newlyObservedListingIds).toBe(1);
    expect(result.alignedWindow.current.reportedHouseListingCount).toBe(1);
    expect(result.monthly[0].current.reportedHouseListingCount).toBe(1);
    expect(result.currentMonthly[0].reportedHouseListingCount).toBe(2);
    expect(result.currentMonthly[0].expandedGeographyHouseListingCount).toBe(1);
    expect(result.coverageExpansion).toMatchObject({ historicalActualHouseLocalityCount: 1, comparableCompleteLocalityCount: 1, expandedCompleteLocalityCount: 1, expandedGeographyHouseListingCount: 1 });
    expect(result.coverageExpansion.expandedLocalities[0].baselineCoverage).toBe("unavailable");
    expect(result.listings.find((row) => row.listingId === "603")).toMatchObject({ baselineCoverage: "baseline-coverage-unavailable", saleAfterScopeJulyCaptureDay: null });
  });

  it("reconciles dated artifacts and refuses a corrupted page before replacing an existing comparison", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "rea-capture-comparison-"));
    const baselineDirectory = path.join(fixture, "baseline");
    const captureDirectory = path.join(fixture, "capture");
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    try {
      await mkdir(baselineDirectory); await mkdir(captureDirectory);
      const oldCsv = serialiseCaptureCsv([values({ address: "1 Example Street, Canning Vale", detailPath: "/sold/property-house-wa-canning+vale-123", detailUrl: "https://www.realestate.com.au/sold/property-house-wa-canning+vale-123",
        sourceUrl: "https://www.realestate.com.au/sold/property-house-in-canning+vale+dc,+wa+6155/list-1" })]);
      await writeFile(path.join(baselineDirectory, "source.csv"), oldCsv);
      await writeFile(path.join(baselineDirectory, "manifest.json"), json({ schemaVersion: 1, runId: "july", totals: { files: 1, rows: 1, bytes: Buffer.byteLength(oldCsv) },
        scrapedAtRange: { from: "2026-07-06T17:35:58.691Z", to: "2026-07-06T17:35:58.691Z" },
        files: [{ relativeFileName: "source.csv", bytes: Buffer.byteLength(oldCsv), sha256: digest(oldCsv), rowCount: 1, scope: { suburb: "CANNING VALE DC", postcode: "6155", exactOnly: true }, scrapedAtRange: { from: "2026-07-06T17:35:58.691Z", to: "2026-07-06T17:35:58.691Z" } }] }));
      const slice = { name: "canning-vale-6155", suburb: "Canning Vale", state: "WA", postcode: "6155", soldDateFrom: "2026-06-01" };
      const plan = { runId: "october", slices: [slice] };
      await writeFile(path.join(captureDirectory, "plan.json"), json(plan));
      const resolvedLocalities = [{ name: "Canning Vale", state: "WA", display: "Canning Vale, WA 6155" }];
      const projection = { id: "123", shortAddress: "1 Example Street", suburb: "Canning Vale", state: "WA", postcode: "6155", priceDisplay: "$900,000", soldDateDisplay: "1 Jun 2026", propertyType: "House", bedrooms: "3", bathrooms: "2", carSpaces: "2", landDisplay: "500", landUnit: "m²", detailPath: "/sold/property-house-wa-canning+vale-123" };
      const page = adaptProjectedPage({ totalResultsCount: 1, pagination: { page: 1, maxPageNumberAvailable: 1, moreResultsAvailable: false }, resolvedLocalities,
        rows: [LISTING_PROJECTION_COLUMNS.map((column) => projection[column])], surroundingCount: 0 }, LISTING_PROJECTION_COLUMNS,
      { suburb: "Canning Vale", postcode: "6155", pageNumber: 1, sourceUrl: "https://www.realestate.com.au/sold/property-house-in-canning+vale,+wa+6155/list-1", capturedAt: "2026-10-11T17:00:00.000Z" });
      const savedPage = json({ capture: page, evidence: { resolvedLocalities } });
      const currentCsv = serialiseCaptureCsv(page.rows);
      await writeFile(path.join(captureDirectory, "page.json"), savedPage);
      await writeFile(path.join(captureDirectory, "source.csv"), currentCsv);
      await writeFile(path.join(captureDirectory, "manifest.json"), json({ schemaVersion: 1, runId: "october", status: "complete", planSha256: digest(JSON.stringify(plan)), settings: { maxPages: 100, comparisonCutoff: "2026-06-01" },
        slices: [{ ...slice, status: "complete", pages: [{ file: "page.json", pageNumber: 1, capturedAt: page.capturedAt, rows: 1, bytes: Buffer.byteLength(savedPage), sha256: digest(savedPage) }], csv: { file: "source.csv", rows: 1, bytes: Buffer.byteLength(currentCsv), sha256: digest(currentCsv) } }] }));
      const report = await compareCaptureDirectories(captureDirectory, baselineDirectory);
      expect(report.counts.changedReobservedListingIds).toBe(1);
      expect(report.alignedWindow.current.disclosedPriceMedian).toBe(900000);
      expect(report.slices[0]).toMatchObject({ baselineCoverageAvailable: true, baselineMatchMethod: "actual-address-across-other-query-files" });
      expect(report.listings[0].baselineEvidence).toMatchObject({ actualSuburb: "CANNING VALE", actualPostcode: null, queryScope: { suburb: "CANNING VALE DC", postcode: "6155" } });
      const supplementDirectory = path.join(fixture, "supplement");
      await mkdir(supplementDirectory);
      const supplementarySlice = { name: "carine-6020", suburb: "Carine", state: "WA", postcode: "6020", soldDateFrom: "2026-06-01" };
      const supplementaryPlan = { runId: "october-supplement", slices: [supplementarySlice] };
      const supplementaryLocalities = [{ name: "Carine", state: "WA", display: "Carine, WA 6020" }];
      const supplementaryProjection = { ...projection, id: "321", suburb: "Carine", postcode: "6020", detailPath: "/sold/property-house-wa-carine-321" };
      const supplementaryPage = adaptProjectedPage({ totalResultsCount: 1, pagination: { page: 1, maxPageNumberAvailable: 1, moreResultsAvailable: false }, resolvedLocalities: supplementaryLocalities,
        rows: [LISTING_PROJECTION_COLUMNS.map((column) => supplementaryProjection[column])], surroundingCount: 0 }, LISTING_PROJECTION_COLUMNS,
      { suburb: "Carine", postcode: "6020", pageNumber: 1, sourceUrl: "https://www.realestate.com.au/sold/property-house-in-carine,+wa+6020/list-1", capturedAt: "2026-10-11T17:05:00.000Z" });
      const supplementaryPageJson = json({ capture: supplementaryPage, evidence: { resolvedLocalities: supplementaryLocalities } });
      const supplementaryCsv = serialiseCaptureCsv(supplementaryPage.rows);
      await writeFile(path.join(supplementDirectory, "plan.json"), json(supplementaryPlan));
      await writeFile(path.join(supplementDirectory, "page.json"), supplementaryPageJson);
      await writeFile(path.join(supplementDirectory, "source.csv"), supplementaryCsv);
      await writeFile(path.join(supplementDirectory, "manifest.json"), json({ schemaVersion: 1, runId: "october-supplement", status: "complete", planSha256: digest(JSON.stringify(supplementaryPlan)), settings: { maxPages: 100, comparisonCutoff: "2026-06-01" },
        slices: [{ ...supplementarySlice, status: "complete", pages: [{ file: "page.json", pageNumber: 1, capturedAt: supplementaryPage.capturedAt, rows: 1, bytes: Buffer.byteLength(supplementaryPageJson), sha256: digest(supplementaryPageJson) }], csv: { file: "source.csv", rows: 1, bytes: Buffer.byteLength(supplementaryCsv), sha256: digest(supplementaryCsv) } }] }));
      const combined = await compareCaptureDirectories(captureDirectory, baselineDirectory, [supplementDirectory]);
      expect(combined.captureRunIds).toEqual(["october", "october-supplement"]);
      expect(combined.inputs.additionalCaptures[0]).toMatchObject({ runId: "october-supplement", captureDirectory: supplementDirectory });
      expect(combined.counts.completeSliceUniqueListingIds).toBe(2);
      expect(combined.alignedWindow.current.reportedHouseListingCount).toBe(1);
      expect(combined.currentMonthly[0].reportedHouseListingCount).toBe(2);
      expect(combined.coverageExpansion.expandedGeographyHouseListingCount).toBe(1);
      expect(await readFile(path.join(captureDirectory, "plan.json"), "utf8")).toBe(json(plan));
      expect(await readFile(path.join(supplementDirectory, "page.json"), "utf8")).toBe(supplementaryPageJson);
      const retainedComparison = await readFile(path.join(captureDirectory, "comparison.json"), "utf8");
      await writeFile(path.join(captureDirectory, "page.json"), `${savedPage}\n`);
      await expect(compareCaptureDirectories(captureDirectory, baselineDirectory)).rejects.toThrow("checksum or length mismatch: page.json");
      expect(await readFile(path.join(captureDirectory, "comparison.json"), "utf8")).toBe(retainedComparison);
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(fixture));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(fixture).startsWith("rea-capture-comparison-")) throw new Error("Refusing cleanup outside the generated comparison fixture");
      await rm(fixture, { recursive: true });
    }
  });
});
