"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { areaY, lineY } from "@tanstack/charts";
import { Chart, type ChartDefinition } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";

type SeriesKey = "repeat_sales_ols_untrimmed" | "annual_median_price" | "repeat_sales_ols_return_band" | "repeat_sales_huber";
type AnnualRow = {
  model_version: string;
  source_snapshot_id: string;
  source_snapshot_at: string;
  executed_at: string;
  reference_year: number;
  reporting_window_start: number;
  reporting_window_end: number;
  series_key: SeriesKey;
  series_label: string;
  observation_year: number;
  index_level: number;
  index_lower_95: number | null;
  index_upper_95: number | null;
  annual_change_pct: number;
  annual_change_lower_95_pct: number | null;
  annual_change_upper_95_pct: number | null;
  pair_count: number | null;
  identifying_pair_count: number | null;
  same_year_diagnostic_pair_count: number | null;
  contributing_property_count: number | null;
  year_identifying_pair_count: number | null;
  year_contributing_property_count: number | null;
  sale_count: number | null;
  eligibility_criteria: string;
};
type AnnualChartRow = {
  year: string;
  observationYear: number;
  index: number;
  lower: number;
  upper: number;
};

const labels: Record<SeriesKey, string> = {
  repeat_sales_ols_untrimmed: "Experimental Repeat-Sales Index",
  annual_median_price: "Annual median-price index",
  repeat_sales_ols_return_band: "Return-band OLS sensitivity",
  repeat_sales_huber: "Huber IRLS sensitivity",
};
const colors: Record<SeriesKey, string> = {
  repeat_sales_ols_untrimmed: "var(--accent)",
  annual_median_price: "var(--secondary)",
  repeat_sales_ols_return_band: "var(--rose-dark)",
  repeat_sales_huber: "var(--ink)",
};
const numberFormat = new Intl.NumberFormat("en-AU");
const percentFormat = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const chartTheme = {
  foreground: "var(--ink)",
  muted: "var(--muted)",
  grid: "var(--chart-grid)",
  background: "var(--surface)",
  palette: Object.values(colors),
};

function isAnnualRow(value: unknown): value is AnnualRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return row.model_version === "annual-repeat-sales-v1"
    && typeof row.source_snapshot_id === "string"
    && typeof row.source_snapshot_at === "string"
    && typeof row.executed_at === "string"
    && typeof row.series_key === "string" && Object.hasOwn(labels, row.series_key)
    && typeof row.series_label === "string"
    && Number.isInteger(Number(row.observation_year))
    && Number.isFinite(Number(row.index_level))
    && Number.isFinite(Number(row.annual_change_pct))
    && typeof row.eligibility_criteria === "string";
}

function displayNullable(value: number | null, digits = 2) {
  return value === null ? "—" : value.toFixed(digits);
}

export function AnnualMarketAppreciation() {
  const [rows, setRows] = useState<AnnualRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showReturnBand, setShowReturnBand] = useState(false);
  const [showHuber, setShowHuber] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/analytics/annual-repeat-sales", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Annual repeat-sales data are temporarily unavailable.");
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("data" in payload) || !Array.isArray(payload.data)
          || !payload.data.every(isAnnualRow)) throw new Error("The annual repeat-sales response was invalid.");
        if (!controller.signal.aborted) {
          setRows(payload.data);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Annual repeat-sales data are temporarily unavailable.");
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [retry]);

  const bySeries = useMemo(() => {
    const result = new Map<SeriesKey, AnnualRow[]>();
    for (const row of rows) {
      const values = result.get(row.series_key) ?? [];
      values.push(row);
      result.set(row.series_key, values);
    }
    for (const values of result.values()) values.sort((left, right) => left.observation_year - right.observation_year);
    return result;
  }, [rows]);
  const primary = useMemo(() => bySeries.get("repeat_sales_ols_untrimmed") ?? [], [bySeries]);
  const median = useMemo(() => bySeries.get("annual_median_price") ?? [], [bySeries]);
  const visibleKeys = useMemo<SeriesKey[]>(() => [
    "repeat_sales_ols_untrimmed",
    "annual_median_price",
    ...(showReturnBand ? ["repeat_sales_ols_return_band" as const] : []),
    ...(showHuber ? ["repeat_sales_huber" as const] : []),
  ], [showReturnBand, showHuber]);
  const retryFetch = () => {
    setError("");
    setLoading(true);
    setRetry((value) => value + 1);
  };
  const chartDefinition = useMemo<ChartDefinition<AnnualChartRow, string, number> | null>(() => {
    const primaryData = primary.map((row) => ({
      year: String(row.observation_year),
      observationYear: row.observation_year,
      index: row.index_level,
      lower: row.index_lower_95 ?? row.index_level,
      upper: row.index_upper_95 ?? row.index_level,
    }));
    if (!primaryData.length || !median.length) return null;
    const years = primaryData.map((row) => row.year);
    const seriesData = new Map<SeriesKey, AnnualChartRow[]>([
      ["repeat_sales_ols_untrimmed", primaryData],
      ...visibleKeys.filter((key) => key !== "repeat_sales_ols_untrimmed").map((key) => [
        key,
        (bySeries.get(key) ?? []).map((row) => ({
          year: String(row.observation_year),
          observationYear: row.observation_year,
          index: row.index_level,
          lower: row.index_level,
          upper: row.index_level,
        })),
      ] as [SeriesKey, AnnualChartRow[]]),
    ]);
    const allValues = [...seriesData.values()].flatMap((series) => series.flatMap((row) => [row.lower, row.upper, row.index]));
    const minimum = Math.min(...allValues), maximum = Math.max(...allValues);
    const padding = Math.max((maximum - minimum) * 0.08, 2);
    const pointsByYear = new Map(years.map((year) => [year, visibleKeys.flatMap((key) => {
      const row = seriesData.get(key)?.find((item) => item.year === year);
      return row ? [{
        label: labels[key],
        value: row.index.toFixed(2),
        detail: key === "annual_median_price" ? "No confidence interval" : `${row.lower.toFixed(2)}–${row.upper.toFixed(2)} (95% CI)`,
        color: colors[key],
      }] : [];
    })]));
    return {
      marks: [
        areaY(primaryData, { id: "Repeat-sales 95% confidence interval", x: "year", y: "upper", y1: "lower", key: "year", fill: colors.repeat_sales_ols_untrimmed, fillOpacity: 0.16 }),
        ...visibleKeys.map((key) => lineY(seriesData.get(key) ?? [], {
          id: labels[key],
          x: "year",
          y: "index",
          key: "year",
          stroke: colors[key],
          strokeWidth: key === "repeat_sales_ols_untrimmed" ? 3 : 2,
          strokeDasharray: key === "annual_median_price" ? "5 4" : undefined,
          lineCap: "round",
          lineJoin: "round",
          points: true,
        })),
      ],
      theme: chartTheme,
      margin: { top: 15, right: 16, bottom: 36, left: 54 },
      svgAnimation: false,
      motion: false,
      focus: "group-x",
      keyboard: true,
      scales: {
        x: { scale: scaleBand<string>().domain(years).paddingInner(0.25).paddingOuter(0.1), axis: { line: false, ticks: { values: years, line: false, format: (value) => String(value) }, tickLabels: { fontSize: 10, thin: { minGap: 15, priority: "ends" } } } },
        y: { scale: scaleLinear().domain([minimum - padding, maximum + padding]), grid: true, axis: { line: false, ticks: { count: 5, line: false, format: (value) => Number(value).toFixed(0) }, tickLabels: { fontSize: 10 } } },
      },
      tooltip: {
        use: tooltip,
        motion: false,
        className: "market-tooltip",
        content: (points) => {
          const point = points[0]?.datum;
          return {
            title: point?.year,
            rows: point ? pointsByYear.get(point.year) ?? [] : [],
          };
        },
      },
    };
  }, [primary, median, bySeries, visibleKeys]);

  const reference = primary.find((row) => row.observation_year === 2020);
  const latest = primary.at(-1);
  const sensitivityRows = visibleKeys.filter((key) => key === "repeat_sales_ols_return_band" || key === "repeat_sales_huber")
    .flatMap((key) => bySeries.get(key) ?? []);
  const visibleTableRows = [...primary, ...median, ...sensitivityRows].sort((left, right) =>
    left.observation_year - right.observation_year || visibleKeys.indexOf(left.series_key) - visibleKeys.indexOf(right.series_key));

  return <section className="annual-index-section" aria-labelledby="annual-index-heading" aria-busy={loading}>
    <div className="annual-index-header">
      <div>
        <span className="chart-kicker">Experimental analysis</span>
        <h2 id="annual-index-heading">Annual Market Appreciation</h2>
      </div>
      <span className="annual-index-badge">Experimental Repeat-Sales Index</span>
    </div>
    <p className="annual-index-intro">
      Measures appreciation among matched repeat-sale properties. It is not a complete market valuation, forecast, or causal explanation.
      The annual median-price index is shown on the same 2020 = 100 scale as a descriptive comparator.
    </p>
    {error ? <p className="annual-index-error" role="alert">{error} <button type="button" onClick={retryFetch}>Retry</button></p>
      : loading ? <div className="chart-placeholder" role="status" aria-label="Loading annual appreciation analysis"><span /></div>
        : chartDefinition ? <>
          <div className="annual-index-controls" role="group" aria-label="Sensitivity series">
            <label><input type="checkbox" checked={showReturnBand} onChange={(event) => setShowReturnBand(event.target.checked)} /> Return-band OLS</label>
            <label><input type="checkbox" checked={showHuber} onChange={(event) => setShowHuber(event.target.checked)} /> Huber IRLS</label>
          </div>
          <div className="annual-index-legend" aria-label="Chart legend">
            {visibleKeys.map((key) => <span key={key} style={{ "--series-color": colors[key] } as CSSProperties}>{labels[key]}{key === "repeat_sales_ols_untrimmed" ? " · 95% CI" : ""}</span>)}
          </div>
          <Chart
            definition={chartDefinition}
            className="chart-host annual-index-chart"
            height={310}
            ariaLabel="Annual repeat-sales index and median-price index, 2009 to 2025"
            ariaDescription="The repeat-sales index is normalized to 100 in 2020. Its shaded band is a property-clustered 95 percent confidence interval. Use arrow keys to inspect years."
          />
          <p className="annual-index-coverage">
            {numberFormat.format(latest?.pair_count ?? 0)} eligible consecutive pairs; {numberFormat.format(latest?.identifying_pair_count ?? 0)} cross-year identifying pairs;
            {" "}{numberFormat.format(latest?.contributing_property_count ?? 0)} contributing properties. Annual median-price index: {numberFormat.format(median.at(-1)?.sale_count ?? 0)} priced sales in {median.at(-1)?.observation_year ?? "—"}.
            {latest?.same_year_diagnostic_pair_count ? ` ${numberFormat.format(latest.same_year_diagnostic_pair_count)} same-calendar-year pairs are diagnostic only and excluded from coefficient estimation.` : ""}
          </p>
          {latest && <p className="annual-index-latest">
            {latest.observation_year}: repeat-sales index {latest.index_level.toFixed(1)} (95% CI {displayNullable(latest.index_lower_95)}–{displayNullable(latest.index_upper_95)}),
            {" "}{percentFormat(latest.annual_change_pct)} annual appreciation.
          </p>}
          <details className="annual-index-table">
            <summary>Annual estimates and sample counts <span>{primary.length} years · reference {reference?.reference_year ?? 2020} = 100</span></summary>
            <div className="table-scroll"><table>
              <caption className="sr-only">Annual repeat-sales index levels, clustered 95 percent confidence intervals, annual changes, median-price comparator and sample counts</caption>
              <thead><tr><th scope="col">Year</th><th scope="col">Series</th><th scope="col">Index</th><th scope="col">95% CI</th><th scope="col">Annual appreciation</th><th scope="col">Year identifying pairs</th><th scope="col">Properties</th><th scope="col">Median-price sales</th></tr></thead>
              <tbody>{visibleTableRows.map((row) => <tr key={`${row.series_key}-${row.observation_year}`}>
                <th scope="row">{row.observation_year}</th>
                <td>{labels[row.series_key]}</td>
                <td>{row.index_level.toFixed(2)}</td>
                <td>{row.index_lower_95 == null ? "—" : `${row.index_lower_95.toFixed(2)}–${row.index_upper_95?.toFixed(2)}`}</td>
                <td>{percentFormat(row.annual_change_pct)}</td>
                <td>{row.year_identifying_pair_count == null ? "—" : numberFormat.format(row.year_identifying_pair_count)}</td>
                <td>{row.year_contributing_property_count == null ? "—" : numberFormat.format(row.year_contributing_property_count)}</td>
                <td>{row.sale_count == null ? "—" : numberFormat.format(row.sale_count)}</td>
              </tr>)}</tbody>
            </table></div>
          </details>
          <details className="annual-index-method">
            <summary>Methodology and limitations</summary>
            <p>Unweighted annual repeat-sales regression of log price changes for globally consecutive, positive-price sale pairs within the serving scope. Endpoint prices are AUD 50,000–20,000,000; holding periods must be positive. Transactions are sequenced before price filtering so an unpriced event cannot be skipped to form a false pair. Year effects outside 2009–2025 are retained as nuisance terms; 2020 is the fixed reference year.</p>
            <p>Confidence intervals use a property-clustered CR1 sandwich to account for multiple pairs per property. The annual median-price index is not composition-adjusted. Return-band and Huber series are sensitivity analyses; Huber uncertainty treats its initial robust scale as fixed. Pair selection, property coverage, source characteristics and residual variation limit interpretation.</p>
            <p>Model version {latest?.model_version}; source snapshot {latest?.source_snapshot_id} captured {latest?.source_snapshot_at}; executed {latest?.executed_at}. Eligibility: {latest?.eligibility_criteria}</p>
          </details>
        </> : <p className="annual-index-error" role="status">The annual appreciation dataset is not yet available.</p>}
  </section>;
}
