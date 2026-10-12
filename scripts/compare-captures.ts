import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSourceCsv, SOURCE_COLUMNS, type SourceRow } from "../src/lib/source";
import { adaptProjectedPage, disclosedPriceValue, LISTING_PROJECTION_COLUMNS, validateSliceCapture, type CapturedListingPage, type ListingProjection } from "../src/lib/rea-listing-capture";

type FileIntegrity = { file?: string; relativeFileName?: string; bytes: number; sha256: string; rows?: number; rowCount?: number };
type Scope = { suburb: string; postcode: string; state?: string; exactOnly?: boolean };
type BaselineFile = FileIntegrity & { scope: Scope; scrapedAtRange: { from: string; to: string } | null };
type BaselineManifest = { schemaVersion: number; runId: string; files: BaselineFile[]; scrapedAtRange: { from: string; to: string }; totals: { files: number; rows: number; bytes: number } };
type PageReference = FileIntegrity & { file: string; pageNumber: number; capturedAt: string; rows: number };
type CaptureSlice = Scope & { name: string; status: string; soldDateFrom?: string; pages: PageReference[]; csv?: FileIntegrity & { file: string }; failure?: string; summary?: { complete: boolean } };
type CaptureManifest = { schemaVersion: number; runId: string; status: string; planSha256: string; settings: { maxPages: number; comparisonCutoff?: string }; slices: CaptureSlice[]; startedAt: string; updatedAt: string; finishedAt?: string };
export type ComparisonObservation = { listingId: string; values: SourceRow; scopeKey: string; file: string; actualSuburb?: string; queryScope?: Scope };
type BaselineLocalitySource = { file: string; querySuburb: string; queryPostcode: string; exactOnlyRequested: boolean | null; actualHouseRows: number; sourceFileHouseRows: number };
export type ComparisonScope = Scope & { name: string; status: string; baselineExactOnly: boolean | null; baselineCaptureCutoff: string | null; currentCapturedRows: number; currentRows: ComparisonObservation[]; baselineRows: ComparisonObservation[]; excludedHistoricalSurroundingRows: number; failure?: string;
  captureRunId?: string; baselineAvailable?: boolean; baselineMatchMethod?: string; baselineSources?: BaselineLocalitySource[] };
type ComparableValues = { address: string; priceDisplay: string; disclosedPriceValue: string; soldDateISO: string; bedrooms: string; bathrooms: string; carSpaces: string; landSizeSqm: string; propertyType: string };
type ChangedField = { field: keyof ComparableValues; before: string; after: string };

const sha256 = (buffer: Buffer | string) => createHash("sha256").update(buffer).digest("hex");
const normalise = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
const scopeIdentity = (scope: Scope) => `${normalise(scope.suburb)}|WA|${scope.postcode}`;
const actualSuburb = (row: ComparisonObservation) => normalise(row.actualSuburb ?? (row.values.address.includes(",") ? row.values.address.split(",").at(-1)! : ""));
const hasWaListingPath = (row: ComparisonObservation) => /\/sold\/property-[^/]+?-wa-/i.test(row.values.detailPath || row.values.detailUrl);
const isHistoricalWaHouse = (row: ComparisonObservation) => normalise(row.values.propertyType) === "HOUSE" && hasWaListingPath(row);
const hasHouseBaseline = (scope: ComparisonScope) => scope.baselineAvailable ?? scope.baselineRows.some(isHistoricalWaHouse);
const perthDate = (timestamp: string) => new Date(Date.parse(timestamp) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const rowIdentity = (values: SourceRow) => {
  const id = /-(\d+)$/.exec(values.detailPath || values.detailUrl)?.[1];
  if (!id) throw new Error(`Invalid listing identity: ${values.detailPath || values.detailUrl}`);
  if (!Number.isFinite(Date.parse(values.scrapedAt))) throw new Error(`Listing ${id} has no valid observation timestamp`);
  return id;
};
const latestTimestamp = (timestamps: string[]) => timestamps.reduce<string | null>((latest, timestamp) => latest == null || Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest, null);
const sortedFields = (row: SourceRow) => SOURCE_COLUMNS.map((column) => row[column]);

function containedPath(directory: string, relativeFile: string): string {
  if (path.isAbsolute(relativeFile)) throw new Error(`Manifest file path must be relative: ${relativeFile}`);
  const resolved = path.resolve(directory, relativeFile);
  const relative = path.relative(directory, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Manifest path escapes its capture directory: ${relativeFile}`);
  return resolved;
}

async function verifiedFile(directory: string, reference: FileIntegrity): Promise<Buffer> {
  const file = reference.file ?? reference.relativeFileName;
  if (!file || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error("Invalid manifest file integrity entry");
  const buffer = await readFile(containedPath(directory, file));
  if (buffer.byteLength !== reference.bytes || sha256(buffer) !== reference.sha256) throw new Error(`Capture file checksum or length mismatch: ${file}`);
  return buffer;
}

/** Prefer the latest reported observation, with a deterministic tie break for duplicate suburb-query rows. */
export function latestByListing(rows: readonly ComparisonObservation[]): Map<string, ComparisonObservation> {
  const result = new Map<string, ComparisonObservation>();
  for (const row of rows) {
    const previous = result.get(row.listingId);
    const difference = previous ? Date.parse(row.values.scrapedAt) - Date.parse(previous.values.scrapedAt) : 1;
    if (!previous || difference > 0 || (difference === 0 && row.file.localeCompare(previous.file) < 0)) result.set(row.listingId, row);
  }
  return result;
}

export function comparableValues(row: SourceRow): ComparableValues {
  return { address: row.address, priceDisplay: row.price, disclosedPriceValue: disclosedPriceValue(row.price), soldDateISO: row.soldDateISO,
    bedrooms: row.bedrooms, bathrooms: row.bathrooms, carSpaces: row.carSpaces, landSizeSqm: row.landSizeSqm, propertyType: row.propertyType };
}

export function changedFields(before: SourceRow, after: SourceRow): ChangedField[] {
  const previous = comparableValues(before);
  const current = comparableValues(after);
  return (Object.keys(previous) as (keyof ComparableValues)[]).filter((field) => previous[field] !== current[field])
    .map((field) => ({ field, before: previous[field], after: current[field] }));
}

/** The price display is authoritative: historical range midpoints are excluded even when priceValue is populated. */
export function reportedHouseMetrics(rows: readonly ComparisonObservation[]) {
  const houses = [...latestByListing(rows).values()].filter((row) => normalise(row.values.propertyType) === "HOUSE" && validDate(row.values.soldDateISO));
  const prices = houses.map((row) => disclosedPriceValue(row.values.price)).filter(Boolean).map(Number).sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  return { reportedHouseListingCount: houses.length, disclosedPriceCount: prices.length, undisclosedOrNonExactPriceCount: houses.length - prices.length,
    disclosedPriceMedian: prices.length ? (prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2) : null };
}

export function buildComparison(scopes: readonly ComparisonScope[], allBaselineRows: readonly ComparisonObservation[], options: { soldDateFrom: string; baselineGlobalCaptureCutoff: string }) {
  if (!validDate(options.soldDateFrom) || !validDate(options.baselineGlobalCaptureCutoff)) throw new Error("Comparison dates must be valid ISO dates");
  const complete = scopes.filter((scope) => scope.status === "complete");
  const baseline = latestByListing(allBaselineRows);
  const allCurrent = latestByListing(complete.flatMap((scope) => scope.currentRows));
  const current = new Map([...allCurrent].filter(([, row]) => normalise(row.values.propertyType) === "HOUSE"));
  const perScope = new Map(complete.map((scope) => [scopeIdentity(scope), scope]));
  const comparableScopes = complete.filter(hasHouseBaseline);
  const comparableScopeKeys = new Set(comparableScopes.map(scopeIdentity));
  const comparableLocalities = new Set(comparableScopes.map((scope) => normalise(scope.suburb)));
  const listings = [...allCurrent.values()].sort((a, b) => a.listingId.localeCompare(b.listingId)).map((row) => {
    const before = baseline.get(row.listingId);
    const differences = before ? changedFields(before.values, row.values) : [];
    const scope = perScope.get(row.scopeKey)!;
    const date = row.values.soldDateISO;
    return { listingId: row.listingId, scopeKey: row.scopeKey, comparison: before ? "reobserved" : "newly-observed", changed: differences.length > 0,
      actualPropertyType: row.values.propertyType, includedInHouseHeadlines: normalise(row.values.propertyType) === "HOUSE",
      julyLocalityBaselineAvailable: hasHouseBaseline(scope), baselineCoverage: hasHouseBaseline(scope) ? "historically-observed-locality" : "baseline-coverage-unavailable",
      saleAfterGlobalJulyCaptureDay: validDate(date) && date > options.baselineGlobalCaptureCutoff,
      saleAfterScopeJulyCaptureDay: hasHouseBaseline(scope) ? validDate(date) && scope.baselineCaptureCutoff != null && date > scope.baselineCaptureCutoff : null,
      scopeJulyCaptureDay: hasHouseBaseline(scope) ? scope.baselineCaptureCutoff : null, baselineObservedAt: before?.values.scrapedAt ?? null, currentObservedAt: row.values.scrapedAt,
      baselineEvidence: before ? { file: before.file, actualSuburb: actualSuburb(before), actualState: hasWaListingPath(before) ? "WA" : null, actualPostcode: null, queryScope: before.queryScope ?? null } : null,
      before: before ? comparableValues(before.values) : null, after: comparableValues(row.values), changedFields: differences };
  });
  const historicalAligned = new Map([...baseline].filter(([, row]) => comparableLocalities.has(actualSuburb(row)) && isHistoricalWaHouse(row) && validDate(row.values.soldDateISO) && row.values.soldDateISO >= options.soldDateFrom));
  const currentAligned = [...current.values()].filter((row) => comparableScopeKeys.has(row.scopeKey) && row.values.soldDateISO >= options.soldDateFrom);
  const absent = [...historicalAligned.values()].filter((row) => !allCurrent.has(row.listingId)).map((row) => ({ listingId: row.listingId, scopeKey: row.scopeKey,
    comparison: "absent-from-current-window", baselineObservedAt: row.values.scrapedAt, actualSuburb: actualSuburb(row), actualPostcode: null,
    baselineFile: row.file, baselineQueryScope: row.queryScope ?? null, before: comparableValues(row.values) })).sort((a, b) => a.listingId.localeCompare(b.listingId));
  const currentContext = [...current.values()].filter((row) => row.values.soldDateISO < options.soldDateFrom);
  const contextDates = currentContext.map((row) => row.values.soldDateISO).sort();
  const currentCaptureTimestamp = latestTimestamp([...current.values()].map((row) => row.values.scrapedAt));
  const currentCaptureDay = currentCaptureTimestamp ? perthDate(currentCaptureTimestamp) : null;
  const rollingBoundaryMonth = currentCaptureDay ? new Date(Date.UTC(Number(currentCaptureDay.slice(0, 4)), Number(currentCaptureDay.slice(5, 7)) - 7, 1)).toISOString().slice(0, 7) : null;
  const couldObserveWholeCurrentMonth = (month: string) => currentCaptureDay != null && rollingBoundaryMonth != null && month > rollingBoundaryMonth && monthEnd(month) < currentCaptureDay;
  const months = [...new Set([...historicalAligned.values(), ...currentAligned].map((row) => row.values.soldDateISO.slice(0, 7)))].sort();
  const monthly = months.map((month) => ({ month, source: "REA reported House listings in complete current localities with July House-address evidence",
    baseline: reportedHouseMetrics([...historicalAligned.values()].filter((row) => row.values.soldDateISO.startsWith(month))),
    current: reportedHouseMetrics(currentAligned.filter((row) => row.values.soldDateISO.startsWith(month))),
    baselineCouldObserveWholeMonth: monthEnd(month) < options.baselineGlobalCaptureCutoff,
    currentCouldObserveWholeMonth: couldObserveWholeCurrentMonth(month),
    baselineCaptureDay: options.baselineGlobalCaptureCutoff, currentCaptureDay }));
  const headlineListings = listings.filter((item) => item.includedInHouseHeadlines);
  const alignedListings = headlineListings.filter((item) => item.julyLocalityBaselineAvailable && item.after.soldDateISO >= options.soldDateFrom);
  const expandedHouseListings = headlineListings.filter((item) => !item.julyLocalityBaselineAvailable);
  const counts = { headlinePropertyType: "House", identityCountWindow: "Full six-month capture in complete scopes; includes April/May rows and expanded locality coverage. See alignedWindow for the shared historical cohort.",
    plannedSlices: scopes.length, completeSlices: complete.length, incompleteSlices: scopes.length - complete.length,
    completeSliceUniqueListingIds: current.size, newlyObservedListingIds: headlineListings.filter((item) => item.comparison === "newly-observed").length,
    reobservedListingIds: headlineListings.filter((item) => item.comparison === "reobserved").length, changedReobservedListingIds: headlineListings.filter((item) => item.changed).length,
    reportedSalesDatedAfterGlobalJulyCaptureDay: headlineListings.filter((item) => item.saleAfterGlobalJulyCaptureDay).length,
    reportedSalesDatedAfterScopeJulyCaptureDay: headlineListings.filter((item) => item.saleAfterScopeJulyCaptureDay).length,
    newlyObservedWithSaleDateOnOrBeforeGlobalJulyCaptureDay: headlineListings.filter((item) => item.comparison === "newly-observed" && !item.saleAfterGlobalJulyCaptureDay).length,
    absentFromCurrentAlignedWindow: absent.length, currentBeforeJuneOverlapWindow: currentContext.length };
  const actualPropertyTypeCounts = Object.fromEntries([...new Set(listings.map((item) => item.actualPropertyType))].sort().map((type) => [type, listings.filter((item) => item.actualPropertyType === type).length]));
  const nonHouse = listings.filter((item) => !item.includedInHouseHeadlines);
  const historicalHouseLocalities = new Set(allBaselineRows.filter(isHistoricalWaHouse).map(actualSuburb).filter(Boolean));
  const currentMonthly = [...new Set([...current.values()].map((row) => row.values.soldDateISO.slice(0, 7)))].sort().map((month) => ({ month,
    source: "REA reported actual House listings in all complete current scopes, including expanded geography", baseline: null,
    ...reportedHouseMetrics([...current.values()].filter((row) => row.values.soldDateISO.startsWith(month))),
    expandedGeographyHouseListingCount: expandedHouseListings.filter((row) => row.after.soldDateISO.startsWith(month)).length,
    currentCouldObserveWholeMonth: couldObserveWholeCurrentMonth(month), currentCaptureDay }));
  return { counts, currentObservationWindow: { captureDay: currentCaptureDay, requestedMaxSoldAge: "6-month", rollingBoundaryMonth,
    interpretation: "The boundary month is derived conservatively from the Perth capture day minus six calendar months. That month and the capture month are partial; this does not assert the source's exact day cutoff or market completeness." },
    sourceCoverage: { allActualTypesUniqueListingIds: allCurrent.size, actualPropertyTypeCounts, nonHouseUniqueListingIds: nonHouse.length,
    nonHouseNewlyObservedListingIds: nonHouse.filter((item) => item.comparison === "newly-observed").length,
    nonHouseReobservedListingIds: nonHouse.filter((item) => item.comparison === "reobserved").length,
    nonHouseListingIds: nonHouse.map((item) => item.listingId), explanation: "The site's House filter can return listings classified as Other or another actual property type. These remain in source coverage and change records, but House headlines and medians use actual House rows only." },
    coverageExpansion: { historicalActualHouseLocalityCount: historicalHouseLocalities.size, comparableCompleteLocalityCount: comparableScopes.length,
      expandedCompleteLocalityCount: complete.length - comparableScopes.length, expandedGeographyHouseListingCount: expandedHouseListings.length,
      expandedGeographyNewlyObservedHouseListingIds: expandedHouseListings.filter((item) => item.comparison === "newly-observed").length,
      expandedGeographyHouseListingsOnOrAfterCutoff: expandedHouseListings.filter((item) => item.after.soldDateISO >= options.soldDateFrom).length,
      expandedLocalities: complete.filter((scope) => !hasHouseBaseline(scope)).map((scope) => ({ suburb: scope.suburb, postcode: scope.postcode, baselineCoverage: "unavailable", currentHouseListings: scope.currentRows.filter((row) => normalise(row.values.propertyType) === "HOUSE").length })),
      interpretation: "Localities without July actual House address evidence represent coverage expansion. Their historical coverage is unavailable, rather than zero reported sales, and they are excluded from aligned historical monthly comparisons." },
    alignedWindow: { soldDateFrom: options.soldDateFrom, localityCohort: "Complete current localities with July actual House address evidence", comparableCompleteLocalityCount: comparableScopes.length,
      identityCounts: { uniqueListingIds: alignedListings.length, newlyObservedListingIds: alignedListings.filter((item) => item.comparison === "newly-observed").length,
        reobservedListingIds: alignedListings.filter((item) => item.comparison === "reobserved").length,
        changedReobservedListingIds: alignedListings.filter((item) => item.changed).length },
      baseline: reportedHouseMetrics([...historicalAligned.values()]), current: reportedHouseMetrics(currentAligned) },
    earlierSixMonthContext: { interpretation: "Rows before the June overlap cutoff remain in full-capture listing identity counts, but are outside the June-aligned monthly and price comparison.", ...reportedHouseMetrics(currentContext),
      soldDateRange: contextDates.length ? { from: contextDates[0], to: contextDates.at(-1)! } : null,
      monthly: [...new Set(contextDates.map((date) => date.slice(0, 7)))].map((month) => ({ month, ...reportedHouseMetrics(currentContext.filter((row) => row.values.soldDateISO.startsWith(month))) })) },
    monthly, currentMonthly, listings, absentFromCurrentWindow: absent,
    slices: scopes.map((scope) => ({ name: scope.name, suburb: scope.suburb, postcode: scope.postcode, status: scope.status,
      currentCapturedRows: scope.currentCapturedRows,
      currentHouseCapturedRows: scope.currentRows.filter((row) => normalise(row.values.propertyType) === "HOUSE").length,
      currentNonHouseCapturedRows: scope.currentRows.filter((row) => normalise(row.values.propertyType) !== "HOUSE").length,
      captureRunId: scope.captureRunId ?? null, includedInHeadlines: scope.status === "complete", includedInHistoricalMonthlyComparison: scope.status === "complete" && hasHouseBaseline(scope),
      baselineCoverageAvailable: hasHouseBaseline(scope), baselineMatchMethod: scope.baselineMatchMethod ?? null, baselineSources: scope.baselineSources ?? [], baselineExactOnly: scope.baselineExactOnly,
      baselineCaptureDay: scope.baselineCaptureCutoff, excludedHistoricalSurroundingRows: scope.excludedHistoricalSurroundingRows, failure: scope.failure ?? null })) };
}

export async function verifyCaptureInputs(captureDirectory: string, baselineDirectory: string, additionalCaptureDirectories: readonly string[] = []) {
  const baselineBytes = await readFile(path.join(baselineDirectory, "manifest.json"));
  const baseline = JSON.parse(baselineBytes.toString()) as BaselineManifest;
  if (baseline.schemaVersion !== 1 || !baseline.runId || !Array.isArray(baseline.files)) throw new Error("Unsupported dated baseline manifest");
  const directories = [captureDirectory, ...additionalCaptureDirectories];
  if (new Set(directories.map((directory) => path.resolve(directory).toLowerCase())).size !== directories.length) throw new Error("Capture directories are repeated");
  const captures: { directory: string; manifest: CaptureManifest; manifestSha256: string }[] = [];
  for (const directory of directories) {
    const manifestBytes = await readFile(path.join(directory, "manifest.json"));
    const capture = JSON.parse(manifestBytes.toString()) as CaptureManifest;
    if (capture.schemaVersion !== 1 || !capture.runId || !Array.isArray(capture.slices)) throw new Error(`Unsupported dated capture manifest: ${directory}`);
    if (capture.status === "running" || capture.slices.some((slice) => slice.status === "running")) throw new Error(`Capture is still running; finish or stop it before creating a durable comparison: ${directory}`);
    if (new Set(capture.slices.map((slice) => slice.name)).size !== capture.slices.length || new Set(capture.slices.map(scopeIdentity)).size !== capture.slices.length) throw new Error("Capture has duplicate slice names or scopes");
    const plan = JSON.parse(await readFile(path.join(directory, "plan.json"), "utf8"));
    if (sha256(JSON.stringify(plan)) !== capture.planSha256 || plan.runId !== capture.runId || JSON.stringify(plan.slices.map((slice: Scope & { name: string }) => [slice.name, scopeIdentity(slice)])) !== JSON.stringify(capture.slices.map((slice) => [slice.name, scopeIdentity(slice)]))) throw new Error(`Capture plan no longer matches its manifest: ${directory}`);
    captures.push({ directory, manifest: capture, manifestSha256: sha256(manifestBytes) });
  }
  if (new Set(captures.map((capture) => capture.manifest.runId)).size !== captures.length) throw new Error("Capture run IDs are repeated");
  if (new Set(captures.map((capture) => capture.manifest.settings.comparisonCutoff ?? "2026-06-01")).size !== 1) throw new Error("Combined captures have different comparison date cutoffs");
  const baselineByQueryScope = new Map<string, BaselineFile>();
  const baselineByActualSuburb = new Map<string, { rows: ComparisonObservation[]; sources: Map<string, BaselineLocalitySource> }>();
  const allBaselineRows: ComparisonObservation[] = [];
  let baselineRows = 0, baselineFileBytes = 0;
  for (const file of baseline.files) {
    const content = await verifiedFile(baselineDirectory, file);
    const parsed = parseSourceCsv(content);
    if (parsed.length !== file.rowCount) throw new Error(`Baseline row count differs from its manifest: ${file.relativeFileName}`);
    const key = scopeIdentity(file.scope);
    if (baselineByQueryScope.has(key)) throw new Error(`Duplicate baseline query scope: ${key}`);
    baselineByQueryScope.set(key, file);
    const sourceFileHouseRows = parsed.filter(({ values }) => normalise(values.propertyType) === "HOUSE").length;
    for (const { values } of parsed) {
      const name = values.address.includes(",") ? normalise(values.address.split(",").at(-1)!) : "";
      const row: ComparisonObservation = { listingId: rowIdentity(values), values, scopeKey: `${name}|WA|POSTCODE_UNRECORDED`, actualSuburb: name,
        file: file.relativeFileName!, queryScope: { suburb: file.scope.suburb, postcode: file.scope.postcode, state: "WA" } };
      allBaselineRows.push(row);
      if (!name || !isHistoricalWaHouse(row)) continue;
      const locality = baselineByActualSuburb.get(name) ?? { rows: [], sources: new Map<string, BaselineLocalitySource>() };
      locality.rows.push(row);
      const source = locality.sources.get(row.file) ?? { file: row.file, querySuburb: file.scope.suburb, queryPostcode: file.scope.postcode,
        exactOnlyRequested: file.scope.exactOnly ?? null, actualHouseRows: 0, sourceFileHouseRows };
      source.actualHouseRows++;
      locality.sources.set(row.file, source);
      baselineByActualSuburb.set(name, locality);
    }
    baselineRows += parsed.length; baselineFileBytes += content.byteLength;
  }
  if (baseline.files.length !== baseline.totals.files || baselineRows !== baseline.totals.rows || baselineFileBytes !== baseline.totals.bytes) throw new Error("Baseline manifest totals do not reconcile");
  const scopes: ComparisonScope[] = [];
  for (const input of captures) {
   const capture = input.manifest;
   for (const slice of capture.slices) {
    if (slice.state !== "WA" || !/^\d{4}$/.test(slice.postcode) || !Array.isArray(slice.pages)) throw new Error(`Invalid capture scope: ${slice.name}`);
    const pages: CapturedListingPage[] = [];
    for (const reference of slice.pages) {
      const saved = JSON.parse((await verifiedFile(input.directory, reference)).toString()) as { capture: CapturedListingPage; evidence: { resolvedLocalities: unknown[] } };
      const projected = saved.capture;
      const page = adaptProjectedPage({ totalResultsCount: projected.totalResultsCount, pagination: projected.pagination,
        rows: projected.listings.map((listing: ListingProjection) => LISTING_PROJECTION_COLUMNS.map((column) => listing[column])),
        resolvedLocalities: saved.evidence.resolvedLocalities, surroundingCount: 0, sourceWarnings: projected.sourceWarnings }, LISTING_PROJECTION_COLUMNS,
      { suburb: slice.suburb, postcode: slice.postcode, pageNumber: reference.pageNumber, capturedAt: reference.capturedAt, sourceUrl: projected.sourceUrl, pageSize: projected.pageSize });
      if (reference.rows !== page.rows.length || projected.capturedAt !== reference.capturedAt || projected.pageNumber !== reference.pageNumber || JSON.stringify(page.rows.map(sortedFields)) !== JSON.stringify(projected.rows.map(sortedFields)) || JSON.stringify(page.listingIds) !== JSON.stringify(projected.listingIds)) throw new Error(`Saved page projection and CSV rows disagree: ${reference.file}`);
      pages.push(page);
    }
    const summary = validateSliceCapture(pages, { suburb: slice.suburb, postcode: slice.postcode, soldDateFrom: slice.soldDateFrom, maxPages: capture.settings.maxPages, failure: slice.failure });
    if (slice.status === "complete" && !summary.complete) throw new Error(`Slice incorrectly marked complete: ${slice.name}: ${summary.problems.join("; ")}`);
    const pageRows = pages.flatMap((page) => page.rows);
    if (slice.csv) {
      const csvRows = parseSourceCsv(await verifiedFile(input.directory, slice.csv)).map(({ values }) => values);
      if (slice.csv.rows !== csvRows.length || JSON.stringify(csvRows.map(sortedFields)) !== JSON.stringify(pageRows.map(sortedFields))) throw new Error(`CSV and committed pages disagree: ${slice.name}`);
    } else if (slice.status === "complete" || pageRows.length) throw new Error(`Capture CSV is missing: ${slice.name}`);
    const key = scopeIdentity(slice);
    const previous = baselineByActualSuburb.get(normalise(slice.suburb));
    const historicalRows = previous?.rows ?? [];
    const baselineSources = [...(previous?.sources.values() ?? [])];
    const exactQuery = baselineByQueryScope.get(key);
    const matchedExactQuery = exactQuery != null && baselineSources.some((source) => source.file === exactQuery.relativeFileName);
    const cutoff = latestTimestamp(historicalRows.map((row) => row.values.scrapedAt));
    scopes.push({ name: slice.name, suburb: slice.suburb, postcode: slice.postcode, status: slice.status, captureRunId: capture.runId,
      baselineAvailable: historicalRows.length > 0, baselineMatchMethod: !historicalRows.length ? "unavailable" : matchedExactQuery ? "actual-address-with-matching-query-evidence" : "actual-address-across-other-query-files",
      baselineSources, baselineExactOnly: matchedExactQuery ? exactQuery.scope.exactOnly ?? null : null,
      baselineCaptureCutoff: cutoff ? perthDate(cutoff) : null, currentCapturedRows: pageRows.length,
      currentRows: pageRows.map((values) => ({ listingId: rowIdentity(values), values, scopeKey: key, actualSuburb: normalise(slice.suburb), file: `${capture.runId}/${slice.csv?.file ?? slice.name}` })),
      baselineRows: historicalRows, excludedHistoricalSurroundingRows: baselineSources.reduce((sum, source) => sum + source.sourceFileHouseRows - source.actualHouseRows, 0), failure: slice.failure });
   }
  }
  if (new Set(scopes.map(scopeIdentity)).size !== scopes.length) throw new Error("Combined captures repeat an exact query scope; use disjoint capture plans");
  return { captures, baseline, baselineManifestSha256: sha256(baselineBytes), scopes, allBaselineRows };
}

function csv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const cell = (value: unknown) => { const display = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value); return /[",\r\n]/.test(display) ? `"${display.replaceAll('"', '""')}"` : display; };
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => cell(row[column])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}

async function writeDerived(file: string, content: string) {
  await writeFile(`${file}.tmp`, content);
  await rename(`${file}.tmp`, file);
}

export async function compareCaptureDirectories(captureDirectory: string, baselineDirectory: string, additionalCaptureDirectories: readonly string[] = []) {
  const inputs = await verifyCaptureInputs(captureDirectory, baselineDirectory, additionalCaptureDirectories);
  const primary = inputs.captures[0];
  const soldDateFrom = primary.manifest.settings.comparisonCutoff ?? "2026-06-01";
  const baselineGlobalCaptureCutoff = perthDate(inputs.baseline.scrapedAtRange.to);
  const comparison = buildComparison(inputs.scopes, inputs.allBaselineRows, { soldDateFrom, baselineGlobalCaptureCutoff });
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), captureRunId: primary.manifest.runId,
    captureRunIds: inputs.captures.map((capture) => capture.manifest.runId), baselineRunId: inputs.baseline.runId,
    inputs: { captureDirectory, baselineDirectory, captureManifestSha256: primary.manifestSha256, baselineManifestSha256: inputs.baselineManifestSha256,
      additionalCaptures: inputs.captures.slice(1).map((capture) => ({ captureDirectory: capture.directory, manifestFile: path.join(capture.directory, "manifest.json"), runId: capture.manifest.runId, manifestSha256: capture.manifestSha256 })),
      allCommittedPageAndCsvChecksumsVerified: true, baselineGlobalCaptureTimestamp: inputs.baseline.scrapedAtRange.to, baselineGlobalCaptureDayPerth: baselineGlobalCaptureCutoff },
    methodology: [
      "Headline metrics include only complete October scopes whose committed pages reconcile to explicit terminal pagination and source totals. Incomplete scopes are reported separately.",
      "House-filter responses can include listings whose actual property type is Other. Preserve those source results and correction records, while excluding them from actual House headline counts and medians.",
      "Listing IDs are deduplicated using the latest observation in each capture. New observation, newly observed listing and reported sale date are separate measures.",
      "Top-level identity counts cover the full six-month actual House capture, including April/May context. Aligned-window identity counts, monthly metrics and price comparisons use the June 1 overlap cutoff.",
      "Historical monthly comparisons further require July actual House-address evidence for each current locality. Newly covered localities have unavailable baseline coverage, rather than zero historical sales. Full current monthly statistics are reported separately.",
      "A sale is counted as after a July capture only when its reported date is later than the capture day in Australia/Perth; same-day sales lack sufficient time precision.",
      "July rows are matched by their actual address suburb across all verified archive files. Their query suburb/postcode and surrounding setting remain provenance; source filename postcodes are never assigned as actual historical listing postcodes.",
      "The latest July House observation available for each actual locality defines its capture-day comparison cutoff. House presence establishes an available observation sample, not complete historical market coverage.",
      "Counts and medians describe REA reported listing coverage, not the complete Perth transaction population. Exact disclosed price displays alone enter medians; ranges and historic midpoint values are excluded.",
      "Absent-from-current-window means an aligned historical listing ID was not observed in the current complete scoped response. It is not evidence of deletion.",
      "July capture timestamps precede the later months. Their baseline monthly counts do not imply complete observations for July or any subsequent month."
    ], ...comparison };
  for (const capture of inputs.captures) {
    if (sha256(await readFile(path.join(capture.directory, "manifest.json"))) !== capture.manifestSha256) throw new Error("Input manifest changed during comparison; retry after collection stops");
  }
  if (sha256(await readFile(path.join(baselineDirectory, "manifest.json"))) !== inputs.baselineManifestSha256) throw new Error("Input baseline manifest changed during comparison; retry after collection stops");
  const listingRows = comparison.listings.map((item) => ({ ...item, changedFields: item.changedFields.map((field) => field.field).join("|"), ...item.after }));
  const changeRows = comparison.listings.flatMap((item) => item.changedFields.map((field) => ({ listingId: item.listingId, scopeKey: item.scopeKey, baselineObservedAt: item.baselineObservedAt, currentObservedAt: item.currentObservedAt, ...field })));
  const monthlyRows = comparison.monthly.map((month) => ({ month: month.month, baselineHouseListings: month.baseline.reportedHouseListingCount, currentHouseListings: month.current.reportedHouseListingCount,
    baselineDisclosedPricesN: month.baseline.disclosedPriceCount, currentDisclosedPricesN: month.current.disclosedPriceCount,
    baselineDisclosedPriceMedian: month.baseline.disclosedPriceMedian, currentDisclosedPriceMedian: month.current.disclosedPriceMedian,
    baselineCouldObserveWholeMonth: month.baselineCouldObserveWholeMonth, currentCouldObserveWholeMonth: month.currentCouldObserveWholeMonth,
    currentCaptureDay: month.currentCaptureDay, source: month.source }));
  await writeDerived(path.join(captureDirectory, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeDerived(path.join(captureDirectory, "comparison.csv"), csv(["listingId", "scopeKey", "actualPropertyType", "includedInHouseHeadlines", "julyLocalityBaselineAvailable", "baselineCoverage", "comparison", "changed", "changedFields", "soldDateISO", "priceDisplay", "disclosedPriceValue", "address", "bedrooms", "bathrooms", "carSpaces", "landSizeSqm", "baselineObservedAt", "currentObservedAt", "scopeJulyCaptureDay", "saleAfterGlobalJulyCaptureDay", "saleAfterScopeJulyCaptureDay"], listingRows));
  await writeDerived(path.join(captureDirectory, "comparison-changes.csv"), csv(["listingId", "scopeKey", "field", "before", "after", "baselineObservedAt", "currentObservedAt"], changeRows));
  await writeDerived(path.join(captureDirectory, "comparison-monthly.csv"), csv(["month", "baselineHouseListings", "currentHouseListings", "baselineDisclosedPricesN", "currentDisclosedPricesN", "baselineDisclosedPriceMedian", "currentDisclosedPriceMedian", "baselineCouldObserveWholeMonth", "currentCouldObserveWholeMonth", "currentCaptureDay", "source"], monthlyRows));
  await writeDerived(path.join(captureDirectory, "comparison-current-monthly.csv"), csv(["month", "reportedHouseListingCount", "disclosedPriceCount", "undisclosedOrNonExactPriceCount", "disclosedPriceMedian", "expandedGeographyHouseListingCount", "currentCouldObserveWholeMonth", "currentCaptureDay", "source"], comparison.currentMonthly));
  await writeDerived(path.join(captureDirectory, "comparison-absence.csv"), csv(["listingId", "scopeKey", "actualSuburb", "actualPostcode", "baselineFile", "baselineQueryScope", "comparison", "baselineObservedAt", "soldDateISO", "priceDisplay", "address"], comparison.absentFromCurrentWindow.map((row) => ({ ...row, ...row.before }))));
  await writeDerived(path.join(captureDirectory, "comparison-slices.csv"), csv(["name", "suburb", "postcode", "captureRunId", "status", "currentCapturedRows", "currentHouseCapturedRows", "currentNonHouseCapturedRows", "includedInHeadlines", "includedInHistoricalMonthlyComparison", "baselineCoverageAvailable", "baselineMatchMethod", "baselineExactOnly", "baselineCaptureDay", "baselineSources", "excludedHistoricalSurroundingRows", "failure"], comparison.slices));
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("tsx scripts/compare-captures.ts [--capture captures/perth-houses-2026-10-12] [--baseline captures/2026-07-baseline] [--additional-capture captures/perth-houses-2026-10-12-supplement]"); return; }
  const directories = { capture: "captures/perth-houses-2026-10-12", baseline: "captures/2026-07-baseline" };
  const additionalCaptures: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (!["--capture", "--baseline", "--additional-capture"].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unsupported or missing CLI argument: ${args[index]}`);
    if (args[index] === "--additional-capture") additionalCaptures.push(path.resolve(args[index + 1]));
    else directories[args[index].slice(2) as keyof typeof directories] = args[index + 1];
  }
  const result = await compareCaptureDirectories(path.resolve(directories.capture), path.resolve(directories.baseline), additionalCaptures);
  console.log(JSON.stringify({ output: path.resolve(directories.capture, "comparison.json"), counts: result.counts, alignedWindow: result.alignedWindow }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
