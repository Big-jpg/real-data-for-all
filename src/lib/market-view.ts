export type Value = number | string | null;
export type DateRange = { from: string; to: string };
export type BedroomFilter = "all" | "1" | "2" | "3" | "4" | "5" | "6";
export type SnapshotTheme = "warm" | "corporate" | "excel" | "presentation";
export type Suburb = { suburb_key: string; suburb: string; canonical_postcode: string; sale_count: number | string };
export type SaleRow = { suburb: string; postcode: string; sale_month: string; sale_count: number | string; median_price_aud: Value; average_price_aud: Value; minimum_price_aud: Value; maximum_price_aud: Value };
export type Segment = { segment_label: string | number; sale_count: number | string; median_price_aud: Value };
export type Rolling = { current_from: string; current_to: string; prior_from: string; prior_to: string; current_sale_count: number | string; current_priced_sales: number | string; current_median_price_aud: Value; prior_sale_count: number | string; prior_priced_sales: number | string; prior_median_price_aud: Value };
export type Insights = { summary: { sale_count: number | string; priced_sales: number | string; median_price_aud: Value; average_price_aud: Value; land_sample: number | string; land_price_correlation: Value; median_land_size_sqm: Value }; rolling: Rolling | null; bedrooms: Segment[] };
export type MonthlyDatum = { month: string; label: string; shortLabel: string; sales: number; median: number | null; average: number | null; minimum: number | null; maximum: number | null; observed: boolean };
export type MarketSeries = { key: string; label: string; months: MonthlyDatum[]; rolling: Rolling | null; bedrooms: Segment[] };

export const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
export const number = new Intl.NumberFormat("en-AU");
export const compactMoney = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", notation: "compact", maximumFractionDigits: 2 });
export const periods = [6, 12, 18, 24, 30] as const;
export const asNumber = (value: Value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
export const displayMoney = (value: Value) => asNumber(value) == null ? "—" : money.format(asNumber(value)!);
export const monthLabel = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
export const periodLabel = (range: DateRange) => `${monthLabel(range.from)} – ${monthLabel(range.to)}`;

export function datesFor(months: number, now = new Date()): DateRange {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Perth", year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year")!.value);
  const month = Number(parts.find(part => part.type === "month")!.value);
  const to = new Date(Date.UTC(year, month - 1, 0));
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - months + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function monthlyData(rows: SaleRow[], range: DateRange): MonthlyDatum[] {
  const byMonth = new Map(rows.map(row => [row.sale_month.slice(0, 7), row]));
  const cursor = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  const result: MonthlyDatum[] = [];
  while (cursor <= end) {
    const month = cursor.toISOString().slice(0, 10);
    const row = byMonth.get(month.slice(0, 7));
    result.push({ month, label: monthLabel(month), shortLabel: cursor.toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }), sales: Number(row?.sale_count ?? 0), median: asNumber(row?.median_price_aud ?? null), average: asNumber(row?.average_price_aud ?? null), minimum: asNumber(row?.minimum_price_aud ?? null), maximum: asNumber(row?.maximum_price_aud ?? null), observed: Boolean(row) });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

export function monthlySeries(series: { key: string; label: string; rows: SaleRow[]; insights: Insights | null }[], range: DateRange): MarketSeries[] {
  return series.map(({ key, label, rows, insights }) => ({
    key,
    label,
    months: monthlyData(rows, range),
    rolling: insights?.rolling ?? null,
    bedrooms: insights?.bedrooms ?? [],
  }));
}

export function salesCsv(rows: SaleRow[]): string {
  const columns: (keyof SaleRow)[] = ["suburb", "postcode", "sale_month", "sale_count", "median_price_aud", "average_price_aud", "minimum_price_aud", "maximum_price_aud"];
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const sorted = rows.slice().sort((a, b) => a.sale_month.localeCompare(b.sale_month) || a.suburb.localeCompare(b.suburb) || a.postcode.localeCompare(b.postcode));
  return [columns.join(","), ...sorted.map(row => columns.map(column => cell(row[column])).join(","))].join("\n");
}

export function variance(current: Value, previous: Value) {
  const next = asNumber(current), prior = asNumber(previous);
  return next == null || prior == null || prior === 0 ? null : (next / prior - 1) * 100;
}
