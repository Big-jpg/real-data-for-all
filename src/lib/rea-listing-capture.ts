import { SOURCE_COLUMNS, type SourceRow } from "./source";

export const LISTING_PROJECTION_COLUMNS = [
  "id", "shortAddress", "suburb", "state", "postcode", "priceDisplay", "soldDateDisplay",
  "propertyType", "bedrooms", "bathrooms", "carSpaces", "landDisplay", "landUnit", "detailPath",
] as const;

export type CaptureScope = { suburb: string; postcode: string };
export type PageCaptureContext = CaptureScope & {
  pageNumber: number;
  capturedAt: string;
  sourceUrl: string;
  pageSize?: number;
  /** Only for importing historical projections that predate resolved-locality evidence. */
  requireResolvedScope?: boolean;
};
export type ListingProjection = Record<(typeof LISTING_PROJECTION_COLUMNS)[number], string | number | null> & {
  detailUrl?: string;
};
export type CapturePagination = { page: number; maxPageNumberAvailable: number; moreResultsAvailable: boolean };
export type ListingSourceWarnings = {
  field: "listers";
  itemIndex: number;
  message: "Source agent data unavailable; outside collected fields";
}[];
export type CapturedListingPage = {
  schemaVersion: 1;
  /** Requested search filter; individual results retain the property's actual source type. */
  scope: CaptureScope & { state: "WA"; propertyType: "House" };
  sourceUrl: string;
  pageNumber: number;
  pageSize: number;
  capturedAt: string;
  totalResultsCount: number;
  pagination: CapturePagination;
  resolvedScopeVerified: boolean;
  listings: ListingProjection[];
  listingIds: string[];
  rows: SourceRow[];
  sourceWarnings?: ListingSourceWarnings;
};

export class ListingCaptureError extends Error {
  constructor(message: string) { super(message); this.name = "ListingCaptureError"; }
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ListingCaptureError(`${label} is missing or invalid`);
  return value as JsonObject;
};
const text = (value: unknown): string => value == null ? "" : String(value).trim();
const localityName = (value: unknown) => text(value).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
const integer = (value: unknown, label: string, minimum = 0) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new ListingCaptureError(`${label} is invalid`);
  return value;
};
const optionalFeature = (value: unknown) => {
  const display = text(value);
  return /^\d+$/.test(display) && Number.isSafeInteger(Number(display)) ? display : "";
};

function uncollectedListerPath(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && value.length === 7 && value[0] === "soldSearch" && value[1] === "results" &&
    value[2] === "exact" && value[3] === "items" && typeof value[4] === "number" && Number.isSafeInteger(value[4]) &&
    value[4] >= 0 && value[5] === "listing" && value[6] === "listers";
}

/** Errors on uncollected agent/lister fields do not invalidate independently validated sale fields. */
function listingSourceWarnings(errors: unknown, label: string): ListingSourceWarnings | undefined {
  if (errors == null) return undefined;
  if (!Array.isArray(errors)) throw new ListingCaptureError(`${label} contains errors`);
  if (!errors.length) return undefined;
  const paths = errors.map((error) => object(error, "GraphQL error").path);
  if (!paths.every(uncollectedListerPath)) throw new ListingCaptureError(`${label} contains errors`);
  return paths.map((path) => ({ field: "listers", itemIndex: path[4] as number, message: "Source agent data unavailable; outside collected fields" }));
}

function retainedSourceWarnings(value: unknown): ListingSourceWarnings | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new ListingCaptureError("Retained source warnings are invalid");
  if (!value.length) return undefined;
  return value.map((item) => {
    const warning = object(item, "Retained source warning");
    if (warning.field !== "listers" || warning.message !== "Source agent data unavailable; outside collected fields") {
      throw new ListingCaptureError("Retained source warning is outside the uncollected field whitelist");
    }
    return { field: "listers", itemIndex: integer(warning.itemIndex, "Source warning listing index"), message: "Source agent data unavailable; outside collected fields" };
  });
}

/** Parse the site's English sold-date display without relying on host timezone or permissive Date parsing. */
export function parseSoldDate(value: unknown): string {
  const display = text(value);
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(display);
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  if (!match) throw new ListingCaptureError(`Unrecognised sold date: ${display}`);
  const month = months.findIndex((name) => name === match[2].toLowerCase() || name.slice(0, 3) === match[2].toLowerCase());
  const day = Number(match[1]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (month < 0 || year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new ListingCaptureError(`Invalid sold date: ${display}`);
  }
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Ranges, guides and undisclosed prices remain display evidence, never a numeric midpoint. */
export function disclosedPriceValue(value: unknown): string {
  const display = text(value);
  if (!/^\$(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})?$/.test(display)) return "";
  const amount = Number(display.slice(1).replaceAll(",", ""));
  return Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER ? String(amount) : "";
}

export function landSizeSqm(display: unknown, unit: unknown): string {
  if (!["m²", "m2", "m^2"].includes(text(unit))) return "";
  const amount = text(display);
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(amount)) return "";
  const numeric = Number(amount.replaceAll(",", ""));
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "";
}

function validateContext(context: PageCaptureContext) {
  if (!text(context.suburb) || !/^\d{4}$/.test(context.postcode)) throw new ListingCaptureError("Expected WA locality scope is invalid");
  integer(context.pageNumber, "Requested page", 1);
  integer(context.pageSize ?? 25, "Page size", 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(context.capturedAt) || !Number.isFinite(Date.parse(context.capturedAt))) {
    throw new ListingCaptureError("A fixed UTC capture timestamp is required");
  }
  const canonicalTimestamp = context.capturedAt.includes(".") ? context.capturedAt : context.capturedAt.replace("Z", ".000Z");
  if (new Date(context.capturedAt).toISOString() !== canonicalTimestamp) throw new ListingCaptureError("Capture timestamp is not a valid calendar date");
  let url: URL;
  try { url = new URL(context.sourceUrl); } catch { throw new ListingCaptureError("Source URL is invalid"); }
  if (url.protocol !== "https:" || !["www.realestate.com.au", "lexa.realestate.com.au"].includes(url.hostname) || url.username || url.password) {
    throw new ListingCaptureError("Source URL is outside the observed listing source");
  }
}

function validateResolvedLocalities(value: unknown, context: PageCaptureContext): boolean {
  if (value == null && context.requireResolvedScope === false) return false;
  if (!Array.isArray(value) || value.length !== 1) throw new ListingCaptureError("Expected exactly one resolved search locality");
  const locality = object(value[0], "Resolved locality");
  const display = text(locality.display);
  const match = /^(.+),\s*WA\s+(\d{4})$/i.exec(display);
  const resolvedName = text(locality.name || locality.seoName) || match?.[1];
  if (!match || match[2] !== context.postcode || localityName(resolvedName) !== localityName(context.suburb) ||
      localityName(match[1]) !== localityName(context.suburb) || text(locality.state).toUpperCase() !== "WA") {
    throw new ListingCaptureError(`Resolved search locality does not match ${context.suburb}, WA ${context.postcode}`);
  }
  return true;
}

function sourceRow(listing: ListingProjection, context: PageCaptureContext, ordinal: number): SourceRow {
  const id = text(listing.id);
  const path = text(listing.detailPath);
  if (!/^\d+$/.test(id) || !/^\/sold\/property-[a-z0-9+%-]+-wa-[^/?#]+-\d+$/.test(path) || /-(\d+)$/.exec(path)?.[1] !== id) {
    throw new ListingCaptureError(`Listing ID and canonical path disagree: ${id}`);
  }
  const detailUrl = new URL(path, "https://www.realestate.com.au").href;
  if (listing.detailUrl && listing.detailUrl !== detailUrl) throw new ListingCaptureError(`Canonical URL and path disagree: ${id}`);
  if (localityName(listing.suburb) !== localityName(context.suburb) || text(listing.state).toUpperCase() !== "WA" ||
      text(listing.postcode) !== context.postcode) {
    throw new ListingCaptureError(`Listing ${id} is outside the expected ${context.suburb}, WA ${context.postcode} scope`);
  }
  if (!text(listing.propertyType)) throw new ListingCaptureError(`Listing ${id} has no source property type`);
  const soldDateISO = parseSoldDate(listing.soldDateDisplay);
  const perthCaptureDate = new Date(Date.parse(context.capturedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (soldDateISO > perthCaptureDate) throw new ListingCaptureError(`Listing ${id} has a future sold date`);
  const street = text(listing.shortAddress);
  return {
    sourceUrl: context.sourceUrl,
    pageNumber: String(context.pageNumber),
    ordinalOnPage: String(ordinal),
    price: text(listing.priceDisplay),
    priceValue: disclosedPriceValue(listing.priceDisplay),
    address: street ? `${street}, ${text(listing.suburb)}` : text(listing.suburb),
    detailPath: path,
    detailUrl,
    bedrooms: optionalFeature(listing.bedrooms),
    bathrooms: optionalFeature(listing.bathrooms),
    carSpaces: optionalFeature(listing.carSpaces),
    landSize: [text(listing.landDisplay), text(listing.landUnit)].filter(Boolean).join(" "),
    landSizeSqm: landSizeSqm(listing.landDisplay, listing.landUnit),
    propertyType: text(listing.propertyType),
    soldDate: text(listing.soldDateDisplay),
    soldDateISO,
    scrapedAt: context.capturedAt,
  };
}

function finishPage(input: { totalResultsCount: unknown; pagination: unknown; listings: ListingProjection[]; resolvedLocalities?: unknown; surroundingCount?: unknown; sourceWarnings?: ListingSourceWarnings }, context: PageCaptureContext): CapturedListingPage {
  validateContext(context);
  const resolvedScopeVerified = validateResolvedLocalities(input.resolvedLocalities, context);
  if (input.surroundingCount != null && integer(input.surroundingCount, "Surrounding listing count") !== 0) {
    throw new ListingCaptureError("Surrounding listings returned for an exact-locality capture");
  }
  const totalResultsCount = integer(input.totalResultsCount, "Reported total");
  const rawPagination = object(input.pagination, "Explicit pagination");
  const pagination: CapturePagination = {
    page: integer(rawPagination.page, "Response page", 1),
    maxPageNumberAvailable: integer(rawPagination.maxPageNumberAvailable, "Maximum available page"),
    moreResultsAvailable: rawPagination.moreResultsAvailable as boolean,
  };
  if (typeof pagination.moreResultsAvailable !== "boolean") throw new ListingCaptureError("Explicit moreResultsAvailable flag is required");
  if (pagination.page !== context.pageNumber || (totalResultsCount > 0 && pagination.maxPageNumberAvailable < pagination.page)) {
    throw new ListingCaptureError("Response pagination does not match the requested page");
  }
  const pageSize = context.pageSize ?? 25;
  if (input.listings.length > pageSize || input.listings.length > totalResultsCount ||
      (pagination.moreResultsAvailable && input.listings.length !== pageSize) ||
      (pagination.moreResultsAvailable && pagination.page >= pagination.maxPageNumberAvailable)) {
    throw new ListingCaptureError("Listing count and pagination are inconsistent");
  }
  const rows = input.listings.map((listing, index) => sourceRow(listing, context, index + 1));
  const listingIds = input.listings.map((listing) => text(listing.id));
  if (new Set(listingIds).size !== listingIds.length) throw new ListingCaptureError("Duplicate listing IDs on a response page");
  if (rows.some((row, index) => index > 0 && row.soldDateISO > rows[index - 1].soldDateISO)) {
    throw new ListingCaptureError("Response listings are not sorted by descending sold date");
  }
  if (input.sourceWarnings?.some((warning) => warning.itemIndex >= input.listings.length)) throw new ListingCaptureError("Source warning references an unavailable listing");
  return {
    schemaVersion: 1, scope: { suburb: context.suburb, postcode: context.postcode, state: "WA", propertyType: "House" },
    sourceUrl: context.sourceUrl, pageNumber: context.pageNumber, pageSize, capturedAt: context.capturedAt,
    totalResultsCount, pagination, resolvedScopeVerified, listings: input.listings, listingIds, rows,
    ...(input.sourceWarnings ? { sourceWarnings: input.sourceWarnings } : {}),
  };
}

/** Adapt only the required fields; tracking, challenge headers and agent contact data are not retained. */
export function adaptListingPage(response: unknown, context: PageCaptureContext): CapturedListingPage {
  const payload = object(response, "GraphQL response");
  const sourceWarnings = listingSourceWarnings(payload.errors, "GraphQL response");
  const search = object(object(payload.data, "GraphQL data").soldSearch, "Sold search");
  const results = object(search.results, "Sold results");
  const exact = object(results.exact, "Exact results");
  if (!Array.isArray(exact.items)) throw new ListingCaptureError("Exact result items are missing");
  const resolved = object(search.resolvedQuery, "Resolved query");
  let surroundingCount = 0;
  if (results.surrounding != null) {
    const surrounding = object(results.surrounding, "Surrounding results");
    if (!Array.isArray(surrounding.items)) throw new ListingCaptureError("Surrounding result items are invalid");
    surroundingCount = surrounding.items.length;
  }
  const listings = exact.items.map((item): ListingProjection => {
    const listing = object(object(item, "Result item").listing, "Listing");
    const address = object(listing.address, "Listing address");
    const addressDisplay = object(address.display, "Address display");
    const features = listing.generalFeatures == null ? {} : object(listing.generalFeatures, "General features");
    const sizes = listing.propertySizes == null ? {} : object(listing.propertySizes, "Property sizes");
    const land = sizes.land == null ? {} : object(sizes.land, "Land size");
    const unit = land.sizeUnit == null ? {} : object(land.sizeUnit, "Land unit");
    const canonical = object(object(listing._links, "Listing links").canonical, "Canonical link");
    const featureValue = (key: string) => features[key] == null ? null : object(features[key], `${key} feature`).value as string | number | null;
    return {
      id: text(listing.id), shortAddress: text(addressDisplay.shortAddress), suburb: text(address.suburb),
      state: text(address.state), postcode: text(address.postcode),
      priceDisplay: text(object(listing.price, "Price display").display),
      soldDateDisplay: text(object(listing.dateSold, "Sold date display").display),
      propertyType: text(object(listing.propertyType, "Property type").display),
      bedrooms: featureValue("bedrooms"), bathrooms: featureValue("bathrooms"), carSpaces: featureValue("parkingSpaces"),
      landDisplay: text(land.displayValue), landUnit: text(unit.displayValue),
      detailPath: text(canonical.path), detailUrl: text(canonical.href),
    };
  });
  return finishPage({ totalResultsCount: results.totalResultsCount, pagination: results.pagination, listings,
    resolvedLocalities: resolved.localities, surroundingCount, sourceWarnings }, context);
}

/** Accept the response projection emitted by a Chrome transport, including earlier row-array archives. */
export function adaptProjectedPage(page: unknown, columns: readonly string[], context: PageCaptureContext): CapturedListingPage {
  const input = object(page, "Projected page");
  const sourceWarnings = listingSourceWarnings(input.errors, "Projected response with GraphQL") ?? retainedSourceWarnings(input.sourceWarnings);
  if (!Array.isArray(input.rows)) throw new ListingCaptureError("Projected rows are missing");
  if (new Set(columns).size !== columns.length || LISTING_PROJECTION_COLUMNS.some((column) => !columns.includes(column))) {
    throw new ListingCaptureError("Projection columns do not include the required listing fields");
  }
  const listings = input.rows.map((row): ListingProjection => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new ListingCaptureError("Projected row does not match its columns");
    if (row.some((value) => value != null && typeof value !== "number" && typeof value !== "string")) throw new ListingCaptureError("Projected listing fields must be scalar values");
    return Object.fromEntries(columns.map((column, index) => [column, row[index]])) as ListingProjection;
  });
  return finishPage({ totalResultsCount: input.totalResultsCount, pagination: input.pagination, listings,
    resolvedLocalities: input.resolvedLocalities, surroundingCount: input.surroundingCount, sourceWarnings }, context);
}

export type SliceCaptureSummary = {
  status: "complete" | "partial" | "capped" | "failed";
  complete: boolean;
  problems: string[];
  reportedTotal: number | null;
  capturedRows: number;
  uniqueListingIds: number;
  capturedPages: number[];
  terminalPageReached: boolean;
  resolvedScopeVerified: boolean;
  numericPriceCount: number;
  blankPriceCount: number;
  houseRowCount: number;
  nonHouseRowCount: number;
  houseNumericPriceCount: number;
  soldDateFrom: string | null;
  onOrAfterCutoffCount: number;
  beforeCutoffCount: number;
  houseOnOrAfterCutoffCount: number;
  nonHouseOnOrAfterCutoffCount: number;
  dateRange: { from: string; to: string } | null;
};

/** Completion requires every page, a terminal response and reconciliation to the source total. */
export function validateSliceCapture(pages: readonly CapturedListingPage[], options: CaptureScope & { soldDateFrom?: string; maxPages?: number; failure?: string }): SliceCaptureSummary {
  if (options.maxPages != null) integer(options.maxPages, "Configured page cap", 1);
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const problems: string[] = [];
  const allRows = ordered.flatMap((page) => page.rows);
  const allIds = ordered.flatMap((page) => page.listingIds);
  const uniqueListingIds = new Set(allIds).size;
  const reportedTotal = ordered[0]?.totalResultsCount ?? null;
  const terminalPageReached = ordered.length > 0 && !ordered.at(-1)!.pagination.moreResultsAvailable;
  const resolvedScopeVerified = ordered.length > 0 && ordered.every((page) => page.resolvedScopeVerified);
  if (!ordered.length) problems.push("No validated pages captured");
  if (ordered.some((page, index) => page.pageNumber !== index + 1)) problems.push("Pages are missing, duplicated or do not start at page one");
  if (ordered.some((page) => localityName(page.scope.suburb) !== localityName(options.suburb) || page.scope.postcode !== options.postcode)) problems.push("Captured pages have inconsistent locality scope");
  if (ordered.some((page) => page.totalResultsCount !== reportedTotal)) problems.push("Reported total changed between pages");
  if (ordered.some((page) => page.pageSize !== ordered[0].pageSize || page.pagination.maxPageNumberAvailable !== ordered[0].pagination.maxPageNumberAvailable)) problems.push("Pagination contract changed between pages");
  if (ordered.slice(0, -1).some((page) => !page.pagination.moreResultsAvailable)) problems.push("Pages continue after an earlier terminal response");
  if (!terminalPageReached) problems.push("Explicit terminal pagination has not been reached");
  if (uniqueListingIds !== allIds.length) problems.push("Listing IDs overlap between response pages");
  if (reportedTotal !== uniqueListingIds) problems.push("Unique captured listing count does not match the reported total");
  if (!resolvedScopeVerified) problems.push("Resolved locality scope is unverified");
  if (allRows.some((row, index) => index > 0 && row.soldDateISO > allRows[index - 1].soldDateISO)) problems.push("Sold dates are not descending across page boundaries");
  if (options.failure) problems.push(options.failure);
  const configuredCapReached = !terminalPageReached && options.maxPages != null && ordered.length >= options.maxPages;
  const sourceCapacity = ordered.length ? ordered[0].pagination.maxPageNumberAvailable * ordered[0].pageSize : null;
  const sourceCapObserved = reportedTotal != null && sourceCapacity != null && reportedTotal > sourceCapacity;
  const sourceCapReached = sourceCapObserved && ordered.at(-1)!.pageNumber >= ordered[0].pagination.maxPageNumberAvailable;
  if (configuredCapReached) problems.push(`Capture stopped at configured ${options.maxPages}-page cap`);
  if (sourceCapObserved) problems.push(`Source pagination exposes at most ${sourceCapacity} listings of ${reportedTotal} reported`);
  const capped = configuredCapReached || sourceCapReached;
  const cutoff = options.soldDateFrom ?? null;
  if (cutoff && (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || !Number.isFinite(Date.parse(`${cutoff}T00:00:00Z`)) || new Date(`${cutoff}T00:00:00Z`).toISOString().slice(0, 10) !== cutoff)) {
    throw new ListingCaptureError("Comparison sold-date cutoff is invalid");
  }
  const onOrAfterCutoffCount = allRows.filter((row) => !cutoff || row.soldDateISO >= cutoff).length;
  const numericPriceCount = allRows.filter((row) => row.priceValue !== "").length;
  const houseRows = allRows.filter((row) => row.propertyType.toLowerCase() === "house");
  const houseOnOrAfterCutoffCount = houseRows.filter((row) => !cutoff || row.soldDateISO >= cutoff).length;
  const dates = allRows.map((row) => row.soldDateISO).sort();
  const complete = problems.length === 0;
  return {
    status: complete ? "complete" : !ordered.length ? "failed" : capped ? "capped" : "partial",
    complete, problems, reportedTotal, capturedRows: allRows.length, uniqueListingIds,
    capturedPages: ordered.map((page) => page.pageNumber), terminalPageReached, resolvedScopeVerified,
    numericPriceCount, blankPriceCount: allRows.length - numericPriceCount,
    houseRowCount: houseRows.length, nonHouseRowCount: allRows.length - houseRows.length,
    houseNumericPriceCount: houseRows.filter((row) => row.priceValue !== "").length,
    soldDateFrom: cutoff, onOrAfterCutoffCount, beforeCutoffCount: allRows.length - onOrAfterCutoffCount,
    houseOnOrAfterCutoffCount, nonHouseOnOrAfterCutoffCount: onOrAfterCutoffCount - houseOnOrAfterCutoffCount,
    dateRange: dates.length ? { from: dates[0], to: dates.at(-1)! } : null,
  };
}

export function serialiseCaptureCsv(rows: readonly SourceRow[]): string {
  const cell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${SOURCE_COLUMNS.join(",")}\n${rows.map((row) => SOURCE_COLUMNS.map((column) => cell(row[column])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
}
