"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnnualMarketAppreciation } from "./AnnualMarketAppreciation";
import { BedroomChart, MonthlyCharts, PeriodComparison } from "./MarketCharts";
import { SuburbHeatmap } from "./SuburbHeatmap";
import { datesFor, displayMoney, monthLabel, monthlySeries, number, periodLabel, periods, salesCsv, variance, type BedroomFilter, type DateRange, type Insights, type MonthlyDatum, type SaleRow, type SnapshotTheme, type Suburb } from "@/lib/market-view";

type Dataset = { suburbKey: string; comparisonKey: string | null; months: number; bedroom: BedroomFilter; range: DateRange; series: { key: string; rows: SaleRow[]; insights: Insights }[] };
type PeerRow = {
  suburb_key: string;
  suburb: string;
  canonical_postcode: string;
  sale_count: number | string;
  priced_sales: number | string;
  median_price_aud: number | string | null;
  average_price_aud: number | string | null;
  minimum_price_aud: number | string | null;
  maximum_price_aud: number | string | null;
  p10_price_aud: number | string | null;
  p90_price_aud: number | string | null;
  sale_count_percentile: number | string | null;
  median_price_percentile: number | string | null;
};
type PeerDataset = { suburbKey: string; bedroom: BedroomFilter; range: DateRange; data: PeerRow[] };
type PeerFailure = { suburbKey: string; bedroom: BedroomFilter; range: DateRange; message: string };
const bedrooms: BedroomFilter[] = ["all", "1", "2", "3", "4", "5", "6"];
const snapshotBackground: Record<SnapshotTheme, string> = { warm: "#f8efea", corporate: "#eef4fb", excel: "#eef8f0", presentation: "#fff2e8" };
const suburbName = (name: string) => name.toLowerCase().replace(/\b\w/g, character => character.toUpperCase());
const signed = (value: number | null) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SalesExplorer() {
  const [suburbs, setSuburbs] = useState<Suburb[]>([]);
  const [suburbKey, setSuburbKey] = useState<string | null>(null);
  const [comparisonKey, setComparisonKey] = useState<string | null>(null);
  const [periodIndex, setPeriodIndex] = useState(1);
  const [bedroom, setBedroom] = useState<BedroomFilter>("all");
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [peerDataset, setPeerDataset] = useState<PeerDataset | null>(null);
  const [peerFailure, setPeerFailure] = useState<PeerFailure | null>(null);
  const [requestStatus, setRequestStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [rangeDate, setRangeDate] = useState(() => new Date());
  const [showAverage, setShowAverage] = useState(false);
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null);
  const [pinnedMonth, setPinnedMonth] = useState<string | null>(null);
  const [snapshotTheme, setSnapshotTheme] = useState<SnapshotTheme>("warm");
  const [exportStatus, setExportStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportVersion = useRef(0);
  const snapshotRef = useRef<HTMLDivElement>(null);
  const selected = suburbs.find(suburb => suburb.suburb_key === suburbKey) ?? null;
  const compared = suburbs.find(suburb => suburb.suburb_key === comparisonKey) ?? null;
  const selectedLabel = selected ? suburbName(selected.suburb) : "Selected suburb";
  const comparedLabel = compared ? suburbName(compared.suburb) : "Comparison suburb";
  const months = periods[periodIndex];
  const range = useMemo(() => datesFor(months, rangeDate), [months, rangeDate]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadSuburbs() {
      try {
        const response = await fetch("/api/analytics/suburbs", { signal: controller.signal });
        if (!response.ok) throw new Error("Suburb service unavailable");
        const json = await response.json();
        if (!Array.isArray(json.data)) throw new Error("Invalid suburb response");
        if (controller.signal.aborted) return;
        const result: Suburb[] = json.data;
        setSuburbs(result);
        const startingPoint = result.slice().sort((a, b) => Number(b.sale_count) - Number(a.sale_count))[0];
        setSuburbKey(current => current ?? startingPoint?.suburb_key ?? null);
        if (!result.length) { exportVersion.current++; setError("No suburb observations are available."); }
      } catch {
        if (!controller.signal.aborted) { exportVersion.current++; setError("Suburb search is temporarily unavailable."); }
      }
    }
    void loadSuburbs();
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!suburbKey) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setRequestStatus("loading");
      try {
        const series = await Promise.all([suburbKey, ...(comparisonKey ? [comparisonKey] : [])].map(async key => {
          const query = new URLSearchParams({ suburb_key: key, ...range, months: String(months), limit: "1200" });
          if (bedroom !== "all") query.set("bedrooms", bedroom);
          const label = key === suburbKey ? selectedLabel : comparedLabel;
          try {
            const [sales, insights] = await Promise.all([
              fetch(`/api/analytics/suburb-sales?${query}`, { signal: controller.signal }),
              fetch(`/api/analytics/suburb-insights?${query}`, { signal: controller.signal }),
            ]);
            if (!sales.ok || !insights.ok) throw new Error("Analytics service unavailable");
            const [salesJson, insightsJson] = await Promise.all([sales.json(), insights.json()]);
            if (!Array.isArray(salesJson.data) || !insightsJson.summary || !Array.isArray(insightsJson.bedrooms)) throw new Error("Invalid analytics response");
            return { key, rows: salesJson.data as SaleRow[], insights: insightsJson as Insights };
          } catch { throw new Error(`${label} analytics are temporarily unavailable.`); }
        }));
        if (controller.signal.aborted) return;
        setDataset({ suburbKey, comparisonKey, months, bedroom, range, series });
        setRequestStatus("ready");
      } catch (cause) {
        if (!controller.signal.aborted) {
          exportVersion.current++;
          setError(cause instanceof Error ? cause.message : "The analytical service did not respond.");
          setRequestStatus("idle");
        }
      }
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [suburbKey, comparisonKey, selectedLabel, comparedLabel, months, bedroom, range, retry]);

  useEffect(() => {
    if (!suburbKey) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ suburb_key: suburbKey, ...range });
    if (bedroom !== "all") query.set("bedrooms", bedroom);

    void fetch(`/api/analytics/postcode-peers?${query}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Postcode peer analytics are temporarily unavailable.");
        const json = await response.json();
        if (!Array.isArray(json.data)) throw new Error("Invalid postcode peer response");
        if (controller.signal.aborted) return;
        setPeerDataset({ suburbKey, bedroom, range, data: json.data as PeerRow[] });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setPeerFailure({
          suburbKey,
          bedroom,
          range,
          message: cause instanceof Error ? cause.message : "Postcode peer analytics are temporarily unavailable.",
        });
      });

    return () => controller.abort();
  }, [suburbKey, bedroom, range]);

  const current = dataset?.suburbKey === suburbKey && dataset.comparisonKey === comparisonKey && dataset.months === months && dataset.bedroom === bedroom && dataset.range.from === range.from && dataset.range.to === range.to ? dataset : null;
  const currentPeers = peerDataset?.suburbKey === suburbKey && peerDataset.bedroom === bedroom && peerDataset.range.from === range.from && peerDataset.range.to === range.to ? peerDataset.data : null;
  const currentPeerFailure = peerFailure?.suburbKey === suburbKey && peerFailure.bedroom === bedroom && peerFailure.range.from === range.from && peerFailure.range.to === range.to ? peerFailure.message : "";
  const peerLoading = Boolean(suburbKey) && !currentPeers && !currentPeerFailure;
  const loading = !error && (!selected || !current || requestStatus === "loading");
  const series = useMemo(() => monthlySeries(current?.series.map(item => ({ ...item, label: item.key === suburbKey ? selectedLabel : comparedLabel })) ?? [], range), [current, suburbKey, selectedLabel, comparedLabel, range]);
  const chartSeries = series.length ? series : [
    { key: suburbKey ?? "primary", label: selectedLabel, months: [], rolling: null, bedrooms: [] },
    ...(comparisonKey ? [{ key: comparisonKey, label: comparedLabel, months: [], rolling: null, bedrooms: [] }] : []),
  ];
  const monthly = series[0]?.months ?? [];
  const focusedMonth = pinnedMonth ?? hoveredMonth ?? monthly.at(-1)?.month ?? null;
  const canExport = Boolean(current?.series.some(item => item.rows.length)) && !loading && !error;

  function resetContext() { exportVersion.current++; setError(""); setHoveredMonth(null); setPinnedMonth(null); setExportStatus(""); }
  function retryRequest() { resetContext(); setRangeDate(new Date()); setRetry(value => value + 1); }
  function chooseSuburb(suburb: Suburb) { if (error && suburb.suburb_key === suburbKey) retryRequest(); else resetContext(); setSuburbKey(suburb.suburb_key); if (suburb.suburb_key === comparisonKey) setComparisonKey(null); }
  function chooseComparison(suburb: Suburb) { if (suburb.suburb_key === suburbKey) return; if (error && suburb.suburb_key === comparisonKey) retryRequest(); else resetContext(); setComparisonKey(suburb.suburb_key); }
  function clearComparison() { resetContext(); setComparisonKey(null); }
  function choosePeriod(index: number) { if (error && index === periodIndex) retryRequest(); else resetContext(); setPeriodIndex(index); }
  function chooseBedroom(value: BedroomFilter) { if (error && value === bedroom) retryRequest(); else resetContext(); setBedroom(value); }
  const focusMonth = useCallback((value: string | null) => setHoveredMonth(value), []);
  const pinMonth = useCallback((value: string) => setPinnedMonth(current => current === value ? null : value), []);

  function downloadCsv() {
    if (!current) return;
    const csv = salesCsv(current.series.flatMap(item => item.rows));
    saveFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${current.series.map(item => item.key).join("-vs-")}-${current.range.from}-${current.range.to}-${current.bedroom}-bed-sales.csv`);
  }

  async function exportSnapshot(copy: boolean) {
    if (!snapshotRef.current || !canExport || exporting) return;
    const version = exportVersion.current;
    const unchanged = () => { if (version !== exportVersion.current) throw new Error("View changed during export"); };
    setExporting(true);
    setExportStatus("Preparing image…");
    try {
      await document.fonts?.ready;
      const { toBlob } = await import("html-to-image");
      unchanged();
      if (!snapshotRef.current) throw new Error("Snapshot unavailable");
      const blob = await toBlob(snapshotRef.current, { backgroundColor: snapshotBackground[snapshotTheme], cacheBust: true, pixelRatio: 2 });
      unchanged();
      if (!blob) throw new Error("No image produced");
      if (copy && navigator.clipboard?.write && "ClipboardItem" in window) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          setExportStatus("Image copied.");
          return;
        } catch { /* Download remains available when image clipboard permission is unavailable. */ }
      }
      saveFile(blob, `${[suburbKey, comparisonKey].filter(Boolean).join("-vs-")}-${range.from}-${range.to}-${snapshotTheme}.png`);
      setExportStatus(copy ? "Image downloaded; clipboard unavailable." : "Image downloaded.");
    } catch { setExportStatus(version !== exportVersion.current ? "View changed. Export again." : "Image export failed. CSV remains available."); }
    finally { setExporting(false); }
  }

  return <section className="explorer" aria-label="House sales dashboard">
    <div className="dashboard-toolbar">
      <div className="suburb-selection">
        <SuburbPicker suburbs={suburbs} selected={selected} onSelect={chooseSuburb} />
        <div className="comparison-selection"><SuburbPicker suburbs={suburbs} selected={compared} onSelect={chooseComparison} id="comparison-suburb-search" label="Compare" emptyLabel="Add suburb" excludedKey={suburbKey} />{compared && <button className="remove-comparison" type="button" aria-label="Remove comparison suburb" onClick={clearComparison}>×</button>}</div>
      </div>
      <div className="toolbar-filters">
        <fieldset className="filter-group"><legend>Window</legend><div className="segmented" aria-label="Completed-month window">{periods.map((value, index) => <button key={value} type="button" aria-pressed={periodIndex === index} onClick={() => choosePeriod(index)}>{value}m</button>)}</div></fieldset>
        <fieldset className="filter-group"><legend>Bedrooms</legend><div className="segmented" aria-label="Bedroom filter">{bedrooms.map(value => <button key={value} type="button" aria-pressed={bedroom === value} onClick={() => chooseBedroom(value)}>{value === "all" ? "All" : value}</button>)}</div></fieldset>
      </div>
      <details className="export-menu"><summary>Export <span aria-hidden="true">↗</span></summary><div className="export-panel">
        <label htmlFor="snapshot-style">Image style</label><select id="snapshot-style" value={snapshotTheme} onChange={event => { exportVersion.current++; setExportStatus(""); setSnapshotTheme(event.target.value as SnapshotTheme); }}><option value="warm">Warm</option><option value="corporate">Blue</option><option value="excel">Green</option><option value="presentation">Orange</option></select>
        <button type="button" disabled={!canExport || exporting} onClick={() => void exportSnapshot(true)}>Copy image</button><button type="button" disabled={!canExport || exporting} onClick={() => void exportSnapshot(false)}>Download PNG</button><button type="button" disabled={!canExport} onClick={downloadCsv}>Download CSV</button><span role="status">{exportStatus}</span>
      </div></details>
    </div>

    {error && <div className="service-error" role="alert"><span>{error}</span><button type="button" onClick={retryRequest}>Retry</button></div>}
    <div className="dashboard-snapshot" data-snapshot-theme={snapshotTheme} ref={snapshotRef} aria-busy={loading}>
      <header className="dashboard-title"><div><h1>{selected ? selectedLabel : "House sales"}{compared && ` vs ${comparedLabel}`}<span>{selected?.canonical_postcode}{compared && ` / ${compared.canonical_postcode}`}</span></h1><div className="context-chips"><span>{periodLabel(range)}</span><span>{bedroom === "all" ? "All bedrooms" : `${bedroom} bedrooms`}</span><span>Completed months</span><details className="coverage-info"><summary>Coverage ⓘ</summary><span>Recorded observations. Coverage varies by suburb and period; prices use disclosed amounts.</span></details></div></div><span className="update-status" role="status">{loading ? "Loading…" : error ? "Unavailable" : compared ? "Comparing 2 suburbs" : `${number.format(Number(current?.series[0]?.insights.summary.sale_count ?? 0))} recorded sales`}</span></header>
      {!error && <>
      {chartSeries.map((item, index) => <div className="suburb-metrics" key={item.key}>{compared && <h2 className={`series-heading ${index ? "secondary-series" : "primary-series"}`}>{item.label}</h2>}<SummaryMetrics insights={current?.series.find(data => data.key === item.key)?.insights ?? null} loading={loading} label={item.label} /></div>)}

      <div className="chart-controls"><label><input type="checkbox" checked={showAverage} onChange={event => setShowAverage(event.target.checked)} /> Average price</label><span>{pinnedMonth ? "Month pinned" : "Select a month"}</span></div>
      <MonthlyCharts series={chartSeries} loading={loading} showAverage={showAverage} activeMonth={focusedMonth} onMonthFocus={focusMonth} onMonthSelect={pinMonth} />
      <SuburbHeatmap />
      <div className="month-readouts">{chartSeries.map(item => <MonthReadout key={item.key} label={compared ? item.label : undefined} month={item.months.find(row => row.month === focusedMonth) ?? null} loading={loading} pinned={Boolean(pinnedMonth)} onClear={() => setPinnedMonth(null)} />)}</div>
      <div className="secondary-grid"><PeriodComparison series={chartSeries} loading={loading} /><BedroomChart series={chartSeries} activeBedroom={bedroom} loading={loading} onSelect={chooseBedroom} /></div>
      <PostcodePeerComparison data={currentPeers} selectedKey={suburbKey} postcode={selected?.canonical_postcode ?? null} loading={peerLoading || !currentPeers} error={currentPeerFailure} />
      <AnnualMarketAppreciation />

      <details className="data-table"><summary>Monthly data <span>{monthly.length} months{compared && " · 2 suburbs"}</span></summary><div className="table-scroll"><table><caption className="sr-only">{selectedLabel}{compared && ` and ${comparedLabel}`} monthly recorded sale observations</caption><thead><tr><th scope="col">Month</th>{compared && <th scope="col">Suburb</th>}<th scope="col">Recorded sales</th><th scope="col">Median</th><th scope="col">Average</th><th scope="col">Minimum</th><th scope="col">Maximum</th></tr></thead><tbody>{monthly.flatMap(month => series.map(item => ({ item, row: item.months.find(row => row.month === month.month)! }))).map(({ item, row }) => <tr key={`${item.key}-${row.month}`} data-active={row.month === focusedMonth}><th scope="row"><button type="button" aria-pressed={pinnedMonth === row.month} onClick={() => pinMonth(row.month)}>{row.label}</button></th>{compared && <td>{item.label}</td>}<td>{number.format(row.sales)}{!row.observed && <span className="sr-only">; no recorded observations, coverage may be unavailable</span>}</td><td>{displayMoney(row.median)}</td><td>{displayMoney(row.average)}</td><td>{displayMoney(row.minimum)}</td><td>{displayMoney(row.maximum)}</td></tr>)}</tbody></table></div></details>
      <footer className="dashboard-credit"><strong>Perth House Data</strong><span>{selected ? `${selectedLabel} · ${selected.canonical_postcode}${compared ? ` vs ${comparedLabel} · ${compared.canonical_postcode}` : ""} · ` : ""}{periodLabel(range)} · {bedroom === "all" ? "All bedrooms" : `${bedroom} bedrooms`}</span><span>Recorded House observations · perthhousedata.com</span></footer>
      </>}
    </div>
  </section>;
}

function PostcodePeerComparison({ data, selectedKey, postcode, loading, error }: { data: PeerRow[] | null; selectedKey: string | null; postcode: string | null; loading: boolean; error: string }) {
  const selected = data?.find(row => row.suburb_key === selectedKey) ?? null;
  const countBounds = data?.length ? [
    Math.min(...data.map(row => Number(row.sale_count))),
    Math.max(...data.map(row => Number(row.sale_count))),
  ] as const : null;
  const priceBounds = data?.flatMap(row => [row.minimum_price_aud, row.maximum_price_aud])
    .filter((value): value is number | string => value != null)
    .map(Number) ?? [];
  const typicalBounds = data?.flatMap(row => [row.p10_price_aud, row.p90_price_aud])
    .filter((value): value is number | string => value != null)
    .map(Number) ?? [];
  const priceRange = (values: number[]) => values.length ? `${displayMoney(Math.min(...values))} – ${displayMoney(Math.max(...values))}` : "—";
  const percentile = (value: number | string | null) => value == null ? "—" : `P${Math.round(Number(value))}`;
  const selectedSummary = selected
    ? `${number.format(Number(selected.sale_count))} sales · ${data && data.length > 1 ? `${percentile(selected.sale_count_percentile)} by sales` : "no peer areas"}`
    : "Selected suburb peer analysis";

  return <details className="data-table peer-comparison" aria-busy={loading}>
    <summary><span>Postcode peer comparison · {postcode ?? "—"}</span><span>{loading ? "Loading…" : error ? "Unavailable" : `${data?.length ?? 0} areas · ${selectedSummary}`}</span></summary>
    {error ? <p className="peer-error" role="status">{error}</p> : loading ? <p className="peer-note">Calculating peer distributions for the selected period and bedroom filter…</p> : data?.length ? <>
      <p className="peer-note">Postcode-level comparison of recorded house sales for the selected filters, including the selected suburb. Percentiles describe relative position within this group, not a forecast.</p>
      <div className="peer-range-grid">
        <div><span>Sales per suburb</span><strong>{countBounds ? `${number.format(countBounds[0])} – ${number.format(countBounds[1])}` : "—"}</strong></div>
        <div><span>Observed price bounds</span><strong>{priceRange(priceBounds)}</strong></div>
        <div><span>Combined 10th–90th price span</span><strong>{priceRange(typicalBounds)}</strong></div>
        <div><span>Selected suburb · median</span><strong>{selected ? displayMoney(selected.median_price_aud) : "—"}</strong></div>
      </div>
      <div className="table-scroll"><table>
        <caption className="sr-only">Suburb sales and price distributions in postcode {postcode}</caption>
        <thead><tr><th scope="col">Suburb</th><th scope="col">Sales</th><th scope="col">Price coverage</th><th scope="col">Median</th><th scope="col">Average</th><th scope="col">Observed range</th><th scope="col">Sales percentile</th><th scope="col">Median percentile</th></tr></thead>
        <tbody>{data.map(row => {
          const sales = Number(row.sale_count);
          const priced = Number(row.priced_sales);
          const coverage = sales ? `${Math.round(priced / sales * 100)}%` : "—";
          return <tr key={row.suburb_key} data-active={row.suburb_key === selectedKey}>
            <th scope="row">{suburbName(row.suburb)}</th>
            <td>{number.format(sales)}</td>
            <td>{coverage}</td>
            <td>{displayMoney(row.median_price_aud)}</td>
            <td>{displayMoney(row.average_price_aud)}</td>
            <td>{priceRange([row.minimum_price_aud, row.maximum_price_aud].filter((value): value is number | string => value != null).map(Number))}</td>
            <td>{percentile(row.sale_count_percentile)}</td>
            <td>{percentile(row.median_price_percentile)}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </> : <p className="peer-note">No peer sales are available for these filters.</p>}
  </details>;
}

function MetricDelta({ value, loading }: { value: number | null; loading: boolean }) {
  return <span className={`metric-caption metric-delta ${value != null && value < 0 ? "decrease" : ""}`}><strong>{loading ? "—" : signed(value)}</strong> vs previous period</span>;
}

function SummaryMetrics({ insights, loading, label }: { insights: Insights | null; loading: boolean; label: string }) {
  const summary = insights?.summary;
  const rolling = insights?.rolling;
  const unavailable = loading || !summary;
  const salesCount = Number(summary?.sale_count ?? 0);
  const pricedCount = Number(summary?.priced_sales ?? 0);
  const coverage = salesCount ? pricedCount / salesCount * 100 : null;
  return <div className="metric-grid" aria-label={`${label} summary`}>
    <article className="metric-card"><span className="metric-label">Median price</span><strong className="metric-value">{unavailable ? "—" : displayMoney(summary.median_price_aud)}</strong><MetricDelta value={variance(rolling?.current_median_price_aud ?? null, rolling?.prior_median_price_aud ?? null)} loading={unavailable} /></article>
    <article className="metric-card"><span className="metric-label">Average price</span><strong className="metric-value">{unavailable ? "—" : displayMoney(summary.average_price_aud)}</strong><span className="metric-caption">{unavailable ? "—" : `${number.format(pricedCount)} disclosed prices`}</span></article>
    <article className="metric-card"><span className="metric-label">Recorded sales</span><strong className="metric-value">{unavailable ? "—" : number.format(salesCount)}</strong><MetricDelta value={variance(rolling?.current_sale_count ?? null, rolling?.prior_sale_count ?? null)} loading={unavailable} /></article>
    <article className="metric-card"><span className="metric-label">Price coverage</span><strong className="metric-value">{unavailable || coverage == null ? "—" : `${coverage.toFixed(0)}%`}</strong>{!unavailable && coverage != null ? <div className="coverage-track" role="meter" aria-label={`${label} price disclosure coverage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage}><i style={{ width: `${coverage}%` }} /></div> : <div className="coverage-track" aria-hidden="true" />}<span className="metric-caption">{unavailable ? "—" : `${number.format(pricedCount)} / ${number.format(salesCount)} priced`}</span></article>
  </div>;
}

function MonthReadout({ month, label, loading, pinned, onClear }: { month: MonthlyDatum | null; label?: string; loading: boolean; pinned: boolean; onClear: () => void }) {
  return <div className="month-readout" aria-label={label ? `${label} selected month details` : "Selected month details"}><strong>{label && <span>{label} · </span>}{loading || !month ? "Month details" : monthLabel(month.month)}</strong><dl><div><dt>Recorded sales</dt><dd>{loading || !month ? "—" : number.format(month.sales)}</dd></div><div><dt>Median</dt><dd>{loading ? "—" : displayMoney(month?.median ?? null)}</dd></div><div><dt>Average</dt><dd>{loading ? "—" : displayMoney(month?.average ?? null)}</dd></div><div><dt>Price range</dt><dd>{loading || month?.minimum == null ? "—" : `${displayMoney(month.minimum)} – ${displayMoney(month.maximum)}`}</dd></div></dl>{pinned && <button type="button" onClick={onClear}>Clear selection</button>}{month && !month.observed && <span className="month-empty">No recorded observations</span>}</div>;
}

function SuburbPicker({ suburbs, selected, onSelect, id = "suburb-search", label = "Suburb", emptyLabel = "Loading suburbs…", excludedKey }: { suburbs: Suburb[]; selected: Suburb | null; onSelect: (suburb: Suburb) => void; id?: string; label?: string; emptyLabel?: string; excludedKey?: string | null }) {
  const [query, setQuery] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const search = query.trim().toLowerCase();
    const available = suburbs.filter(suburb => suburb.suburb_key !== excludedKey);
    return (search ? available.filter(suburb => `${suburb.suburb} ${suburb.canonical_postcode}`.toLowerCase().includes(search)) : available.sort((a, b) => Number(b.sale_count) - Number(a.sale_count))).slice(0, 10);
  }, [suburbs, query, excludedKey]);
  function choose(suburb: Suburb) { onSelect(suburb); setQuery(""); if (details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } }
  return <details className="suburb-picker" ref={details} onToggle={event => { if (event.currentTarget.open) input.current?.focus(); }}><summary className="picker-trigger" aria-label={`${label}: ${selected ? suburbName(selected.suburb) : emptyLabel}`}><span>{label}</span><strong>{selected ? suburbName(selected.suburb) : emptyLabel}</strong><span aria-hidden="true">⌄</span></summary><div className="picker-panel"><label className="sr-only" htmlFor={id}>{label === "Compare" ? "Search comparison suburb or postcode" : "Search suburb or postcode"}</label><input id={id} ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } if (event.key === "Enter" && matches[0]) choose(matches[0]); }} placeholder="Suburb or postcode" autoComplete="off" /><div className="picker-results">{matches.map(suburb => <button type="button" key={suburb.suburb_key} aria-pressed={selected?.suburb_key === suburb.suburb_key} onClick={() => choose(suburb)}><strong>{suburbName(suburb.suburb)}</strong><span>{suburb.canonical_postcode}</span></button>)}</div>{!matches.length && <p className="picker-empty">No matching suburb</p>}</div></details>;
}
