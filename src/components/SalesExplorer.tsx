"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BedroomChart, MonthlyCharts, PeriodComparison } from "./MarketCharts";
import { datesFor, displayMoney, monthLabel, monthlyData, number, periodLabel, periods, variance, type BedroomFilter, type DateRange, type Insights, type MonthlyDatum, type SaleRow, type SnapshotTheme, type Suburb } from "@/lib/market-view";

type Dataset = { suburbKey: string; months: number; bedroom: BedroomFilter; range: DateRange; rows: SaleRow[]; insights: Insights };
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
  const [periodIndex, setPeriodIndex] = useState(1);
  const [bedroom, setBedroom] = useState<BedroomFilter>("all");
  const [dataset, setDataset] = useState<Dataset | null>(null);
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
      const query = new URLSearchParams({ suburb_key: suburbKey, ...range, months: String(months), limit: "1200" });
      if (bedroom !== "all") query.set("bedrooms", bedroom);
      try {
        const [sales, insights] = await Promise.all([
          fetch(`/api/analytics/suburb-sales?${query}`, { signal: controller.signal }),
          fetch(`/api/analytics/suburb-insights?${query}`, { signal: controller.signal }),
        ]);
        if (!sales.ok || !insights.ok) throw new Error("Analytics service unavailable");
        const [salesJson, insightsJson] = await Promise.all([sales.json(), insights.json()]);
        if (!Array.isArray(salesJson.data) || !insightsJson.summary || !Array.isArray(insightsJson.bedrooms)) throw new Error("Invalid analytics response");
        if (controller.signal.aborted) return;
        setDataset({ suburbKey, months, bedroom, range, rows: salesJson.data, insights: insightsJson });
        setRequestStatus("ready");
      } catch {
        if (!controller.signal.aborted) {
          exportVersion.current++;
          setError("The analytical service did not respond.");
          setRequestStatus("idle");
        }
      }
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [suburbKey, months, bedroom, range, retry]);

  const current = dataset?.suburbKey === suburbKey && dataset.months === months && dataset.bedroom === bedroom && dataset.range.from === range.from && dataset.range.to === range.to ? dataset : null;
  const loading = !error && (!selected || !current || requestStatus === "loading");
  const monthly = useMemo(() => current ? monthlyData(current.rows, current.range) : [], [current]);
  const summary = current?.insights.summary;
  const unavailable = loading || !summary;
  const rolling = current?.insights.rolling ?? null;
  const salesCount = Number(summary?.sale_count ?? 0);
  const pricedCount = Number(summary?.priced_sales ?? 0);
  const coverage = salesCount ? pricedCount / salesCount * 100 : null;
  const focusedMonth = pinnedMonth ?? hoveredMonth ?? monthly.at(-1)?.month ?? null;
  const month = monthly.find(row => row.month === focusedMonth) ?? null;
  const canExport = Boolean(current?.rows.length) && !loading && !error;

  function resetContext() { exportVersion.current++; setError(""); setHoveredMonth(null); setPinnedMonth(null); setExportStatus(""); }
  function retryRequest() { resetContext(); setRangeDate(new Date()); setRetry(value => value + 1); }
  function chooseSuburb(suburb: Suburb) { if (error && suburb.suburb_key === suburbKey) retryRequest(); else resetContext(); setSuburbKey(suburb.suburb_key); }
  function choosePeriod(index: number) { if (error && index === periodIndex) retryRequest(); else resetContext(); setPeriodIndex(index); }
  function chooseBedroom(value: BedroomFilter) { if (error && value === bedroom) retryRequest(); else resetContext(); setBedroom(value); }
  const focusMonth = useCallback((value: string | null) => setHoveredMonth(value), []);
  const pinMonth = useCallback((value: string) => setPinnedMonth(current => current === value ? null : value), []);

  function downloadCsv() {
    if (!current) return;
    const columns: (keyof SaleRow)[] = ["suburb", "postcode", "sale_month", "sale_count", "median_price_aud", "average_price_aud", "minimum_price_aud", "maximum_price_aud"];
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = current.rows.slice().sort((a, b) => a.sale_month.localeCompare(b.sale_month));
    const csv = [columns.join(","), ...rows.map(row => columns.map(column => cell(row[column])).join(","))].join("\n");
    saveFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${current.suburbKey}-${current.range.from}-${current.range.to}-${current.bedroom}-bed-sales.csv`);
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
      saveFile(blob, `${suburbKey}-${range.from}-${range.to}-${snapshotTheme}.png`);
      setExportStatus(copy ? "Image downloaded; clipboard unavailable." : "Image downloaded.");
    } catch { setExportStatus(version !== exportVersion.current ? "View changed. Export again." : "Image export failed. CSV remains available."); }
    finally { setExporting(false); }
  }

  return <section className="explorer" aria-label="House sales dashboard">
    <div className="dashboard-toolbar">
      <SuburbPicker suburbs={suburbs} selected={selected} onSelect={chooseSuburb} />
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
      <header className="dashboard-title"><div><h1>{selected ? suburbName(selected.suburb) : "House sales"}<span>{selected?.canonical_postcode}</span></h1><div className="context-chips"><span>{periodLabel(range)}</span><span>{bedroom === "all" ? "All bedrooms" : `${bedroom} bedrooms`}</span><span>Completed months</span><details className="coverage-info"><summary>Coverage ⓘ</summary><span>Recorded observations. Coverage varies by suburb and period; prices use disclosed amounts.</span></details></div></div><span className="update-status" role="status">{loading ? "Loading…" : error ? "Unavailable" : `${number.format(salesCount)} recorded sales`}</span></header>
      {!error && <>
      <div className="metric-grid">
        <article className="metric-card"><span className="metric-label">Median price</span><strong className="metric-value">{unavailable ? "—" : displayMoney(summary.median_price_aud)}</strong><MetricDelta value={variance(rolling?.current_median_price_aud ?? null, rolling?.prior_median_price_aud ?? null)} loading={unavailable} /></article>
        <article className="metric-card"><span className="metric-label">Average price</span><strong className="metric-value">{unavailable ? "—" : displayMoney(summary.average_price_aud)}</strong><span className="metric-caption">{unavailable ? "—" : `${number.format(pricedCount)} disclosed prices`}</span></article>
        <article className="metric-card"><span className="metric-label">Recorded sales</span><strong className="metric-value">{unavailable ? "—" : number.format(salesCount)}</strong><MetricDelta value={variance(rolling?.current_sale_count ?? null, rolling?.prior_sale_count ?? null)} loading={unavailable} /></article>
        <article className="metric-card"><span className="metric-label">Price coverage</span><strong className="metric-value">{unavailable || coverage == null ? "—" : `${coverage.toFixed(0)}%`}</strong>{!unavailable && coverage != null ? <div className="coverage-track" role="meter" aria-label="Price disclosure coverage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage}><i style={{ width: `${coverage}%` }} /></div> : <div className="coverage-track" aria-hidden="true" />}<span className="metric-caption">{unavailable ? "—" : `${number.format(pricedCount)} / ${number.format(salesCount)} priced`}</span></article>
      </div>

      <div className="chart-controls"><label><input type="checkbox" checked={showAverage} onChange={event => setShowAverage(event.target.checked)} /> Average price</label><span>{pinnedMonth ? "Month pinned" : "Select a month"}</span></div>
      <MonthlyCharts months={monthly} loading={loading} showAverage={showAverage} activeMonth={focusedMonth} onMonthFocus={focusMonth} onMonthSelect={pinMonth} />
      <MonthReadout month={month} loading={loading} pinned={Boolean(pinnedMonth)} onClear={() => setPinnedMonth(null)} />
      <div className="secondary-grid"><PeriodComparison rolling={rolling} loading={loading} /><BedroomChart rows={current?.insights.bedrooms ?? []} activeBedroom={bedroom} loading={loading} onSelect={chooseBedroom} /></div>

      <details className="data-table"><summary>Monthly data <span>{monthly.length} months</span></summary><div className="table-scroll"><table><caption className="sr-only">{selected ? suburbName(selected.suburb) : "Selected suburb"} monthly recorded sale observations</caption><thead><tr><th scope="col">Month</th><th scope="col">Recorded sales</th><th scope="col">Median</th><th scope="col">Average</th><th scope="col">Minimum</th><th scope="col">Maximum</th></tr></thead><tbody>{monthly.map(row => <tr key={row.month} data-active={row.month === focusedMonth}><th scope="row"><button type="button" aria-pressed={pinnedMonth === row.month} onClick={() => pinMonth(row.month)}>{row.label}</button></th><td>{number.format(row.sales)}{!row.observed && <span className="sr-only">; no recorded observations, coverage may be unavailable</span>}</td><td>{displayMoney(row.median)}</td><td>{displayMoney(row.average)}</td><td>{displayMoney(row.minimum)}</td><td>{displayMoney(row.maximum)}</td></tr>)}</tbody></table></div></details>
      <footer className="dashboard-credit"><strong>Perth House Data</strong><span>{selected ? `${suburbName(selected.suburb)} · ${selected.canonical_postcode} · ` : ""}{periodLabel(range)} · {bedroom === "all" ? "All bedrooms" : `${bedroom} bedrooms`}</span><span>Recorded House observations · perthhousedata.com</span></footer>
      </>}
    </div>
  </section>;
}

function MetricDelta({ value, loading }: { value: number | null; loading: boolean }) {
  return <span className={`metric-caption metric-delta ${value != null && value < 0 ? "decrease" : ""}`}><strong>{loading ? "—" : signed(value)}</strong> vs previous period</span>;
}

function MonthReadout({ month, loading, pinned, onClear }: { month: MonthlyDatum | null; loading: boolean; pinned: boolean; onClear: () => void }) {
  return <div className="month-readout" aria-label="Selected month details"><strong>{loading || !month ? "Month details" : monthLabel(month.month)}</strong><dl><div><dt>Recorded sales</dt><dd>{loading || !month ? "—" : number.format(month.sales)}</dd></div><div><dt>Median</dt><dd>{loading ? "—" : displayMoney(month?.median ?? null)}</dd></div><div><dt>Average</dt><dd>{loading ? "—" : displayMoney(month?.average ?? null)}</dd></div><div><dt>Price range</dt><dd>{loading || month?.minimum == null ? "—" : `${displayMoney(month.minimum)} – ${displayMoney(month.maximum)}`}</dd></div></dl>{pinned ? <button type="button" onClick={onClear}>Clear selection</button> : month && !month.observed ? <span className="month-empty">No recorded observations</span> : null}</div>;
}

function SuburbPicker({ suburbs, selected, onSelect }: { suburbs: Suburb[]; selected: Suburb | null; onSelect: (suburb: Suburb) => void }) {
  const [query, setQuery] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (search ? suburbs.filter(suburb => `${suburb.suburb} ${suburb.canonical_postcode}`.toLowerCase().includes(search)) : suburbs.slice().sort((a, b) => Number(b.sale_count) - Number(a.sale_count))).slice(0, 10);
  }, [suburbs, query]);
  function choose(suburb: Suburb) { onSelect(suburb); setQuery(""); if (details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } }
  return <details className="suburb-picker" ref={details} onToggle={event => { if (event.currentTarget.open) input.current?.focus(); }}><summary className="picker-trigger"><span>Suburb</span><strong>{selected ? suburbName(selected.suburb) : "Loading suburbs…"}</strong><span aria-hidden="true">⌄</span></summary><div className="picker-panel"><label className="sr-only" htmlFor="suburb-search">Search suburb or postcode</label><input id="suburb-search" ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } if (event.key === "Enter" && matches[0]) choose(matches[0]); }} placeholder="Suburb or postcode" autoComplete="off" /><div className="picker-results">{matches.map(suburb => <button type="button" key={suburb.suburb_key} aria-pressed={selected?.suburb_key === suburb.suburb_key} onClick={() => choose(suburb)}><strong>{suburbName(suburb.suburb)}</strong><span>{suburb.canonical_postcode}</span></button>)}</div>{!matches.length && <p className="picker-empty">No matching suburb</p>}</div></details>;
}
