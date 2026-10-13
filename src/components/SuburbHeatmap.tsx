"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { monthLabel, number } from "@/lib/market-view";

type Position = number[];
type PolygonGeometry = { type: "Polygon"; coordinates: Position[][] };
type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Position[][][] };
type BoundaryFeature = {
  type: "Feature";
  properties: { SAL_NAME21: string; SAL_CODE21: string; STE_CODE21: string };
  geometry: PolygonGeometry | MultiPolygonGeometry;
};
type BoundaryCollection = { type: "FeatureCollection"; features: BoundaryFeature[] };
type HeatmapRow = { suburb_key: string; suburb: string; postcode: string; sale_count: number | string };
type HeatmapResponse = {
  data: HeatmapRow[];
  meta: { firstMonth: string | null; latestMonth: string | null; month: string | null; window: number; observedMonths?: number; from?: string; to?: string };
};
type MappedBoundary = { key: string; name: string; code: string; path: string };
type Metric = "volume" | "velocity";

const windows = [1, 3, 6, 12] as const;
const mapWidth = 960;
const mapHeight = 640;
const mapPadding = 22;
const cacheLimit = 96;

function suburbKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function monthIndex(month: string) {
  const [year, value] = month.split("-").map(Number);
  return year * 12 + value - 1;
}

function monthFromIndex(index: number) {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function polygonRings(geometry: BoundaryFeature["geometry"]): Position[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function boundaryPath(geometry: BoundaryFeature["geometry"], project: (position: Position) => [number, number]) {
  return polygonRings(geometry).flatMap(polygon => polygon).map(ring => {
    if (!ring.length) return "";
    return `${ring.map((position, index) => {
      const [x, y] = project(position);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join("")}Z`;
  }).join("");
}

function buildBoundaries(collection: BoundaryCollection): MappedBoundary[] {
  const positions = collection.features.flatMap(feature => polygonRings(feature.geometry).flatMap(polygon => polygon.flat()));
  if (!positions.length) throw new Error("No Perth suburb boundaries were found.");
  const centerLatitude = positions.reduce((sum, position) => sum + position[1], 0) / positions.length;
  const longitudeFactor = Math.cos(centerLatitude * Math.PI / 180);
  const projected = positions.map(position => [position[0] * longitudeFactor, position[1]] as const);
  const minX = Math.min(...projected.map(position => position[0]));
  const maxX = Math.max(...projected.map(position => position[0]));
  const minY = Math.min(...projected.map(position => position[1]));
  const maxY = Math.max(...projected.map(position => position[1]));
  const scale = Math.min(
    (mapWidth - mapPadding * 2) / (maxX - minX),
    (mapHeight - mapPadding * 2) / (maxY - minY),
  );
  const offsetX = (mapWidth - (maxX - minX) * scale) / 2;
  const offsetY = (mapHeight - (maxY - minY) * scale) / 2;
  const project = (position: Position): [number, number] => [
    offsetX + (position[0] * longitudeFactor - minX) * scale,
    mapHeight - offsetY - (position[1] - minY) * scale,
  ];
  return collection.features.map(feature => ({
    key: suburbKey(feature.properties.SAL_NAME21),
    name: feature.properties.SAL_NAME21,
    code: feature.properties.SAL_CODE21,
    path: boundaryPath(feature.geometry, project),
  }));
}

function numericCount(value: number | string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function SuburbHeatmap() {
  const [boundaries, setBoundaries] = useState<MappedBoundary[]>([]);
  const [boundaryError, setBoundaryError] = useState("");
  const [rows, setRows] = useState<HeatmapRow[]>([]);
  const [firstMonth, setFirstMonth] = useState<string | null>(null);
  const [latestMonth, setLatestMonth] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [windowSize, setWindowSize] = useState<number>(3);
  const [observedMonths, setObservedMonths] = useState(3);
  const [metric, setMetric] = useState<Metric>("volume");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const cache = useRef(new Map<string, { data: HeatmapRow[]; meta: HeatmapResponse["meta"] }>());

  useEffect(() => {
    const controller = new AbortController();
    async function loadBoundaries() {
      try {
        const response = await fetch("/perth-suburbs.geojson", { signal: controller.signal });
        if (!response.ok) throw new Error("Perth suburb boundaries are unavailable.");
        const collection = await response.json() as BoundaryCollection;
        if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
          throw new Error("The suburb boundary file is invalid.");
        }
        const features = collection.features.filter(feature =>
          feature.type === "Feature" && feature.properties?.STE_CODE21 === "5" &&
          typeof feature.properties.SAL_NAME21 === "string" && feature.geometry &&
          (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"),
        );
        setBoundaries(buildBoundaries({ type: "FeatureCollection", features }));
      } catch (cause) {
        if (!controller.signal.aborted) setBoundaryError(cause instanceof Error ? cause.message : "Perth suburb boundaries could not be loaded.");
      }
    }
    void loadBoundaries();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const requestMonth = selectedMonth;
    const key = `${requestMonth ?? "latest"}:${windowSize}`;
    const cached = cache.current.get(key);
    if (cached) {
      setRows(cached.data);
      setFirstMonth(cached.meta.firstMonth);
      setLatestMonth(cached.meta.latestMonth);
      setSelectedMonth(cached.meta.month);
      setObservedMonths(cached.meta.observedMonths ?? cached.meta.window);
      setError("");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ window: String(windowSize) });
        if (requestMonth) query.set("month", requestMonth);
        const response = await fetch(`/api/analytics/sales-heatmap?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Sales activity could not be loaded.");
        const result = await response.json() as HeatmapResponse;
        if (!Array.isArray(result.data) || !result.meta) throw new Error("The sales activity response is invalid.");
        if (controller.signal.aborted) return;
        setRows(result.data);
        setFirstMonth(result.meta.firstMonth);
        setLatestMonth(result.meta.latestMonth);
        setSelectedMonth(result.meta.month);
        setObservedMonths(result.meta.observedMonths ?? result.meta.window);
        const resolvedKey = `${result.meta.month ?? "latest"}:${windowSize}`;
        cache.current.set(resolvedKey, result);
        if (cache.current.size > cacheLimit) cache.current.delete(cache.current.keys().next().value!);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Sales activity could not be loaded.");
          setPlaying(false);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [selectedMonth, windowSize, latestMonth, reloadKey]);

  const rowByKey = useMemo(() => new Map(rows.map(row => [row.suburb_key, row])), [rows]);
  const featureByKey = useMemo(() => new Map(boundaries.map(feature => [feature.key, feature])), [boundaries]);
  const values = useMemo(() => boundaries.flatMap(feature => {
    const row = rowByKey.get(feature.key);
    return row ? [metric === "volume" ? numericCount(row.sale_count) : numericCount(row.sale_count) / observedMonths] : [];
  }).filter(value => value > 0).sort((left, right) => left - right), [boundaries, rowByKey, metric, observedMonths]);
  const thresholds = useMemo(() => [...new Set([0.2, 0.4, 0.6, 0.8]
    .map(quantile => values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)] ?? 0)
    .filter((value, index, all) => value > 0 && value < (values.at(-1) ?? 0) && all.indexOf(value) === index))], [values]);

  const currentFeature = selectedKey ? featureByKey.get(selectedKey) ?? null : null;
  const currentRow = selectedKey ? rowByKey.get(selectedKey) ?? null : null;
  const mappedSales = useMemo(() => boundaries.reduce((total, feature) => total + numericCount(rowByKey.get(feature.key)?.sale_count), 0), [boundaries, rowByKey]);
  const latestIndex = latestMonth ? monthIndex(latestMonth) : null;
  const firstIndex = firstMonth ? monthIndex(firstMonth) : null;
  const selectedIndex = selectedMonth ? monthIndex(selectedMonth) : null;
  const selectedLabel = selectedMonth ? monthLabel(`${selectedMonth}-01`) : "No available months";

  function colorLevel(value: number) {
    return thresholds.findIndex(threshold => value <= threshold) + 1 || thresholds.length + 1;
  }

  function selectBoundary(key: string) {
    setSelectedKey(key);
  }

  function onBoundaryKeyDown(event: KeyboardEvent<SVGPathElement>, key: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectBoundary(key);
    }
  }

  useEffect(() => {
    if (!playing || loading || selectedIndex == null || latestIndex == null) return;
    if (selectedIndex >= latestIndex) return;
    const timer = setTimeout(() => {
      if (selectedIndex + 1 >= latestIndex) setPlaying(false);
      setSelectedMonth(monthFromIndex(selectedIndex + 1));
    }, 1050);
    return () => clearTimeout(timer);
  }, [playing, loading, selectedIndex, latestIndex]);

  const selectedCount = numericCount(currentRow?.sale_count);
  const selectedValue = metric === "volume" ? selectedCount : selectedCount / observedMonths;
  const rangeLabel = `${observedMonths} ${observedMonths === 1 ? "month" : "months"} ending ${selectedLabel}`;

  return <section className="heatmap-section" aria-labelledby="heatmap-title" aria-busy={loading}>
    <header className="heatmap-header">
      <div><span className="heatmap-kicker">Explore the market</span><h2 id="heatmap-title">Sales across Perth</h2>
        <p>Move through the market month by month. Select a suburb to inspect its recorded house sales.</p>
      </div>
      <span className="heatmap-source">261 matched areas · ABS 2021</span>
    </header>

    <div className="heatmap-controls">
      <div className="heatmap-period-control">
        <span className="heatmap-period-label">Window</span>
        <div className="segmented" role="group" aria-label="Heatmap time window">
          {windows.map(value => <button key={value} type="button" aria-pressed={windowSize === value} onClick={() => { setWindowSize(value); setPlaying(false); }}>
            {value === 1 ? "1 month" : `${value} months`}
          </button>)}
        </div>
      </div>
      <div className="heatmap-metric-control">
        <span className="heatmap-period-label">Colour by</span>
        <div className="segmented" role="group" aria-label="Heatmap metric">
          <button type="button" aria-pressed={metric === "volume"} onClick={() => setMetric("volume")}>Sales volume</button>
          <button type="button" aria-pressed={metric === "velocity"} onClick={() => setMetric("velocity")}>Sales / month</button>
        </div>
      </div>
    </div>

    <div className="heatmap-timeline">
      <div className="heatmap-timeline-heading">
        <button type="button" className="heatmap-play" disabled={selectedIndex == null || latestIndex == null || selectedIndex >= latestIndex || Boolean(error)} onClick={() => setPlaying(value => !value)} aria-label={playing ? "Pause timeline" : "Play timeline"}>
          {playing ? "Pause" : "Play"}
        </button>
        <strong>{selectedLabel}</strong>
        <span role="status">{loading ? "Updating map…" : error}</span>
      </div>
      <label className="sr-only" htmlFor="heatmap-month">Month</label>
      <input id="heatmap-month" className="heatmap-slider" type="range" min={firstIndex ?? 0} max={latestIndex ?? 0} step="1" value={selectedIndex ?? 0}
        disabled={firstIndex == null || latestIndex == null} aria-valuetext={selectedLabel}
        onChange={event => { setPlaying(false); setSelectedMonth(monthFromIndex(Number(event.target.value))); }} />
      <div className="heatmap-timeline-ends"><span>{firstMonth ? monthLabel(`${firstMonth}-01`) : "—"}</span><span>{latestMonth ? monthLabel(`${latestMonth}-01`) : "—"}</span></div>
    </div>

    {error && <p className="heatmap-error" role="alert">{error} <button type="button" onClick={() => { cache.current.delete(`${selectedMonth ?? "latest"}:${windowSize}`); setReloadKey(value => value + 1); }}>Retry</button></p>}
    {boundaryError && <p className="heatmap-error" role="alert">{boundaryError}</p>}
    <div className="heatmap-layout">
      <div className="heatmap-map-frame">
        {boundaries.length ? <svg className="heatmap-map" viewBox={`0 0 ${mapWidth} ${mapHeight}`} role="group" aria-label="Interactive Perth suburb sales heatmap">
          <title>Perth suburb sales activity</title>
          <desc>{`Residential house sales over ${rangeLabel}. Darker areas represent more ${metric === "volume" ? "sales" : "sales per month"}. Select a suburb for details.`}</desc>
          {boundaries.map(feature => {
            const row = rowByKey.get(feature.key);
            const count = numericCount(row?.sale_count);
            const value = metric === "volume" ? count : count / observedMonths;
            const active = feature.key === selectedKey;
            const level = row ? colorLevel(value) : 0;
            return <path key={feature.code} d={feature.path} fillRule="evenodd" fill={level ? `color-mix(in srgb, var(--accent) ${[0, 14, 27, 41, 57, 76][level]}%, var(--paper-deep))` : "var(--map-no-data)"}
              className={`heatmap-area${active ? " active" : ""}`} tabIndex={0} role="button"
              aria-label={`${feature.name}, postcode ${row?.postcode ?? "unavailable"}${row ? `, ${number.format(count)} recorded sales` : ", no captured sales in this window"}`}
              aria-pressed={active} onClick={() => selectBoundary(feature.key)} onKeyDown={event => onBoundaryKeyDown(event, feature.key)}>
              <title>{`${feature.name}${row ? ` · ${number.format(count)} recorded sales` : " · No captured sales"}`}</title>
            </path>;
          })}
        </svg> : boundaryError ? <div className="heatmap-map-message">The boundary map could not be loaded.</div> : <div className="heatmap-map-message" role="status">Loading Perth suburb boundaries…</div>}
      </div>
      <aside className="heatmap-detail" aria-live="polite">
        <span className="heatmap-kicker">Suburb details</span>
        {currentFeature ? <>
          <h3>{currentFeature.name}</h3>
          <span className="heatmap-postcode">Postcode {currentRow?.postcode ?? "—"}</span>
          <strong className="heatmap-detail-value">{loading ? "…" : currentRow ? (metric === "volume" ? number.format(selectedValue) : selectedValue.toFixed(1)) : "—"}</strong>
          <span className="heatmap-detail-label">{metric === "volume" ? "recorded sales" : "sales per month"} · {rangeLabel}</span>
          <span className="heatmap-detail-secondary">{loading ? "Updating map…" : currentRow ? `${number.format(selectedCount)} total recorded sales` : "No captured sales for this suburb and period."}</span>
        </> : <>
          <h3>Select an area</h3>
          <span className="heatmap-postcode">Postcode and sale activity</span>
          <strong className="heatmap-detail-value">{loading ? "…" : metric === "volume" ? number.format(mappedSales) : (mappedSales / observedMonths).toFixed(1)}</strong>
          <span className="heatmap-detail-label">{metric === "volume" ? "recorded sales across matched areas" : "sales per month across matched areas"}</span>
        </>}
        <div className="heatmap-legend" aria-label={`Colour scale for ${metric === "volume" ? "sales volume" : "sales per month"}`}>
          <span>Lower</span>{[1, 2, 3, 4, 5].map(level => <i key={level} style={{ background: `color-mix(in srgb, var(--accent) ${[14, 27, 41, 57, 76][level - 1]}%, var(--paper-deep))` }} />)}<span>Higher</span>
        </div>
        <span className="heatmap-no-data-key"><i />No captured sales</span>
      </aside>
    </div>
    <p className="heatmap-footnote">Sales volume counts recorded transactions in the selected window. Sales / month divides by months of source coverage; it is not adjusted for housing stock. Colours use a relative scale recalculated for each selection, so compare the counts in suburb details for absolute changes over time. Areas without captured sales are shown as no data. Boundaries are simplified from the Australian Bureau of Statistics’ <a href="https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files" target="_blank" rel="noreferrer">ASGS Edition 3 Suburbs and Localities (2021)</a>, licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. Names without a matching ABS 2021 boundary are not shown.</p>
  </section>;
}
