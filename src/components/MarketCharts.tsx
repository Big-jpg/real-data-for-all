"use client";

import { useMemo } from "react";
import { barX, barY, lineY, ruleX } from "@tanstack/charts";
import { Chart, type ChartDefinition } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import {
  asNumber, compactMoney, displayMoney, number, periodLabel,
  type BedroomFilter, type MonthlyDatum, type Rolling, type Segment,
} from "@/lib/market-view";

const palette = {
  foreground: "var(--ink)", muted: "var(--muted)", grid: "var(--chart-grid)",
  background: "var(--surface)", palette: ["var(--accent)", "var(--secondary)"],
};
const monthlyMargin = { top: 18, right: 16, bottom: 36, left: 64 };
const countFormat = (value: number) => number.format(value);
const priceFormat = (value: number) => compactMoney.format(value);
const bedroomValues: BedroomFilter[] = ["1", "2", "3", "4", "5", "6"];

function ChartLoading() {
  return <div className="chart-placeholder" role="status" aria-label="Loading chart"><span /></div>;
}

function priceDomain(values: (number | null)[]): [number, number] {
  const available = values.filter((value): value is number => value !== null);
  if (available.length === 0) return [0, 1];
  const lower = Math.min(...available), upper = Math.max(...available);
  const padding = Math.max((upper - lower) * 0.18, upper * 0.06, 1);
  return [Math.max(0, lower - padding), upper + padding];
}

type MonthlyChartsProps = {
  months: MonthlyDatum[];
  loading: boolean;
  showAverage: boolean;
  activeMonth: string | null;
  onMonthFocus: (month: string | null) => void;
  onMonthSelect: (month: string) => void;
};

export function MonthlyCharts({ months, loading, showAverage, activeMonth, onMonthFocus, onMonthSelect }: MonthlyChartsProps) {
  const priceDefinition = useMemo<ChartDefinition<MonthlyDatum, string, number>>(() => {
    const domain = months.map(month => month.month);
    const labels = new Map(months.map(month => [month.month, month.shortLabel]));
    const marks = [
      lineY(months, { id: "Median", x: "month", y: "median", key: "month", stroke: "var(--accent)", strokeWidth: 2.6, points: true }),
      ...(showAverage ? [lineY(months, { id: "Average", x: "month", y: "average", key: "month", stroke: "var(--secondary)", strokeWidth: 2, strokeDasharray: "5 4", points: true })] : []),
      ruleX(activeMonth ? [activeMonth] : [], { stroke: "var(--muted)", strokeWidth: 1, strokeDasharray: "3 4", strokeOpacity: 0.55 }),
    ];
    return {
      marks, theme: palette, margin: monthlyMargin, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
      scales: {
        x: { scale: scaleBand<string>().domain(domain).paddingInner(0.3).paddingOuter(0.15), axis: { line: false, ticks: { values: domain, line: false, format: value => labels.get(String(value)) ?? "" }, tickLabels: { fontSize: 10, thin: { minGap: 18, priority: "ends" } } } },
        y: { scale: scaleLinear().domain(priceDomain(months.flatMap(month => showAverage ? [month.median, month.average] : [month.median]))), grid: true, axis: { line: false, ticks: { count: 4, line: false, format: priceFormat }, tickLabels: { fontSize: 11 } } },
      },
      tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
        const month = points[0]?.datum;
        return { title: month?.label, rows: month ? [
          { label: "Median", value: displayMoney(month.median), color: "var(--accent)" },
          ...(showAverage ? [{ label: "Average", value: displayMoney(month.average), color: "var(--secondary)" }] : []),
          { label: "Recorded sales", value: countFormat(month.sales) },
        ] : [] };
      } },
    };
  }, [months, showAverage, activeMonth]);

  const volumeDefinition = useMemo<ChartDefinition<MonthlyDatum, string, number>>(() => {
    const domain = months.map(month => month.month);
    const labels = new Map(months.map(month => [month.month, month.shortLabel]));
    return {
      marks: [
        barY(months, { id: "Recorded sales", x: "month", y: "sales", key: "month", fill: month => month.month === activeMonth ? "var(--accent)" : "var(--secondary)", radius: { end: 3 }, maxThickness: 48 }),
        ruleX(activeMonth ? [activeMonth] : [], { stroke: "var(--muted)", strokeWidth: 1, strokeDasharray: "3 4", strokeOpacity: 0.55 }),
      ],
      theme: palette, margin: monthlyMargin, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
      scales: {
        x: { scale: scaleBand<string>().domain(domain).paddingInner(0.3).paddingOuter(0.15), axis: { line: false, ticks: { values: domain, line: false, format: value => labels.get(String(value)) ?? "" }, tickLabels: { fontSize: 10, thin: { minGap: 18, priority: "ends" } } } },
        y: { scale: scaleLinear().domain([0, Math.max(1, ...months.map(month => month.sales)) * 1.1]), grid: true, axis: { line: false, ticks: { count: 4, line: false, format: value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 11 } } },
      },
      tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
        const month = points[0]?.datum;
        return { title: month?.label, rows: month ? [
          { label: "Recorded sales", value: countFormat(month.sales), color: "var(--secondary)" },
          { label: "Median", value: displayMoney(month.median) },
          ...(!month.observed ? [{ label: "Coverage", value: "No recorded observations" }] : []),
        ] : [] };
      } },
    };
  }, [months, activeMonth]);

  const selected = months.find(month => month.month === activeMonth) ?? months.at(-1);
  const hasPrices = months.some(month => month.median !== null || (showAverage && month.average !== null));
  return <div className="chart-grid">
    <section className="chart-card price-card" aria-busy={loading}>
      <div className="card-top"><h3>Price trend</h3><div className="chart-value">{displayMoney(selected?.median ?? null)}<span>{selected?.label ?? "Median"}</span></div></div>
      <div className="chart-legend"><span className="legend-key median-key">Median</span>{showAverage && <span className="legend-key average-key">Average</span>}</div>
      {loading ? <ChartLoading /> : !hasPrices ? <div className="chart-empty">No disclosed prices</div> : <>
        <Chart definition={priceDefinition} className="chart-host" height={270} ariaLabel="Monthly sale prices in Australian dollars" ariaDescription="Arrow keys move between recorded price points. Enter selects a month. Months without disclosed prices have gaps." onFocusChange={point => onMonthFocus(point?.datum.month ?? null)} onSelect={point => { if (point) onMonthSelect(point.datum.month); }} />
      </>}
    </section>
    <section className="chart-card volume-card" aria-busy={loading}>
      <div className="card-top"><h3>Recorded sales</h3><div className="chart-value">{selected ? countFormat(selected.sales) : "—"}<span>{selected?.label ?? "Sales"}</span></div></div>
      <div className="chart-legend"><span className="legend-key prior-key">Sales per month</span></div>
      {loading ? <ChartLoading /> : <Chart definition={volumeDefinition} className="chart-host" height={270} ariaLabel="Recorded House sales by month" ariaDescription="Arrow keys move between months. Enter selects a month. Zero means no recorded observations." onFocusChange={point => onMonthFocus(point?.datum.month ?? null)} onSelect={point => { if (point) onMonthSelect(point.datum.month); }} />}
    </section>
  </div>;
}

type PeriodDatum = { label: string; range: string; sales: number; priced: number; median: number | null };

function comparisonDefinition(data: PeriodDatum[], metric: "median" | "sales"): ChartDefinition<PeriodDatum, number, string> {
  const values = data.map(row => metric === "median" ? row.median : row.sales);
  return {
    marks: [barX(data, { id: metric, x: row => metric === "median" ? row.median : row.sales, y: "label", key: "label", fill: row => row.label === "Current" ? "var(--accent)" : "var(--secondary)", radius: { end: 3 }, maxThickness: 22 })],
    theme: palette, margin: { top: 12, right: 12, bottom: 30, left: 58 }, svgAnimation: false, motion: false, keyboard: true,
    scales: {
      x: { scale: scaleLinear().domain([0, Math.max(1, ...values.filter((value): value is number => value !== null)) * 1.12]), grid: true, axis: { line: false, ticks: { count: 3, line: false, format: metric === "median" ? priceFormat : value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 10 } } },
      y: { scale: scaleBand<string>().domain(["Current", "Prior"]).padding(0.4), axis: { line: false, ticks: { line: false }, tickLabels: { fontSize: 11 } } },
    },
    tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
      const period = points[0]?.datum;
      return { title: period ? `${period.label} · ${period.range}` : undefined, rows: period ? [
        { label: "Median", value: displayMoney(period.median) },
        { label: "Recorded sales", value: countFormat(period.sales) },
        { label: "Disclosed prices", value: countFormat(period.priced) },
      ] : [] };
    } },
  };
}

export function PeriodComparison({ rolling, loading }: { rolling: Rolling | null; loading: boolean }) {
  const periods = useMemo<PeriodDatum[]>(() => rolling ? [
    { label: "Current", range: periodLabel({ from: rolling.current_from, to: rolling.current_to }), sales: Number(rolling.current_sale_count), priced: Number(rolling.current_priced_sales), median: asNumber(rolling.current_median_price_aud) },
    { label: "Prior", range: periodLabel({ from: rolling.prior_from, to: rolling.prior_to }), sales: Number(rolling.prior_sale_count), priced: Number(rolling.prior_priced_sales), median: asNumber(rolling.prior_median_price_aud) },
  ] : [], [rolling]);
  const medianDefinition = useMemo(() => comparisonDefinition(periods, "median"), [periods]);
  const salesDefinition = useMemo(() => comparisonDefinition(periods, "sales"), [periods]);
  return <section className="chart-card comparison-card" aria-busy={loading}>
    <div className="card-top"><h3>Period comparison</h3><div className="chart-legend"><span className="legend-key current-key">Current</span><span className="legend-key prior-key">Prior</span></div></div>
    {loading ? <ChartLoading /> : !rolling ? <div className="chart-empty">No period observations</div> : <>
      <div className="comparison-grid">
        <div className="comparison-metric"><h4>Median price</h4><Chart definition={medianDefinition} className="chart-host" height={145} initialWidth={330} ariaLabel="Current and prior period median prices in Australian dollars" ariaDescription="Both price bars start at zero. A missing median has no bar." /></div>
        <div className="comparison-metric"><h4>Recorded sales</h4><Chart definition={salesDefinition} className="chart-host" height={145} initialWidth={330} ariaLabel="Current and prior period recorded sales" /></div>
      </div>
      <div className="comparison-periods">{periods.map(period => <div key={period.label}>
        <span className={`legend-key ${period.label === "Current" ? "current-key" : "prior-key"}`}>{period.label}</span>
        <strong>{period.range}</strong><span>{displayMoney(period.median)} · {countFormat(period.sales)} sales</span><small>{countFormat(period.priced)} disclosed prices</small>
      </div>)}</div>
    </>}
  </section>;
}

type BedroomDatum = { bedroom: BedroomFilter; label: string; sales: number; median: number | null };

export function BedroomChart({ rows, activeBedroom, loading, onSelect }: { rows: Segment[]; activeBedroom: BedroomFilter; loading: boolean; onSelect: (value: BedroomFilter) => void }) {
  const data = useMemo<BedroomDatum[]>(() => rows.flatMap(row => {
    const bedroom = String(row.segment_label) as BedroomFilter;
    return bedroomValues.includes(bedroom) ? [{ bedroom, label: `${bedroom} bed`, sales: Number(row.sale_count), median: asNumber(row.median_price_aud) }] : [];
  }).sort((left, right) => Number(left.bedroom) - Number(right.bedroom)), [rows]);
  const definition = useMemo<ChartDefinition<BedroomDatum, string, number>>(() => ({
    marks: [barY(data, { id: "Bedrooms", x: "bedroom", y: "sales", key: "bedroom", fill: row => activeBedroom === "all" || row.bedroom === activeBedroom ? "var(--accent)" : "var(--secondary)", radius: { end: 3 }, maxThickness: 56 })],
    theme: palette, margin: { top: 16, right: 14, bottom: 30, left: 48 }, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
    scales: {
      x: { scale: scaleBand<string>().domain(data.map(row => row.bedroom)).padding(0.35), axis: { line: false, ticks: { line: false, format: value => `${value} bed` }, tickLabels: { fontSize: 11 } } },
      y: { scale: scaleLinear().domain([0, Math.max(1, ...data.map(row => row.sales)) * 1.1]), grid: true, axis: { line: false, ticks: { count: 3, line: false, format: value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 10 } } },
    },
    tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
      const row = points[0]?.datum;
      return { title: row?.label, rows: row ? [
        { label: "Recorded sales", value: countFormat(row.sales) },
        { label: "Median", value: displayMoney(row.median) },
      ] : [] };
    } },
  }), [data, activeBedroom]);
  return <section className="chart-card bedroom-card" aria-busy={loading}>
    <div className="card-top"><h3>Bedrooms</h3><span className="chart-subtitle">Recorded sales</span></div>
    {loading ? <ChartLoading /> : data.length === 0 ? <div className="chart-empty">No bedroom observations</div> : <Chart definition={definition} className="chart-host" height={230} ariaLabel="Recorded sales by bedroom count" ariaDescription="Arrow keys move between bedroom counts. Enter filters the dashboard to that bedroom count." onSelect={point => { if (point) onSelect(point.datum.bedroom); }} />}
    <div className="bedroom-picker" role="group" aria-label="Bedroom filter">
      <button type="button" aria-pressed={activeBedroom === "all"} onClick={() => onSelect("all")}>All</button>
      {bedroomValues.map(value => <button type="button" key={value} aria-label={`${value} bedrooms`} aria-pressed={activeBedroom === value} onClick={() => onSelect(value)}>{value}</button>)}
    </div>
  </section>;
}
