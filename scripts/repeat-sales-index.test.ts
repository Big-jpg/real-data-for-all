import { describe, expect, it } from "vitest";
import { createAnnualRepeatSalesDataset, exactSuburbDeletionSensitivity, fitRepeatSales, type RepeatSalePair } from "./repeat-sales-index";

function fixture(): RepeatSalePair[] {
  const rows: RepeatSalePair[] = [];
  for (let property = 0; property < 12; property++) {
    const property_key = property.toString(16).padStart(64, "0");
    rows.push(
      { property_key, suburb: property % 2 ? "Alpha" : "Beta", postcode: "6000", property_type: "House", bedrooms: 3, bathrooms: 1, car_spaces: 1, land_size_sqm: 400,
        earlier_sold_date: "2019-01-01", later_sold_date: "2020-01-01", earlier_price_aud: 90000, later_price_aud: 100000, holding_days: 365 },
      { property_key, suburb: property % 2 ? "Alpha" : "Beta", postcode: "6000", property_type: "House", bedrooms: 3, bathrooms: 1, car_spaces: 1, land_size_sqm: 400,
        earlier_sold_date: "2020-01-01", later_sold_date: "2021-01-01", earlier_price_aud: 100000, later_price_aud: 110000, holding_days: 365 },
      { property_key, suburb: property % 2 ? "Alpha" : "Beta", postcode: "6000", property_type: "House", bedrooms: 3, bathrooms: 1, car_spaces: 1, land_size_sqm: 400,
        earlier_sold_date: "2019-01-01", later_sold_date: "2021-01-01", earlier_price_aud: 90000, later_price_aud: 110000, holding_days: 731 },
    );
  }
  return rows;
}

describe("annual repeat-sales regression", () => {
  it("recovers annual relative levels with a fixed 2020 reference", () => {
    const fit = fitRepeatSales(fixture(), 0);
    expect(fit.referenceYear).toBe(2020);
    expect(fit.designRank).toBe(fit.designColumns);
    expect(fit.pairCount).toBe(36);
    expect(fit.informativeCrossYearPairCount).toBe(36);
    expect(fit.uniqueContributingProperties).toBe(12);
    expect(fit.annualIndex.find((row) => row.year === 2019)?.index).toBeCloseTo(90, 6);
    expect(fit.annualIndex.find((row) => row.year === 2020)?.index).toBe(100);
    expect(fit.annualIndex.find((row) => row.year === 2021)?.index).toBeCloseTo(110, 6);
  });

  it("applies holding-period and latest-endpoint sensitivity filters", () => {
    const rows = fixture();
    rows.push({
      property_key: "f".repeat(64), suburb: "Sample", postcode: "6000", property_type: "House", bedrooms: 3, bathrooms: 1, car_spaces: 1, land_size_sqm: 400,
      earlier_sold_date: "2020-01-01", later_sold_date: "2022-01-01",
      earlier_price_aud: 100000, later_price_aud: 110000, holding_days: 731,
    });
    const full = fitRepeatSales(rows, 0);
    const minimumYear = fitRepeatSales(rows, 365);
    const through2021 = fitRepeatSales(rows, 0, { maxEndpointYear: 2021 });
    expect(full.pairCount).toBe(37);
    expect(minimumYear.pairCount).toBe(37);
    expect(through2021.pairCount).toBe(36);
  });

  it("excludes same-year zero-design rows from coefficient and CR1 pair degrees of freedom", () => {
    const rows = fixture();
    rows.push({
      ...rows[0], property_key: "e".repeat(64), earlier_sold_date: "2019-01-01", later_sold_date: "2019-12-01",
      earlier_price_aud: 90000, later_price_aud: 95000, holding_days: 334,
    });
    const fit = fitRepeatSales(rows, 0);
    expect(fit.pairCount).toBe(37);
    expect(fit.informativeCrossYearPairCount).toBe(36);
    expect(fit.sameCalendarYearDiagnosticPairCount).toBe(1);
    expect(fit.uniqueContributingProperties).toBe(12);
    expect(fit.cr1Correction.used).not.toBe(fit.cr1Correction.ifSameYearRowsWereIncorrectlyCounted);
    expect(fit.cr1Correction.used).toBeGreaterThan(fit.cr1Correction.ifSameYearRowsWereIncorrectlyCounted);
  });

  it("converges to a robust solution while retaining the same model rank", () => {
    const rows = fixture();
    rows.push({
      ...rows[0], property_key: "d".repeat(64), earlier_sold_date: "2020-01-01", later_sold_date: "2021-01-01",
      earlier_price_aud: 10000, later_price_aud: 10000000, holding_days: 366,
    });
    const robust = fitRepeatSales(rows, 0, { robust: true });
    expect(robust.robustFit?.convergence.converged).toBe(true);
    expect(robust.robustFit?.convergence.iterations).toBeLessThanOrEqual(1000);
    expect(robust.designRank).toBe(robust.designColumns);
    expect(Number.isFinite(robust.annualIndex.find((row) => row.year === 2021)?.index)).toBe(true);
  });

  it("performs exact suburb refits after removing all pairs for each selected property cohort", () => {
    const result = exactSuburbDeletionSensitivity(fixture(), 1);
    expect(result).toHaveLength(1);
    expect(result[0].suburb).toBe("Alpha");
    expect(result[0].excludedProperties).toBe(6);
    expect(result[0].excludedPairs).toBe(18);
    expect(result[0].refitPairs).toBe(18);
    expect(result[0].designRank).toBe(result[0].designColumns);
    expect(result[0].maxAbsoluteIndexDifferencePoints).toBeCloseTo(0, 10);
  });

  it("builds the four reproducible 2009–2025 release series with source metadata", () => {
    const medians = Array.from({ length: 18 }, (_, offset) => ({
      year: 2008 + offset,
      sale_count: 100 + offset,
      median_price_aud: 100000 + offset * 1000,
    }));
    const rows: RepeatSalePair[] = Array.from({ length: 12 }, (_, property) => property).flatMap((property) =>
      Array.from({ length: 17 }, (_, offset) => {
        const year = 2008 + offset;
        const price = 100000 * 1.03 ** offset;
        return {
          property_key: property.toString(16).padStart(64, "0"),
          suburb: property % 2 ? "Alpha" : "Beta",
          postcode: "6000",
          property_type: "House",
          bedrooms: 3,
          bathrooms: 1,
          car_spaces: 1,
          land_size_sqm: 400,
          earlier_sold_date: `${year}-01-01`,
          later_sold_date: `${year + 1}-01-01`,
          earlier_price_aud: price,
          later_price_aud: price * 1.03,
          holding_days: year % 4 === 0 ? 366 : 365,
        };
      }),
    );
    const records = createAnnualRepeatSalesDataset(rows, medians, "snapshot_12345678", "2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z");
    expect(records).toHaveLength(68);
    expect(new Set(records.map((row) => row.series_key)).size).toBe(4);
    expect(records.every((row) => row.model_version === "annual-repeat-sales-v1" && row.source_snapshot_id === "snapshot_12345678")).toBe(true);
    expect(records.find((row) => row.series_key === "repeat_sales_ols_untrimmed" && row.observation_year === 2020)?.index_level).toBeCloseTo(100, 10);
    expect(records.find((row) => row.series_key === "annual_median_price" && row.observation_year === 2020)?.index_level).toBe(100);
  });
});
