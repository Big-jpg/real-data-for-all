import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adaptListingPage, adaptProjectedPage, disclosedPriceValue, landSizeSqm, LISTING_PROJECTION_COLUMNS,
  parseSoldDate, serialiseCaptureCsv, validateSliceCapture, type PageCaptureContext,
} from "./rea-listing-capture";
import { parseSourceCsv } from "./source";

const context: PageCaptureContext = {
  suburb: "Hocking", postcode: "6065", pageNumber: 1, capturedAt: "2026-10-11T16:59:49.486Z",
  sourceUrl: "https://www.realestate.com.au/sold/property-house-in-hocking,+wa+6065/list-1?includeSurrounding=false&maxSoldAge=6-month&activeSort=solddate",
};
const resolvedLocalities = [{ name: "Hocking", seoName: "Hocking", display: "Hocking, WA 6065", state: "WA" }];
const row = ["152180832", "43 Majorca Elbow", "Hocking", "WA", "6065", "$1,100,000", "13 Sep 2026", "House", 4, 2, 2, "426", "m²", "/sold/property-house-wa-hocking-152180832"];
const projectedPage = (overrides: Record<string, unknown> = {}) => ({
  totalResultsCount: 1, pagination: { page: 1, maxPageNumberAvailable: 1, moreResultsAvailable: false },
  rows: [row], resolvedLocalities, surroundingCount: 0, ...overrides,
});
const rawResponse = () => ({ data: { soldSearch: {
  resolvedQuery: { localities: resolvedLocalities },
  results: {
    totalResultsCount: 1, pagination: { page: 1, maxPageNumberAvailable: 1, moreResultsAvailable: false },
    surrounding: null,
    exact: { items: [{ listing: {
      id: "152180832", address: { display: { shortAddress: "43 Majorca Elbow", fullAddress: "43 Majorca Elbow, Hocking, WA 6065" }, suburb: "Hocking", state: "WA", postcode: "6065" },
      price: { display: "$1,100,000", hiddenNumericPrice: 9999999 }, dateSold: { display: "13 Sep 2026" },
      propertyType: { display: "House" }, generalFeatures: { bedrooms: { value: 4 }, bathrooms: { value: 2 }, parkingSpaces: { value: 2 } },
      propertySizes: { land: { displayValue: "426", sizeUnit: { displayValue: "m²" } } },
      _links: { canonical: { path: "/sold/property-house-wa-hocking-152180832", href: "https://www.realestate.com.au/sold/property-house-wa-hocking-152180832" } },
      listingCompany: { secretOrUnneededField: "not retained" },
    } }] },
  },
} } });

describe("Chrome sold listing response capture", () => {
  it("adapts the observed fields and round-trips the existing 17-column ingestion contract", () => {
    const page = adaptListingPage(rawResponse(), context);
    expect(page.resolvedScopeVerified).toBe(true);
    expect(page.rows[0]).toMatchObject({
      address: "43 Majorca Elbow, Hocking", price: "$1,100,000", priceValue: "1100000", soldDateISO: "2026-09-13",
      landSize: "426 m²", landSizeSqm: "426", scrapedAt: context.capturedAt, pageNumber: "1", ordinalOnPage: "1",
    });
    expect(page.listings[0]).not.toHaveProperty("listingCompany");
    const csv = serialiseCaptureCsv(page.rows);
    const observations = parseSourceCsv(Buffer.from(csv));
    expect(observations[0].values).toEqual(page.rows[0]);
    expect(parseSourceCsv(Buffer.from(csv))[0].observationKey).toBe(observations[0].observationKey);
  });

  it("rejects partial GraphQL responses even when data is present", () => {
    expect(() => adaptListingPage({ ...rawResponse(), errors: [{ message: "Failed part of search" }] }, context)).toThrow("GraphQL response contains errors");
    expect(() => adaptProjectedPage(projectedPage({ errors: [{ message: "Failed" }] }), LISTING_PROJECTION_COLUMNS, context)).toThrow("contains errors");
  });

  it("tolerates only errors on an exact uncollected listers field and retains safe warning paths", () => {
    const path = ["soldSearch", "results", "exact", "items", 0, "listing", "listers"];
    const page = adaptListingPage({ ...rawResponse(), errors: [{ message: "Data unavailable", path }] }, context);
    expect(page.rows[0].priceValue).toBe("1100000");
    expect(page.sourceWarnings).toEqual([{ field: "listers", itemIndex: 0, message: "Source agent data unavailable; outside collected fields" }]);
    expect(validateSliceCapture([page], context).complete).toBe(true);
    expect(adaptProjectedPage(projectedPage({ sourceWarnings: page.sourceWarnings }), LISTING_PROJECTION_COLUMNS, context).sourceWarnings).toEqual(page.sourceWarnings);
  });

  it.each([
    ["soldSearch", "results", "exact", "items", 0, "listing", "price"],
    ["soldSearch", "results", "exact", "items", 0, "listing", "dateSold"],
    ["soldSearch", "resolvedQuery", "localities"],
    ["soldSearch", "results", "exact", "items", 0, "listing", "listers", "name"],
    ["soldSearch", "results", "exact", "items", -1, "listing", "listers"],
    ["soldSearch", "results", "exact", "items", "0", "listing", "listers"],
    ["soldSearch"],
  ])("rejects errors outside the exact uncollected field whitelist: %s", (...path: (string | number)[]) => {
    expect(() => adaptListingPage({ ...rawResponse(), errors: [{ message: "Data unavailable", path }] }, context)).toThrow("contains errors");
  });

  it("rejects mixed errors, missing required values and out-of-range lister warning indexes", () => {
    const listersPath = ["soldSearch", "results", "exact", "items", 0, "listing", "listers"];
    const pricePath = ["soldSearch", "results", "exact", "items", 0, "listing", "price"];
    expect(() => adaptListingPage({ ...rawResponse(), errors: [{ path: listersPath }, { path: pricePath }] }, context)).toThrow("contains errors");
    expect(() => adaptListingPage({ ...rawResponse(), errors: [{ path: ["soldSearch", "results", "exact", "items", 1, "listing", "listers"] }] }, context)).toThrow("unavailable listing");
    const response = rawResponse(); response.data.soldSearch.results.exact.items[0].listing.dateSold.display = "";
    expect(() => adaptListingPage({ ...response, errors: [{ path: listersPath }] }, context)).toThrow("sold date");
  });

  it("rejects locality resolution redirects and unknown search scopes", () => {
    expect(() => adaptProjectedPage(projectedPage({ resolvedLocalities: [{ name: "Perth", display: "Perth, WA 6000", state: "WA" }] }), LISTING_PROJECTION_COLUMNS, context)).toThrow("Resolved search locality");
    expect(() => adaptProjectedPage(projectedPage({ resolvedLocalities: [] }), LISTING_PROJECTION_COLUMNS, context)).toThrow("exactly one resolved");
    expect(() => adaptProjectedPage(projectedPage({ surroundingCount: 3 }), LISTING_PROJECTION_COLUMNS, context)).toThrow("Surrounding listings");
  });

  it.each([
    [2, "Joondalup"], [3, "VIC"], [4, "6000"], [7, ""], [0, "999999999"],
    [13, "/sold/property-house-wa-hocking-999999999"],
  ])("rejects an out-of-scope or inconsistent listing field %s", (index: number, value: string) => {
    const changed = [...row]; changed[index] = value;
    expect(() => adaptProjectedPage(projectedPage({ rows: [changed] }), LISTING_PROJECTION_COLUMNS, context)).toThrow();
  });

  it("rejects canonical href disagreement and future sale dates", () => {
    const response = rawResponse();
    response.data.soldSearch.results.exact.items[0].listing._links.canonical.href = "https://example.test/sold/152180832";
    expect(() => adaptListingPage(response, context)).toThrow("Canonical URL and path disagree");
    const future = [...row]; future[6] = "13 Oct 2026";
    expect(() => adaptProjectedPage(projectedPage({ rows: [future] }), LISTING_PROJECTION_COLUMNS, context)).toThrow("future sold date");
  });

  it("requires explicit, matching and plausible pagination", () => {
    expect(() => adaptProjectedPage(projectedPage({ pagination: undefined }), LISTING_PROJECTION_COLUMNS, context)).toThrow("Explicit pagination");
    expect(() => adaptProjectedPage(projectedPage({ pagination: { page: 2, maxPageNumberAvailable: 2, moreResultsAvailable: false } }), LISTING_PROJECTION_COLUMNS, context)).toThrow("requested page");
    expect(() => adaptProjectedPage(projectedPage({ pagination: { page: 1, maxPageNumberAvailable: 1 } }), LISTING_PROJECTION_COLUMNS, context)).toThrow("moreResultsAvailable");
    expect(() => adaptProjectedPage(projectedPage({ totalResultsCount: 34, pagination: { page: 1, maxPageNumberAvailable: 2, moreResultsAvailable: true } }), LISTING_PROJECTION_COLUMNS, context)).toThrow("count and pagination");
  });

  it("rejects duplicate IDs and descending-sort violations before accepting a page", () => {
    expect(() => adaptProjectedPage(projectedPage({ rows: [row, row], totalResultsCount: 2 }), LISTING_PROJECTION_COLUMNS, context)).toThrow("Duplicate listing IDs");
    const later = [...row]; later[0] = "150527112"; later[6] = "24 Sep 2026"; later[13] = "/sold/property-house-wa-hocking-150527112";
    expect(() => adaptProjectedPage(projectedPage({ rows: [row, later], totalResultsCount: 2 }), LISTING_PROJECTION_COLUMNS, context)).toThrow("descending sold date");
  });

  it("treats missing resolved-scope evidence as incomplete on historical projections", () => {
    const page = adaptProjectedPage(projectedPage({ resolvedLocalities: undefined }), LISTING_PROJECTION_COLUMNS, { ...context, requireResolvedScope: false });
    expect(page.resolvedScopeVerified).toBe(false);
    expect(validateSliceCapture([page], context)).toMatchObject({ status: "partial", complete: false, resolvedScopeVerified: false });
  });

  it("requires a valid fixed UTC timestamp and source URL", () => {
    expect(() => adaptProjectedPage(projectedPage(), LISTING_PROJECTION_COLUMNS, { ...context, capturedAt: "" })).toThrow("timestamp");
    expect(() => adaptProjectedPage(projectedPage(), LISTING_PROJECTION_COLUMNS, { ...context, capturedAt: "2026-02-30T12:00:00.000Z" })).toThrow("calendar date");
    expect(() => adaptProjectedPage(projectedPage(), LISTING_PROJECTION_COLUMNS, { ...context, sourceUrl: "https://example.test" })).toThrow("source");
  });

  it("retains undisclosed display text without using hidden numeric price fields", () => {
    const response = rawResponse(); response.data.soldSearch.results.exact.items[0].listing.price.display = "Contact agent";
    expect(adaptListingPage(response, context).rows[0]).toMatchObject({ price: "Contact agent", priceValue: "" });
  });

  it("retains actual Other listings returned by a House-filter search without losing pagination coverage", () => {
    const other = [...row]; other[0] = "150560108"; other[7] = "Other"; other[13] = "/sold/property-other-wa-hocking-150560108";
    const page = adaptProjectedPage(projectedPage({ rows: [other] }), LISTING_PROJECTION_COLUMNS, context);
    expect(page.scope.propertyType).toBe("House");
    expect(page.rows[0].propertyType).toBe("Other");
    const summary = validateSliceCapture([page], { ...context, soldDateFrom: "2026-06-01" });
    expect(summary).toMatchObject({ status: "complete", capturedRows: 1, houseRowCount: 0, nonHouseRowCount: 1,
      houseNumericPriceCount: 0, onOrAfterCutoffCount: 1, houseOnOrAfterCutoffCount: 0, nonHouseOnOrAfterCutoffCount: 1 });
  });

  it("keeps House cohort counts separate from all source result totals", () => {
    const other = [...row]; other[0] = "150560108"; other[7] = "Other"; other[13] = "/sold/property-other-wa-hocking-150560108";
    const page = adaptProjectedPage(projectedPage({ rows: [row, other], totalResultsCount: 2 }), LISTING_PROJECTION_COLUMNS, context);
    expect(validateSliceCapture([page], { ...context, soldDateFrom: "2026-06-01" })).toMatchObject({ status: "complete", capturedRows: 2,
      houseRowCount: 1, nonHouseRowCount: 1, numericPriceCount: 2, houseNumericPriceCount: 1, houseOnOrAfterCutoffCount: 1, nonHouseOnOrAfterCutoffCount: 1 });
  });

  it("preserves a newly encountered source type rather than coercing it or failing the whole page", () => {
    const warehouse = [...row]; warehouse[7] = "Warehouse"; warehouse[13] = "/sold/property-warehouse-wa-hocking-152180832";
    const page = adaptProjectedPage(projectedPage({ rows: [warehouse] }), LISTING_PROJECTION_COLUMNS, context);
    expect(page.rows[0].propertyType).toBe("Warehouse");
    expect(validateSliceCapture([page], context)).toMatchObject({ complete: true, houseRowCount: 0, nonHouseRowCount: 1 });
  });

  it("reconciles the actual two-page Hocking capture and keeps all six-month observations", () => {
    const archive = JSON.parse(readFileSync(new URL("../../deliverables/build-review-2026-10-12/hocking-listing-capture.json", import.meta.url), "utf8"));
    const pages = archive.pages.map((page: { pageNumber: number; capturedAt: string }) => adaptProjectedPage({ ...page, resolvedLocalities }, archive.columns, { ...context, pageNumber: page.pageNumber, capturedAt: page.capturedAt }));
    const summary = validateSliceCapture(pages, { ...context, soldDateFrom: "2026-06-01" });
    expect(summary).toMatchObject({ status: "complete", complete: true, reportedTotal: 34, capturedRows: 34, uniqueListingIds: 34,
      terminalPageReached: true, capturedPages: [1, 2], onOrAfterCutoffCount: 23, beforeCutoffCount: 11, numericPriceCount: 32, blankPriceCount: 2 });
    expect(summary.dateRange).toEqual({ from: "2026-04-17", to: "2026-09-24" });
    expect(validateSliceCapture([pages[0]], { ...context, maxPages: 1 })).toMatchObject({ status: "capped", complete: false, capturedRows: 25 });
    expect(validateSliceCapture([pages[1]], context)).toMatchObject({ status: "partial", complete: false });
    expect(validateSliceCapture([], { ...context, failure: "Chrome returned a challenge" })).toMatchObject({ status: "failed", complete: false });
    expect(validateSliceCapture(pages, { ...context, failure: "A late transport error" })).toMatchObject({ status: "partial", complete: false });
    expect(validateSliceCapture([pages[0], pages[0], pages[1]], context).problems).toContain("Listing IDs overlap between response pages");
    expect(validateSliceCapture([{ ...pages[0], totalResultsCount: 35 }, pages[1]], context).problems).toContain("Reported total changed between pages");
  });

  it("accepts an explicitly empty scoped terminal response", () => {
    const page = adaptProjectedPage(projectedPage({ rows: [], totalResultsCount: 0, pagination: { page: 1, maxPageNumberAvailable: 0, moreResultsAvailable: false } }), LISTING_PROJECTION_COLUMNS, context);
    expect(validateSliceCapture([page], context)).toMatchObject({ status: "complete", capturedRows: 0, reportedTotal: 0, terminalPageReached: true });
  });

  it("labels an observed source cap incomplete even when the capped page says terminal", () => {
    const page = adaptProjectedPage(projectedPage({ totalResultsCount: 2 }), LISTING_PROJECTION_COLUMNS, { ...context, pageSize: 1 });
    const summary = validateSliceCapture([page], context);
    expect(summary).toMatchObject({ status: "capped", complete: false, terminalPageReached: true, capturedRows: 1, reportedTotal: 2 });
    expect(summary.problems).toContain("Source pagination exposes at most 1 listings of 2 reported");
  });
});

describe("sale value parsing", () => {
  it.each(["Contact agent", "$900,000 - $950,000", "Offers over $1,000,000", "$1,10,000", "1000000", "", "$0"])("leaves %s out of numeric price metrics", (display: string) => {
    expect(disclosedPriceValue(display)).toBe("");
  });
  it("parses only exact disclosed dollar amounts", () => {
    expect(disclosedPriceValue("$1,100,000")).toBe("1100000");
    expect(disclosedPriceValue("$1100000")).toBe("1100000");
    expect(disclosedPriceValue("$1,100,000.50")).toBe("1100000.5");
  });
  it("validates calendar dates instead of normalising invalid dates", () => {
    expect(parseSoldDate("29 Feb 2024")).toBe("2024-02-29");
    expect(parseSoldDate("08 September 2026")).toBe("2026-09-08");
    expect(() => parseSoldDate("29 Feb 2026")).toThrow("Invalid sold date");
    expect(() => parseSoldDate("31 Apr 2026")).toThrow("Invalid sold date");
    expect(() => parseSoldDate("Yesterday")).toThrow("Unrecognised sold date");
  });
  it("does not silently convert other land units or ranges to square metres", () => {
    expect(landSizeSqm("1,012.5", "m²")).toBe("1012.5");
    expect(landSizeSqm("2", "ha")).toBe("");
    expect(landSizeSqm("500 - 600", "m²")).toBe("");
  });
});
