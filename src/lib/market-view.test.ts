import { describe, expect, it } from "vitest";
import { datesFor, monthlyData, variance, type SaleRow } from "./market-view";

function saleRow(overrides: Partial<SaleRow>): SaleRow {
  return {
    suburb: "Hocking",
    postcode: "6065",
    sale_month: "2026-04-01",
    sale_count: "4",
    median_price_aud: null,
    average_price_aud: null,
    minimum_price_aud: null,
    maximum_price_aud: null,
    ...overrides,
  };
}

describe("market view data contracts", () => {
  it("changes the completed-month window at midnight in Perth", () => {
    expect(datesFor(6, new Date("2026-09-30T15:59:59Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-08-31",
    });
    expect(datesFor(6, new Date("2026-09-30T16:30:00Z"))).toEqual({
      from: "2026-04-01",
      to: "2026-09-30",
    });
  });

  it("retains complete leap months and crosses the year boundary", () => {
    expect(datesFor(6, new Date("2024-02-29T16:00:00Z"))).toEqual({
      from: "2023-09-01",
      to: "2024-02-29",
    });
    expect(datesFor(12, new Date("2025-12-31T16:00:00Z"))).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("distinguishes an absent month from recorded sales with undisclosed prices", () => {
    const data = monthlyData(
      [saleRow({ sale_month: "2026-05-01", sale_count: "3" }), saleRow({})],
      { from: "2026-04-01", to: "2026-06-30" },
    );

    expect(data.map(({ month }) => month)).toEqual([
      "2026-04-01", "2026-05-01", "2026-06-01",
    ]);
    expect(data[0]).toMatchObject({ sales: 4, median: null, average: null, observed: true });
    expect(data[1]).toMatchObject({ sales: 3, median: null, average: null, observed: true });
    expect(data[2]).toMatchObject({ sales: 0, median: null, average: null, observed: false });
  });

  it("uses server-calculated prices without replacing a recorded zero count", () => {
    const [pricedMonth, zeroMonth] = monthlyData(
      [saleRow({
        median_price_aud: "995000",
        average_price_aud: "1005000",
        minimum_price_aud: "900000",
        maximum_price_aud: "1200000",
      }), saleRow({ sale_month: "2026-05-01", sale_count: "0" })],
      { from: "2026-04-01", to: "2026-05-31" },
    );

    expect(pricedMonth).toMatchObject({
      sales: 4,
      median: 995000,
      average: 1005000,
      minimum: 900000,
      maximum: 1200000,
      observed: true,
    });
    expect(zeroMonth).toMatchObject({ sales: 0, median: null, average: null, observed: true });
  });

  it("keeps the selected axis when all supplied rows are outside its range", () => {
    const data = monthlyData(
      [saleRow({ sale_month: "2025-12-01", median_price_aud: "1000000" })],
      { from: "2026-01-01", to: "2026-02-28" },
    );

    expect(data.map(({ month, sales, median, average, observed }) => ({
      month, sales, median, average, observed,
    }))).toEqual([
      { month: "2026-01-01", sales: 0, median: null, average: null, observed: false },
      { month: "2026-02-01", sales: 0, median: null, average: null, observed: false },
    ]);
  });

  it("leaves unavailable comparisons undefined while allowing a current zero", () => {
    expect(variance("12", "0")).toBeNull();
    expect(variance("12", null)).toBeNull();
    expect(variance(null, "12")).toBeNull();
    expect(variance("12", "")).toBeNull();
    expect(variance("0", "12")).toBe(-100);
    expect(variance("15", "12")).toBe(25);
  });
});
