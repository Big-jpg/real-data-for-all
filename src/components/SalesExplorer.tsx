"use client";

import {FormEvent,useEffect,useMemo,useRef,useState} from "react";

type SaleRow={suburb:string;postcode:string;sale_month:string;sale_count:number|string;median_price_aud:number|string|null;average_price_aud:number|string|null;minimum_price_aud:number|string|null;maximum_price_aud:number|string|null};
type Suburb={suburb_key:string;suburb:string;canonical_postcode:string;sale_count:number|string};
type Segment={segment_label:string|number;sale_count:number|string;median_price_aud:number|string|null};
type Insights={summary:{sale_count:number|string;priced_sales:number|string;land_sample:number|string;land_price_correlation:number|string|null;median_land_size_sqm:number|string|null};bedrooms:Segment[]};

const money=new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD",maximumFractionDigits:0});
const number=new Intl.NumberFormat("en-AU");
const periods=[6,12,18,24,30] as const;

function isoDate(date:Date){return date.toISOString().slice(0,10);}
function datesFor(months:number){const to=new Date();const from=new Date(to);from.setMonth(from.getMonth()-months);return{from:isoDate(from),to:isoDate(to)};}

export default function SalesExplorer(){
  const [suburbs,setSuburbs]=useState<Suburb[]>([]);
  const [search,setSearch]=useState("");
  const [selected,setSelected]=useState<Suburb|null>(null);
  const [periodIndex,setPeriodIndex]=useState(1);
  const [activePeriod,setActivePeriod]=useState(12);
  const [rows,setRows]=useState<SaleRow[]>([]);
  const [insights,setInsights]=useState<Insights|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const periodRef=useRef<HTMLDivElement>(null);
  const resultsRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{fetch("/api/analytics/suburbs").then(r=>r.json()).then(j=>setSuburbs(j.data)).catch(()=>setError("Suburb search is temporarily unavailable."));},[]);

  const suggestions=useMemo(()=>{
    const query=search.trim().toLowerCase();
    const matches=query?suburbs.filter(s=>`${s.suburb} ${s.canonical_postcode}`.toLowerCase().includes(query)):suburbs.slice().sort((a,b)=>Number(b.sale_count)-Number(a.sale_count));
    return matches.slice(0,8);
  },[search,suburbs]);

  function choose(suburb:Suburb){
    setSelected(suburb);setSearch(suburb.suburb);setRows([]);setInsights(null);setError("");
    requestAnimationFrame(()=>periodRef.current?.scrollIntoView({behavior:"smooth",block:"center"}));
  }

  async function load(event:FormEvent){
    event.preventDefault();if(!selected)return;
    setLoading(true);setError("");
    const range=datesFor(periods[periodIndex]);
    const q=new URLSearchParams({suburb_key:selected.suburb_key,...range,limit:"1200"});
    try{
      const [salesResponse,insightResponse]=await Promise.all([
        fetch(`/api/analytics/suburb-sales?${q}`),
        fetch(`/api/analytics/suburb-insights?${q}`),
      ]);
      if(!salesResponse.ok||!insightResponse.ok)throw new Error();
      const [salesJson,insightJson]=await Promise.all([salesResponse.json(),insightResponse.json()]);
      setRows(salesJson.data.slice().reverse());setInsights(insightJson);setActivePeriod(periods[periodIndex]);
      requestAnimationFrame(()=>resultsRef.current?.scrollIntoView({behavior:"smooth",block:"start"}));
    }catch{setError("The analytical service did not respond. Please try again.");}
    finally{setLoading(false);}
  }

  const metrics=useMemo(()=>{const priced=rows.filter(r=>r.median_price_aud!=null),latest=priced.at(-1),prior=priced.length>12?priced.at(-13):priced[0],total=rows.reduce((sum,r)=>sum+Number(r.sale_count),0),change=latest&&prior?((Number(latest.median_price_aud)/Number(prior.median_price_aud)-1)*100):null;return{latest,total,change,months:rows.length};},[rows]);
  const correlation=Number(insights?.summary.land_price_correlation??0);
  const relationship=Math.abs(correlation)>=.6?"Strong":Math.abs(correlation)>=.35?"Moderate":Math.abs(correlation)>=.15?"Slight":"Little";

  function download(){const header=Object.keys(rows[0]||{});const csv=[header.join(","),...rows.map(row=>header.map(key=>JSON.stringify(String(row[key as keyof SaleRow]??""))).join(","))].join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`${selected?.suburb_key}-sales.csv`;a.click();URL.revokeObjectURL(a.href);}

  return <section className="explorer" aria-label="Property sales explorer">
    <header className="journey-heading"><span>01</span><div><p className="eyebrow">START WITH HOME</p><h2>Which suburb do you know?</h2><p>Search your home suburb, somewhere you have lived, or a neighbourhood you are curious about.</p></div></header>
    <div className="suburb-finder">
      <label htmlFor="suburb-search">Find a Perth suburb</label>
      <input id="suburb-search" type="search" value={search} onChange={e=>{setSearch(e.target.value);setSelected(null);}} placeholder="Try Mount Lawley, Fremantle or 6050" autoComplete="off"/>
      <p className="suggestion-label">{search&&!selected?`${suggestions.length} closest matches`:"Popular starting points"}</p>
      <div className="suburb-tiles">{suggestions.map(s=><button type="button" key={s.suburb_key} className={selected?.suburb_key===s.suburb_key?"selected":""} onClick={()=>choose(s)}><strong>{s.suburb}</strong><span>{s.canonical_postcode} · {number.format(Number(s.sale_count))} recorded sales</span></button>)}</div>
      {search&&!selected&&!suggestions.length&&<p className="empty">No suburb matched that search. Try fewer letters or a postcode.</p>}
    </div>

    <div className={`period-step ${selected?"ready":"locked"}`} ref={periodRef} aria-disabled={!selected}>
      <header className="journey-heading"><span>02</span><div><p className="eyebrow">CHOOSE A WINDOW</p><h2>{selected?`How has ${selected.suburb} moved?`:"Choose a suburb to continue"}</h2><p>Recent periods keep comparisons relevant and make the first answer easy to read.</p></div></header>
      {selected&&<form onSubmit={load} className="period-form">
        <div className="range-value">Last <strong>{periods[periodIndex]} months</strong></div>
        <input aria-label="Analysis period in months" type="range" min="0" max="4" step="1" value={periodIndex} onChange={e=>setPeriodIndex(Number(e.target.value))}/>
        <div className="range-labels">{periods.map(value=><span key={value}>{value}m</span>)}</div>
        <button type="submit" disabled={loading}>{loading?"Reading the market…":`Show me ${selected.suburb}`}</button>
      </form>}
    </div>

    {(rows.length||loading||error)&&<div className="results" ref={resultsRef}>
      <header className="results-heading"><p className="eyebrow">YOUR FIRST READ</p><h2>{selected?.suburb} at a glance</h2><p>The latest {activePeriod} months of recorded sales, turned into a few useful signals.</p></header>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="kpis" aria-busy={loading}><article><span>Latest median</span><strong>{loading?"—":metrics.latest?money.format(Number(metrics.latest.median_price_aud)):"Not available"}</strong><small>{metrics.latest?new Date(metrics.latest.sale_month).toLocaleDateString("en-AU",{month:"long",year:"numeric"}):""}</small></article><article><span>12-month movement</span><strong className={(metrics.change??0)>=0?"positive":"negative"}>{loading||metrics.change==null?"—":`${metrics.change>=0?"+":""}${metrics.change.toFixed(1)}%`}</strong><small>Median price comparison</small></article><article><span>Recorded sales</span><strong>{loading?"—":number.format(metrics.total)}</strong><small>{metrics.months} monthly observations</small></article></div>
      <div className="chart-grid"><Chart title="Median sale price" rows={rows} value={r=>Number(r.median_price_aud||0)} format={v=>money.format(v)} loading={loading}/><Chart title="Monthly sale volume" rows={rows} value={r=>Number(r.sale_count)} format={v=>number.format(v)} bars loading={loading}/></div>
      {insights&&<section className="deeper-read"><header><p className="eyebrow">WHAT SHAPES THE RESULT?</p><h3>Look beneath the median.</h3></header><div className="insight-grid"><article><span>Land and sale value</span><strong>{Number(insights.summary.land_sample)>=10?`${relationship} ${correlation>=0?"positive":"negative"} relationship`:"Not enough evidence"}</strong><small>{Number(insights.summary.land_sample)>=10?`Correlation ${correlation.toFixed(2)} across ${number.format(Number(insights.summary.land_sample))} comparable house sales`:"Fewer than 10 suitable land records"}</small></article><article><span>Typical recorded land</span><strong>{insights.summary.median_land_size_sqm?`${number.format(Number(insights.summary.median_land_size_sqm))} m²`:"Not available"}</strong><small>Median of plausible 50–10,000 m² house records</small></article></div><SegmentBars title="House median by bedrooms" rows={insights.bedrooms} label={r=>`${r.segment_label} bed`}/></section>}
      <div className="data-footer"><p>Detached houses only · Perth postcodes 6000–6200 · Indicative history, not a valuation</p><button type="button" onClick={download} disabled={!rows.length}>Download CSV</button></div>
    </div>}
  </section>;
}

function SegmentBars({title,rows,label}:{title:string;rows:Segment[];label:(row:Segment)=>string}){const max=Math.max(...rows.map(r=>Number(r.sale_count)),1);return <div className="segments"><h4>{title}</h4>{rows.map(row=><div className="segment" key={String(row.segment_label)}><span>{label(row)}</span><div><i style={{width:`${Math.max(4,Number(row.sale_count)/max*100)}%`}}/></div><strong>{row.median_price_aud?money.format(Number(row.median_price_aud)):"—"}</strong><small>{number.format(Number(row.sale_count))} sales</small></div>)}</div>}

function Chart({title,rows,value,format,bars=false,loading}:{title:string;rows:SaleRow[];value:(r:SaleRow)=>number;format:(v:number)=>string;bars?:boolean;loading:boolean}){const width=800,height=260,pad=36,values=rows.map(value),max=Math.max(...values,1),points=values.map((v,i)=>`${pad+(i/Math.max(values.length-1,1))*(width-pad*2)},${height-pad-(v/max)*(height-pad*2)}`).join(" ");return <figure><figcaption><span>{title}</span><strong>{rows.length?format(values.at(-1)||0):"—"}</strong></figcaption><div className="chart">{loading?<div className="skeleton"/>:<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} over time`} preserveAspectRatio="none"><line x1={pad} y1={height-pad} x2={width-pad} y2={height-pad}/>{bars?values.map((v,i)=>{const w=(width-pad*2)/Math.max(values.length,1),h=(v/max)*(height-pad*2);return <rect key={i} x={pad+i*w} y={height-pad-h} width={Math.max(w-.5,1)} height={h}/>;}):<polyline points={points}/>}</svg>}</div><small>{rows[0]?new Date(rows[0].sale_month).toLocaleDateString("en-AU",{month:"short",year:"numeric"}):""}<span>{rows.at(-1)?new Date(rows.at(-1)!.sale_month).toLocaleDateString("en-AU",{month:"short",year:"numeric"}):""}</span></small></figure>}
