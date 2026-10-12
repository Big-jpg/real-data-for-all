"use client";

import { Fragment, useMemo, type CSSProperties } from "react";
import { barX, barY, group, lineY, ruleX } from "@tanstack/charts";
import { Chart, type ChartDefinition } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import {
  asNumber, compactMoney, displayMoney, number, periodLabel,
  type BedroomFilter, type MarketSeries, type MonthlyDatum,
} from "@/lib/market-view";

const palette = {
  foreground: "var(--ink)", muted: "var(--muted)", grid: "var(--chart-grid)",
  background: "var(--surface)", palette: ["var(--accent)", "var(--secondary)"],
};
const monthlyMargin = { top: 18, right: 16, bottom: 36, left: 64 };
const countFormat = (value: number) => number.format(value);
const priceFormat = (value: number) => compactMoney.format(value);
const seriesColor = (index: number) => index === 0 ? "var(--accent)" : "var(--secondary)";
const bedroomValues: BedroomFilter[] = ["1", "2", "3", "4", "5", "6"];

function ChartLoading() {
  return <div className="chart-placeholder" role="status" aria-label="Loading chart"><span /></div>;
}

function SeriesKey({ label, color, average = false, prior = false }: { label: string; color: string; average?: boolean; prior?: boolean }) {
  return <span className={`legend-key series-key${average ? " average-series-key" : ""}${prior ? " prior-series-key" : ""}`} style={{ "--series-color": color } as CSSProperties}>{label}</span>;
}

function priceDomain(values: (number | null)[]): [number, number] {
  const available = values.filter((value): value is number => value !== null);
  if (available.length === 0) return [0, 1];
  const lower = Math.min(...available), upper = Math.max(...available);
  const padding = Math.max((upper - lower) * 0.18, upper * 0.06, 1);
  return [Math.max(0, lower - padding), upper + padding];
}

type MonthlyChartsProps = {
  series: MarketSeries[];
  loading: boolean;
  showAverage: boolean;
  activeMonth: string | null;
  onMonthFocus: (month: string | null) => void;
  onMonthSelect: (month: string) => void;
};
type SeriesMonthlyDatum = MonthlyDatum & { seriesKey: string; seriesLabel: string; color: string };

export function MonthlyCharts({ series, loading, showAverage, activeMonth, onMonthFocus, onMonthSelect }: MonthlyChartsProps) {
  const comparing = series.length > 1;
  const months = useMemo(() => [...new Map(series.flatMap(item => item.months).map(month => [month.month, month])).values()].sort((left, right) => left.month.localeCompare(right.month)), [series]);
  const monthlySeries = useMemo(() => series.map((item, index) => ({ ...item, color: seriesColor(index), byMonth: new Map(item.months.map(month => [month.month, month])) })), [series]);
  const data = useMemo<SeriesMonthlyDatum[]>(() => monthlySeries.flatMap(item => item.months.map(month => ({ ...month, seriesKey: item.key, seriesLabel: item.label, color: item.color }))), [monthlySeries]);

  const priceDefinition = useMemo<ChartDefinition<MonthlyDatum, string, number>>(() => {
    const domain = months.map(month => month.month);
    const labels = new Map(months.map(month => [month.month, month.shortLabel]));
    const marks = [
      ...monthlySeries.flatMap(item => [
        lineY(item.months, { id: `${item.label} · Median`, x: "month", y: "median", key: "month", stroke: item.color, strokeWidth: 2.6, points: true }),
        ...(showAverage ? [lineY(item.months, { id: `${item.label} · Average`, x: "month", y: "average", key: "month", stroke: comparing ? item.color : "var(--secondary)", strokeWidth: 2, strokeDasharray: "5 4", points: true })] : []),
      ]),
      ruleX(activeMonth ? [activeMonth] : [], { stroke: "var(--muted)", strokeWidth: 1, strokeDasharray: "3 4", strokeOpacity: 0.55 }),
    ];
    return {
      marks, theme: palette, margin: monthlyMargin, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
      scales: {
        x: { scale: scaleBand<string>().domain(domain).paddingInner(0.3).paddingOuter(0.15), axis: { line: false, ticks: { values: domain, line: false, format: value => labels.get(String(value)) ?? "" }, tickLabels: { fontSize: 10, thin: { minGap: 18, priority: "ends" } } } },
        y: { scale: scaleLinear().domain(priceDomain(data.flatMap(month => showAverage ? [month.median, month.average] : [month.median]))), grid: true, axis: { line: false, ticks: { count: 4, line: false, format: priceFormat }, tickLabels: { fontSize: 11 } } },
      },
      tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
        const focused = points[0]?.datum;
        return { title: focused?.label, rows: focused ? monthlySeries.flatMap(item => {
          // Resolve every suburb from the month: an absent price has no chart point.
          const month = item.byMonth.get(focused.month);
          const prefix = comparing ? `${item.label} · ` : "";
          return [
            { label: `${prefix}Median`, value: displayMoney(month?.median ?? null), color: item.color },
            ...(showAverage ? [{ label: `${prefix}Average`, value: displayMoney(month?.average ?? null), color: comparing ? item.color : "var(--secondary)" }] : []),
            { label: `${prefix}Recorded sales`, value: countFormat(month?.sales ?? 0) },
            ...(!month?.observed ? [{ label: `${prefix}Coverage`, value: "No recorded observations" }] : []),
          ];
        }) : [] };
      } },
    };
  }, [months, monthlySeries, data, showAverage, comparing, activeMonth]);

  const volumeDefinition = useMemo<ChartDefinition<SeriesMonthlyDatum, string, number>>(() => {
    const domain = months.map(month => month.month);
    const labels = new Map(months.map(month => [month.month, month.shortLabel]));
    return {
      marks: [
        barY(data, { id: "Recorded sales", x: "month", y: "sales", z: "seriesLabel", key: row => `${row.seriesKey}:${row.month}`, fill: row => row.color, layout: group({ padding: 0.15 }), radius: { end: 3 }, maxThickness: 48 }),
        ruleX(activeMonth ? [activeMonth] : [], { stroke: "var(--muted)", strokeWidth: 1, strokeDasharray: "3 4", strokeOpacity: 0.55 }),
      ],
      theme: palette, margin: monthlyMargin, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
      scales: {
        x: { scale: scaleBand<string>().domain(domain).paddingInner(0.3).paddingOuter(0.15), axis: { line: false, ticks: { values: domain, line: false, format: value => labels.get(String(value)) ?? "" }, tickLabels: { fontSize: 10, thin: { minGap: 18, priority: "ends" } } } },
        y: { scale: scaleLinear().domain([0, Math.max(1, ...data.map(month => month.sales)) * 1.1]), grid: true, axis: { line: false, ticks: { count: 4, line: false, format: value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 11 } } },
      },
      tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
        const focused = points[0]?.datum;
        return { title: focused?.label, rows: focused ? monthlySeries.flatMap(item => {
          const month = item.byMonth.get(focused.month);
          const prefix = comparing ? `${item.label} · ` : "";
          return [
            { label: `${prefix}Recorded sales`, value: countFormat(month?.sales ?? 0), color: item.color },
            { label: `${prefix}Median`, value: displayMoney(month?.median ?? null) },
            ...(!month?.observed ? [{ label: `${prefix}Coverage`, value: "No recorded observations" }] : []),
          ];
        }) : [] };
      } },
    };
  }, [months, monthlySeries, data, comparing, activeMonth]);

  const selectedMonth = activeMonth ?? months.at(-1)?.month;
  const hasPrices = data.some(month => month.median !== null || (showAverage && month.average !== null));
  const names = series.map(item => item.label).join(" and ");
  return <div className="chart-grid">
    <section className="chart-card price-card" aria-busy={loading}>
      <div className="card-top"><h3>Price trend</h3><div className="chart-values">{monthlySeries.map(item => {
        const selected = selectedMonth ? item.byMonth.get(selectedMonth) : undefined;
        return <div className="chart-value" key={item.key}>{displayMoney(selected?.median ?? null)}<span>{comparing ? `${item.label} · ` : ""}{selected?.label ?? "Median"}</span></div>;
      })}</div></div>
      <div className="chart-legend">{monthlySeries.map(item => <Fragment key={item.key}>
        <SeriesKey label={`${comparing ? `${item.label} · ` : ""}Median`} color={item.color} />
        {showAverage && <SeriesKey label={`${comparing ? `${item.label} · ` : ""}Average`} color={comparing ? item.color : "var(--secondary)"} average />}
      </Fragment>)}</div>
      {loading ? <ChartLoading /> : !hasPrices ? <div className="chart-empty">No disclosed prices</div> : <Chart definition={priceDefinition} className="chart-host" height={270} ariaLabel={`Monthly sale prices for ${names} in Australian dollars`} ariaDescription="Arrow keys move between recorded price points. Enter selects a month. Months without disclosed prices have gaps. Solid lines show medians; dashed lines show averages." onFocusChange={point => onMonthFocus(point?.datum.month ?? null)} onSelect={point => { if (point) onMonthSelect(point.datum.month); }} />}
    </section>
    <section className="chart-card volume-card" aria-busy={loading}>
      <div className="card-top"><h3>Recorded sales</h3><div className="chart-values">{monthlySeries.map(item => {
        const selected = selectedMonth ? item.byMonth.get(selectedMonth) : undefined;
        return <div className="chart-value" key={item.key}>{selected ? countFormat(selected.sales) : "—"}<span>{comparing ? `${item.label} · ` : ""}{selected?.label ?? "Sales"}</span></div>;
      })}</div></div>
      <div className="chart-legend">{monthlySeries.map(item => <SeriesKey key={item.key} label={comparing ? item.label : "Sales per month"} color={item.color} />)}</div>
      {loading ? <ChartLoading /> : <Chart definition={volumeDefinition} className="chart-host" height={270} ariaLabel={`Recorded House sales by month for ${names}`} ariaDescription="Arrow keys move between months. Enter selects a month. Zero means no recorded observations. Suburbs have separate bars on the same sales scale." onFocusChange={point => onMonthFocus(point?.datum.month ?? null)} onSelect={point => { if (point) onMonthSelect(point.datum.month); }} />}
    </section>
  </div>;
}

type PeriodDatum = { key: string; label: string; suburb: string; period: "Current" | "Prior"; color: string; range: string; sales: number; priced: number; median: number | null };

function comparisonDefinition(data: PeriodDatum[], metric: "median" | "sales", comparing: boolean): ChartDefinition<PeriodDatum, number, string> {
  const values = data.map(row => metric === "median" ? row.median : row.sales);
  return {
    marks: [
      ...(["Current", "Prior"] as const).map(period => barX(data.filter(row => row.period === period), { id: `${period} ${metric}`, x: row => metric === "median" ? row.median : row.sales, y: "label", key: "key", fill: row => row.color, fillOpacity: period === "Current" ? 1 : 0.45, radius: { end: 3 }, maxThickness: 22 })),
    ],
    theme: palette, margin: { top: 12, right: 12, bottom: 30, left: comparing ? 160 : 58 }, svgAnimation: false, motion: false, keyboard: true,
    scales: {
      x: { scale: scaleLinear().domain([0, Math.max(1, ...values.filter((value): value is number => value !== null)) * 1.12]), grid: true, axis: { line: false, ticks: { count: 3, line: false, format: metric === "median" ? priceFormat : value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 10 } } },
      y: { scale: scaleBand<string>().domain(data.map(row => row.label)).padding(0.4), axis: { line: false, ticks: { line: false }, tickLabels: { fontSize: 11 } } },
    },
    tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
      const period = points[0]?.datum;
      return { title: period ? `${period.suburb} · ${period.period} · ${period.range}` : undefined, rows: period ? [
        { label: "Median", value: displayMoney(period.median), color: period.color },
        { label: "Recorded sales", value: countFormat(period.sales) },
        { label: "Disclosed prices", value: countFormat(period.priced) },
      ] : [] };
    } },
  };
}

export function PeriodComparison({ series, loading }: { series: MarketSeries[]; loading: boolean }) {
  const comparing = series.length > 1;
  const periods = useMemo<PeriodDatum[]>(() => series.flatMap((item, index) => {
    const rolling = item.rolling;
    if (!rolling) return [];
    return [
      { key: `${item.key}:current`, label: comparing ? `${item.label} · Current` : "Current", suburb: item.label, period: "Current", color: seriesColor(index), range: periodLabel({ from: rolling.current_from, to: rolling.current_to }), sales: Number(rolling.current_sale_count), priced: Number(rolling.current_priced_sales), median: asNumber(rolling.current_median_price_aud) },
      { key: `${item.key}:prior`, label: comparing ? `${item.label} · Prior` : "Prior", suburb: item.label, period: "Prior", color: seriesColor(index), range: periodLabel({ from: rolling.prior_from, to: rolling.prior_to }), sales: Number(rolling.prior_sale_count), priced: Number(rolling.prior_priced_sales), median: asNumber(rolling.prior_median_price_aud) },
    ];
  }), [series, comparing]);
  const medianDefinition = useMemo(() => comparisonDefinition(periods, "median", comparing), [periods, comparing]);
  const salesDefinition = useMemo(() => comparisonDefinition(periods, "sales", comparing), [periods, comparing]);
  const hasMedian = periods.some(period => period.median !== null);
  const names = series.map(item => item.label).join(" and ");
  return <section className={`chart-card comparison-card${comparing ? " comparing" : ""}`} aria-busy={loading}>
    <div className="card-top"><h3>Period comparison</h3><div className="chart-legend">{series.map((item, index) => <Fragment key={item.key}>
      <SeriesKey label={comparing ? `${item.label} · Current` : "Current"} color={seriesColor(index)} />
      <SeriesKey label={comparing ? `${item.label} · Prior` : "Prior"} color={seriesColor(index)} prior />
    </Fragment>)}</div></div>
    {loading ? <ChartLoading /> : periods.length === 0 ? <div className="chart-empty">No period observations</div> : <>
      <div className="comparison-grid">
        <div className="comparison-metric"><h4>Median price</h4>{hasMedian ? <Chart definition={medianDefinition} className="chart-host" height={comparing ? 220 : 145} initialWidth={330} ariaLabel={`Current and prior period median prices for ${names} in Australian dollars`} ariaDescription="All price bars start at zero. A missing median has no bar. Current periods use solid colour; prior periods use a lighter shade of the suburb colour." /> : <div className="chart-empty comparison-empty">No disclosed prices</div>}</div>
        <div className="comparison-metric"><h4>Recorded sales</h4><Chart definition={salesDefinition} className="chart-host" height={comparing ? 220 : 145} initialWidth={330} ariaLabel={`Current and prior period recorded sales for ${names}`} ariaDescription="All sales bars start at zero. Current periods use solid colour; prior periods use a lighter shade of the suburb colour." /></div>
      </div>
      <div className="comparison-periods">{periods.map(period => <div key={period.key}>
        <SeriesKey label={period.label} color={period.color} prior={period.period === "Prior"} />
        <strong>{period.range}</strong><span>{displayMoney(period.median)} · {countFormat(period.sales)} sales</span><small>{countFormat(period.priced)} disclosed prices</small>
      </div>)}{series.filter(item => !item.rolling).map(item => <div key={item.key}><strong>{item.label}</strong><span>No period observations</span></div>)}</div>
    </>}
  </section>;
}

type BedroomDatum = { bedroom: BedroomFilter; label: string; seriesKey: string; seriesLabel: string; color: string; sales: number; median: number | null; observed: boolean };

export function BedroomChart({ series, activeBedroom, loading, onSelect }: { series: MarketSeries[]; activeBedroom: BedroomFilter; loading: boolean; onSelect: (value: BedroomFilter) => void }) {
  const comparing = series.length > 1;
  const data = useMemo<BedroomDatum[]>(() => {
    const available = bedroomValues.filter(bedroom => series.some(item => item.bedrooms.some(row => String(row.segment_label) === bedroom)));
    return series.flatMap((item, index) => available.map(bedroom => {
      const row = item.bedrooms.find(row => String(row.segment_label) === bedroom);
      return { bedroom, label: `${bedroom} bed`, seriesKey: item.key, seriesLabel: item.label, color: seriesColor(index), sales: Number(row?.sale_count ?? 0), median: asNumber(row?.median_price_aud ?? null), observed: Boolean(row) };
    }));
  }, [series]);
  const definition = useMemo<ChartDefinition<BedroomDatum, string, number>>(() => ({
    marks: [barY(data, { id: "Bedrooms", x: "bedroom", y: "sales", z: "seriesLabel", key: row => `${row.seriesKey}:${row.bedroom}`, fill: row => row.color, layout: group({ padding: 0.15 }), radius: { end: 3 }, maxThickness: 56, states: [{ when: ({ datum }) => activeBedroom !== "all" && datum.bedroom !== activeBedroom, style: { fillOpacity: 0.45 } }] })],
    theme: palette, margin: { top: 16, right: 14, bottom: 30, left: 48 }, svgAnimation: false, motion: false, focus: "group-x", keyboard: true,
    scales: {
      x: { scale: scaleBand<string>().domain([...new Set(data.map(row => row.bedroom))]).padding(0.35), axis: { line: false, ticks: { line: false, format: value => `${value} bed` }, tickLabels: { fontSize: 11 } } },
      y: { scale: scaleLinear().domain([0, Math.max(1, ...data.map(row => row.sales)) * 1.1]), grid: true, axis: { line: false, ticks: { count: 3, line: false, format: value => Number.isInteger(value) ? countFormat(value) : "" }, tickLabels: { fontSize: 10 } } },
    },
    tooltip: { use: tooltip, motion: false, className: "market-tooltip", content: points => {
      const focused = points[0]?.datum;
      return { title: focused?.label, rows: focused ? data.filter(row => row.bedroom === focused.bedroom).flatMap(row => {
        const prefix = comparing ? `${row.seriesLabel} · ` : "";
        return [
          { label: `${prefix}Recorded sales`, value: countFormat(row.sales), color: row.color },
          { label: `${prefix}Median`, value: displayMoney(row.median) },
          ...(!row.observed ? [{ label: `${prefix}Coverage`, value: "No recorded observations" }] : []),
        ];
      }) : [] };
    } },
  }), [data, activeBedroom, comparing]);
  return <section className="chart-card bedroom-card" aria-busy={loading}>
    <div className="card-top"><h3>Bedrooms</h3><span className="chart-subtitle">Recorded sales</span></div>
    {comparing && <div className="chart-legend">{series.map((item, index) => <SeriesKey key={item.key} label={item.label} color={seriesColor(index)} />)}</div>}
    {loading ? <ChartLoading /> : data.length === 0 ? <div className="chart-empty">No bedroom observations</div> : <Chart definition={definition} className="chart-host" height={230} ariaLabel={`Recorded sales by bedroom count for ${series.map(item => item.label).join(" and ")}`} ariaDescription="Arrow keys move between bedroom counts. Enter filters the dashboard to that bedroom count. Suburbs have separate bars on the same sales scale. Zero means no recorded observations." onSelect={point => { if (point) onSelect(point.datum.bedroom); }} />}
    <div className="bedroom-picker" role="group" aria-label="Bedroom filter">
      <button type="button" aria-pressed={activeBedroom === "all"} onClick={() => onSelect("all")}>All</button>
      {bedroomValues.map(value => <button type="button" key={value} aria-label={`${value} bedrooms`} aria-pressed={activeBedroom === value} onClick={() => onSelect(value)}>{value}</button>)}
    </div>
  </section>;
}
