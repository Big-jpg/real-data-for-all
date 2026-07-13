"use client";

import {useEffect,useMemo,useRef,useState} from "react";

type SaleRow={suburb:string;postcode:string;sale_month:string;sale_count:number|string;median_price_aud:number|string|null;average_price_aud:number|string|null;minimum_price_aud:number|string|null;maximum_price_aud:number|string|null};
type Suburb={suburb_key:string;suburb:string;canonical_postcode:string;sale_count:number|string};
type Segment={segment_label:string|number;sale_count:number|string;median_price_aud:number|string|null};
type Rolling={current_from:string;current_to:string;prior_from:string;prior_to:string;current_sale_count:number|string;current_priced_sales:number|string;current_median_price_aud:number|string|null;prior_sale_count:number|string;prior_priced_sales:number|string;prior_median_price_aud:number|string|null};
type Insights={summary:{sale_count:number|string;priced_sales:number|string;median_price_aud:number|string|null;average_price_aud:number|string|null;land_sample:number|string;land_price_correlation:number|string|null;median_land_size_sqm:number|string|null};rolling:Rolling|null;bedrooms:Segment[]};
type SnapshotTheme="warm"|"corporate"|"excel"|"presentation";
type BedroomFilter="all"|"1"|"2"|"3"|"4"|"5"|"6";

const money=new Intl.NumberFormat("en-AU",{style:"currency",currency:"AUD",maximumFractionDigits:0});
const number=new Intl.NumberFormat("en-AU");
const periods=[6,12,18,24,30] as const;
const snapshotThemes:[SnapshotTheme,string,string][]=[
  ["warm","Perth Warm","Editorial lines · dusty rose"],
  ["corporate","Microsoft Corporate","Times New Roman · boardroom blue"],
  ["excel","Excel Analysis","Grid cards · pastel green columns"],
  ["presentation","PowerPoint Sales","Bold orange · presentation area"],
];
const snapshotBackground:Record<SnapshotTheme,string>={warm:"#f8efea",corporate:"#eef4fb",excel:"#eef8f0",presentation:"#fff2e8"};

function isoDate(date:Date){return date.toISOString().slice(0,10);}
function datesFor(months:number){
  const now=new Date();
  const to=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),0));
  const from=new Date(Date.UTC(to.getUTCFullYear(),to.getUTCMonth()-months+1,1));
  return{from:isoDate(from),to:isoDate(to)};
}
function monthKey(date:Date){return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-01`;}
function completeMonths(rows:SaleRow[],range:{from:string;to:string}|null,suburb:Suburb|null){
  if(!range||!suburb)return rows;
  const byMonth=new Map(rows.map(row=>[row.sale_month.slice(0,7),row]));
  const cursor=new Date(`${range.from}T00:00:00Z`),end=new Date(`${range.to}T00:00:00Z`),complete:SaleRow[]=[];
  while(cursor<=end){
    const key=monthKey(cursor),existing=byMonth.get(key.slice(0,7));
    complete.push(existing??{suburb:suburb.suburb,postcode:suburb.canonical_postcode,sale_month:key,sale_count:0,median_price_aud:null,average_price_aud:null,minimum_price_aud:null,maximum_price_aud:null});
    cursor.setUTCMonth(cursor.getUTCMonth()+1);
  }
  return complete;
}

export default function SalesExplorer(){
  const [suburbs,setSuburbs]=useState<Suburb[]>([]);
  const [search,setSearch]=useState("");
  const [selected,setSelected]=useState<Suburb|null>(null);
  const [periodIndex,setPeriodIndex]=useState(1);
  const [activeRange,setActiveRange]=useState<{from:string;to:string}|null>(null);
  const [bedroom,setBedroom]=useState<BedroomFilter>("all");
  const [activeBedroom,setActiveBedroom]=useState<BedroomFilter>("all");
  const [rows,setRows]=useState<SaleRow[]>([]);
  const [insights,setInsights]=useState<Insights|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [snapshotTheme,setSnapshotTheme]=useState<SnapshotTheme>("warm");
  const [snapshotStatus,setSnapshotStatus]=useState("");
  const periodRef=useRef<HTMLDivElement>(null);
  const snapshotRef=useRef<HTMLDivElement>(null);

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

  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      setLoading(true);setError("");
      const range=datesFor(periods[periodIndex]);
      const q=new URLSearchParams({suburb_key:selected.suburb_key,...range,months:String(periods[periodIndex]),limit:"1200"});
      if(bedroom!=="all")q.set("bedrooms",bedroom);
      try{
        const [salesResponse,insightResponse]=await Promise.all([
          fetch(`/api/analytics/suburb-sales?${q}`,{signal:controller.signal}),
          fetch(`/api/analytics/suburb-insights?${q}`,{signal:controller.signal}),
        ]);
        if(!salesResponse.ok||!insightResponse.ok)throw new Error();
        const [salesJson,insightJson]=await Promise.all([salesResponse.json(),insightResponse.json()]);
        if(controller.signal.aborted)return;
        setRows(salesJson.data.slice().reverse());setInsights(insightJson);setActiveRange(range);setActiveBedroom(bedroom);
      }catch{if(!controller.signal.aborted)setError("The analytical service did not respond. Please try again.");}
      finally{if(!controller.signal.aborted)setLoading(false);}
    },180);
    return()=>{clearTimeout(timer);controller.abort();};
  },[selected,periodIndex,bedroom]);

  const metrics=useMemo(()=>({total:rows.reduce((sum,r)=>sum+Number(r.sale_count),0)}),[rows]);
  const dateRows=useMemo(()=>completeMonths(rows,activeRange,selected),[rows,activeRange,selected]);
  const rolling=insights?.rolling;
  const annualPeriod=rolling?`${new Date(rolling.current_from).toLocaleDateString("en-AU",{month:"short",year:"numeric"})}–${new Date(rolling.current_to).toLocaleDateString("en-AU",{month:"short",year:"numeric"})}`:"";

  function download(){const header=Object.keys(rows[0]||{});const csv=[header.join(","),...rows.map(row=>header.map(key=>JSON.stringify(String(row[key as keyof SaleRow]??""))).join(","))].join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=`${selected?.suburb_key}-sales.csv`;a.click();URL.revokeObjectURL(a.href);}
  function saveSnapshot(blob:Blob){const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`${selected?.suburb_key}-${snapshotTheme}-snapshot.png`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  async function renderSnapshot(){if(!snapshotRef.current)throw new Error("Snapshot is not ready");await document.fonts?.ready;const{toBlob}=await import("html-to-image");const blob=await toBlob(snapshotRef.current,{backgroundColor:snapshotBackground[snapshotTheme],cacheBust:true,pixelRatio:2});if(!blob)throw new Error("Snapshot rendering failed");return blob;}
  async function copySnapshot(){setSnapshotStatus("Preparing snapshot…");try{const blob=await renderSnapshot();if(navigator.clipboard?.write&&"ClipboardItem" in window){try{await navigator.clipboard.write([new ClipboardItem({"image/png":blob})]);setSnapshotStatus("Snapshot copied — paste it anywhere.");return;}catch{saveSnapshot(blob);setSnapshotStatus("Clipboard access was blocked, so the PNG was downloaded instead.");return;}}saveSnapshot(blob);setSnapshotStatus("Image clipboard is unavailable, so the PNG was downloaded instead.");}catch{setSnapshotStatus("The snapshot could not be created. Please try downloading the CSV.");}}
  async function downloadSnapshot(){setSnapshotStatus("Preparing PNG…");try{saveSnapshot(await renderSnapshot());setSnapshotStatus("Snapshot downloaded.");}catch{setSnapshotStatus("The snapshot could not be created. Please try again.");}}

  return <section className="explorer" id="explore" aria-label="Property sales explorer">
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
      {selected&&<div className="period-form" aria-label="Dashboard slicers">
        <div className="slicer-heading"><div><p className="eyebrow">SHARED FILTER CONTEXT</p><h3>Shape the whole view.</h3></div><p>{loading?"Updating every measure…":"Each selection updates every card, chart and segment."}</p></div>
        <div className="slicer-grid">
          <div className="window-slicer"><span className="slicer-label">Time window</span><div className="range-value">Last <strong>{periods[periodIndex]} months</strong></div><div className="period-options" role="group" aria-label="Time window">{periods.map((value,index)=><button type="button" key={value} aria-pressed={periodIndex===index} onClick={()=>setPeriodIndex(index)}>{value}m</button>)}</div></div>
          <fieldset className="bedroom-slicer"><legend>Bedrooms</legend><div>{(["all","1","2","3","4","5","6"] as BedroomFilter[]).map(value=><button type="button" key={value} aria-pressed={bedroom===value} onClick={()=>setBedroom(value)}>{value==="all"?"All":value}</button>)}</div><small>Filters sale facts before every measure is calculated.</small></fieldset>
        </div>
      </div>}
    </div>

    {(rows.length||loading||error)&&<div className="results">
      {!loading&&rows.length>0&&<section className="snapshot-studio" aria-label="Snapshot style controls"><div><p className="eyebrow">MAKE IT YOURS</p><h3>Choose a snapshot style.</h3><p>The data stays fixed. Only the visual language changes.</p></div><div className="preset-picker" role="group" aria-label="Snapshot theme">{snapshotThemes.map(([id,name,description])=><button type="button" key={id} aria-pressed={snapshotTheme===id} data-preset={id} onClick={()=>{setSnapshotTheme(id);setSnapshotStatus("");}}><i/><strong>{name}</strong><span>{description}</span></button>)}</div><div className="snapshot-actions"><button type="button" onClick={copySnapshot}>Copy snapshot</button><button type="button" onClick={downloadSnapshot}>Download PNG</button><button type="button" onClick={download}>Download CSV</button></div><p className="snapshot-status" aria-live="polite">{snapshotStatus}</p></section>}
      <div className="snapshot" data-snapshot-theme={snapshotTheme} ref={snapshotRef}>
        <header className="results-heading"><p className="eyebrow">FILTERED FACT TABLE</p><h2>{selected?.suburb} market view</h2><p>Cards aggregate the selected sale facts. Charts group those same rows by date and bedroom dimensions.</p>{!loading&&rows.length>0&&<div className="filter-summary"><span>{selected?.canonical_postcode} · {selected?.suburb}</span><span>{annualPeriod}</span><span>{activeBedroom==="all"?"All bedroom counts":`${activeBedroom} bedrooms`}</span><span>{number.format(metrics.total)} fact rows</span></div>}</header>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="kpis" aria-busy={loading}><article><span>Sales</span><strong>{loading?"—":insights?number.format(Number(insights.summary.sale_count)):"Not available"}</strong><small>Count of sale facts in the selected period</small></article><article><span>Priced sales</span><strong>{loading?"—":insights?number.format(Number(insights.summary.priced_sales)):"Not available"}</strong><small>{insights&&Number(insights.summary.sale_count)>0?`${(Number(insights.summary.priced_sales)/Number(insights.summary.sale_count)*100).toFixed(0)}% price coverage`:"No selected sales"}</small></article><article><span>Median sale price</span><strong>{loading?"—":insights?.summary.median_price_aud?money.format(Number(insights.summary.median_price_aud)):"Not available"}</strong><small>Median across selected priced sale facts</small></article><article><span>Average sale price</span><strong>{loading?"—":insights?.summary.average_price_aud?money.format(Number(insights.summary.average_price_aud)):"Not available"}</strong><small>Average across selected priced sale facts</small></article></div>
        <section className="dimension-section"><header><p className="eyebrow">DATE DIMENSION</p><h3>Measures by sale month.</h3><p>Every month in the selected window stays on the axis, including months with no sales.</p></header><div className="chart-grid"><Chart title="Median sale price by month" rows={dateRows} value={r=>r.median_price_aud==null?null:Number(r.median_price_aud)} format={v=>money.format(v)} variant="line" showPoints loading={loading}/><Chart title="Sales by month" rows={dateRows} value={r=>Number(r.sale_count)} format={v=>number.format(v)} variant="columns" zeroBased loading={loading}/></div></section>
        <PeriodMatrix rolling={rolling??null} loading={loading}/>
        {insights&&<section className="deeper-read"><header><p className="eyebrow">BEDROOM DIMENSION</p><h3>Sales and median price by bedroom count.</h3><p>The bedroom slicer filters this dimension and every measure above.</p></header><SegmentBars title="Bedroom count · sales · median price" rows={insights.bedrooms} label={r=>`${r.segment_label} bed`}/></section>}
        {!loading&&rows.length>0&&<footer className="snapshot-credit"><strong>Perth House Data</strong><span>Detached houses · Perth 6000–6200 · Indicative history, not a valuation</span><span>perthhousedata.com</span></footer>}
      </div>
    </div>}
  </section>;
}

function SegmentBars({title,rows,label}:{title:string;rows:Segment[];label:(row:Segment)=>string}){const max=Math.max(...rows.map(r=>Number(r.sale_count)),1);return <div className="segments"><h4>{title}</h4>{rows.map(row=><div className="segment" key={String(row.segment_label)}><span>{label(row)}</span><div><i style={{width:`${Math.max(4,Number(row.sale_count)/max*100)}%`}}/></div><strong>{row.median_price_aud?money.format(Number(row.median_price_aud)):"—"}</strong><small>{number.format(Number(row.sale_count))} sales</small></div>)}</div>}

function periodText(from:string,to:string){const options:Intl.DateTimeFormatOptions={month:"short",year:"numeric"};return `${new Date(from).toLocaleDateString("en-AU",options)}–${new Date(to).toLocaleDateString("en-AU",options)}`;}

function PeriodMatrix({rolling,loading}:{rolling:Rolling|null;loading:boolean}){
  const priceVariance=rolling?.current_median_price_aud&&rolling.prior_median_price_aud?(Number(rolling.current_median_price_aud)/Number(rolling.prior_median_price_aud)-1)*100:null;
  const salesVariance=rolling&&Number(rolling.prior_sale_count)>0?(Number(rolling.current_sale_count)/Number(rolling.prior_sale_count)-1)*100:null;
  const signed=(value:number|null)=>value==null?"—":`${value>=0?"+":""}${value.toFixed(1)}%`;
  return <section className="period-matrix" aria-busy={loading}><header><div><p className="eyebrow">PERIOD DIMENSION</p><h3>Selected and previous equivalent period.</h3></div><p>Separate rows, identical measures and an explicit date range.</p></header><div className="matrix-wrap"><table><thead><tr><th scope="col">Period</th><th scope="col">Date range</th><th scope="col">Sales</th><th scope="col">Priced sales</th><th scope="col">Median sale price</th></tr></thead><tbody><tr><th scope="row">Selected</th><td data-label="Date range">{rolling?periodText(rolling.current_from,rolling.current_to):"—"}</td><td data-label="Sales">{loading||!rolling?"—":number.format(Number(rolling.current_sale_count))}</td><td data-label="Priced sales">{loading||!rolling?"—":number.format(Number(rolling.current_priced_sales))}</td><td data-label="Median sale price">{loading||!rolling?.current_median_price_aud?"—":money.format(Number(rolling.current_median_price_aud))}</td></tr><tr><th scope="row">Previous equivalent</th><td data-label="Date range">{rolling?periodText(rolling.prior_from,rolling.prior_to):"—"}</td><td data-label="Sales">{loading||!rolling?"—":number.format(Number(rolling.prior_sale_count))}</td><td data-label="Priced sales">{loading||!rolling?"—":number.format(Number(rolling.prior_priced_sales))}</td><td data-label="Median sale price">{loading||!rolling?.prior_median_price_aud?"—":money.format(Number(rolling.prior_median_price_aud))}</td></tr></tbody><tfoot><tr><th scope="row">Variance</th><td data-label="Comparison">Selected vs previous</td><td data-label="Sales" className={(salesVariance??0)>=0?"positive":"negative"}>{loading?"—":signed(salesVariance)}</td><td data-label="Priced sales">—</td><td data-label="Median sale price" className={(priceVariance??0)>=0?"positive":"negative"}>{loading?"—":signed(priceVariance)}</td></tr></tfoot></table></div></section>;
}

function Chart({title,rows,value,format,variant="line",showPoints=false,zeroBased=false,loading}:{title:string;rows:SaleRow[];value:(r:SaleRow)=>number|null;format:(v:number)=>string;variant?:"line"|"columns";showPoints?:boolean;zeroBased?:boolean;loading:boolean}){
  const width=800,height=280,left=120,right=24,top=18,bottom=42,values=rows.map(value),valid=values.filter((v):v is number=>v!=null),rawMax=Math.max(...valid,1),rawMin=valid.length?Math.min(...valid):0,spread=Math.max(rawMax-rawMin,rawMax*.1,1),min=zeroBased?0:Math.max(0,rawMin-spread*.15),max=zeroBased?Math.max(1,Math.ceil(rawMax)):rawMax+spread*.15,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const point=(v:number,i:number)=>({x:left+(i/Math.max(values.length-1,1))*plotWidth,y:top+((max-v)/Math.max(max-min,1))*plotHeight});
  const coordinate=(v:number,i:number)=>{const p=point(v,i);return `${p.x},${p.y}`;};
  const segments:string[][]=[];let segment:string[]=[];
  values.forEach((v,i)=>{if(v==null){if(segment.length){segments.push(segment);segment=[];}}else segment.push(coordinate(v,i));});
  if(segment.length)segments.push(segment);
  const grid=[0,.5,1].map(ratio=>({ratio,value:max-(max-min)*ratio,y:top+plotHeight*ratio}));
  const xTicks=[0,Math.floor((rows.length-1)/2),rows.length-1].filter((index,pos,array)=>index>=0&&array.indexOf(index)===pos);
  return <figure><figcaption><span>{title}</span><small>DimDate · calendar month</small></figcaption><div className="chart">{loading?<div className="skeleton"/>:<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}; monthly values across the selected date dimension`} preserveAspectRatio="xMidYMid meet">{grid.map(tick=><g key={tick.ratio}><line className="grid-line" x1={left} y1={tick.y} x2={width-right} y2={tick.y}/><text className="axis-label" x={left-10} y={tick.y+4} textAnchor="end">{format(tick.value)}</text></g>)}{variant==="columns"?values.map((v,i)=>{const numeric=v??0,band=plotWidth/Math.max(values.length,1),h=((numeric-min)/Math.max(max-min,1))*plotHeight;return <rect key={i} x={left+i*band+band*.16} y={top+plotHeight-h} width={Math.max(band*.68,1)} height={Math.max(h,0)}/>;}):<>{segments.map((points,i)=>points.length>1?<polyline key={i} points={points.join(" ")} fill="none"/>:<circle key={i} cx={points[0].split(",")[0]} cy={points[0].split(",")[1]} r="3"/>)}{showPoints&&values.map((v,i)=>v==null?null:<circle key={`point-${i}`} cx={point(v,i).x} cy={point(v,i).y} r="3"/>)}</>}{xTicks.map(index=><text key={index} className="axis-label" x={left+(index/Math.max(rows.length-1,1))*plotWidth} y={height-12} textAnchor={index===0?"start":index===rows.length-1?"end":"middle"}>{new Date(rows[index].sale_month).toLocaleDateString("en-AU",{month:"short",year:"2-digit"})}</text>)}</svg>}</div></figure>;
}
