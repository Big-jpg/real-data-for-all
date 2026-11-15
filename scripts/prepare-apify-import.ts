import {readFile,writeFile} from 'node:fs/promises';
import {parseSourceCsv, SOURCE_COLUMNS} from '../src/lib/source';
import {analyse,type Scope} from './apify-refresh';
import {createHash} from 'node:crypto';
type ApifyRow = { propertyId: string; url: string; soldDate: string; scrapedAt: string; soldPrice?: number; landSize?: number; landSizeUnit?: string; address: { street?: string; suburb?: string; postcode?: string }; features?: { bedrooms?: number; bathrooms?: number; parkingSpaces?: number } };
const root='captures/apify-pilot-2026-11-15';const combined=JSON.parse(await readFile(`${root}/2026-11-16-combined.json`,'utf8'));const inv=JSON.parse(await readFile(`${root}/inventory.json`,'utf8'));
const key=(s:unknown,p:unknown)=>`${String(s??'').trim().toUpperCase()}|${String(p??'').trim()}`;
const scopeMap=new Map<string,Scope>(inv.scopes.map((s:Scope)=>[key(s.suburb,s.postcode),s]));const groups=new Map<string,ApifyRow[]>();let outside=0;
for(const row of combined){const k=key(row.address?.suburb,row.address?.postcode);if(!scopeMap.has(k)){outside++;continue;}const v=groups.get(k)??[];v.push(row);groups.set(k,v);}
const selected=new Map<string,ApifyRow>(), exceptions=[];let repeats=0,outWindow=0;
for(const [k,rows] of groups){const a=analyse(rows,scopeMap.get(k)!,inv.window);exceptions.push(...a.exceptions.map(e=>({scope:k,...e})));repeats+=a.duplicates;outWindow+=a.outsideWindow;for(const row of a.records){const id=String(row.propertyId);if(selected.has(id))throw new Error(`Listing appears across localities: ${id}`);selected.set(id,row);}}
if(outside || selected.size!==1686)throw new Error(`Unexpected verified input: ${selected.size} listings, ${outside} outside scopes`);
const unusable=[...selected.values()].filter(r=>!String(r.address.street??'').trim() || /^(address (available|withheld)|contact agent)/i.test(String(r.address.street)));
const rows=[...selected.values()].filter(r=>!unusable.includes(r)).sort((a,b)=>String(a.propertyId).localeCompare(String(b.propertyId))).map(r=>{
 const address=`${String(r.address.street??'').trim()}, ${String(r.address.suburb??'').trim()}`;
 const price=typeof r.soldPrice==='number'&&Number.isSafeInteger(r.soldPrice)&&r.soldPrice>0?String(r.soldPrice):'';
 const numeric=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?String(v):'';
 const sqm=['m2','m²','sqm'].includes(String(r.landSizeUnit??'').toLowerCase())?numeric(r.landSize):'';
 const v:Record<string,string>={sourceUrl:'https://apify.com/abotapi/realestate-au-scraper',pageNumber:'',ordinalOnPage:'',price:price?`$${price}`:'',priceValue:price,address,detailPath:new URL(r.url).pathname,detailUrl:r.url,bedrooms:numeric(r.features?.bedrooms),bathrooms:numeric(r.features?.bathrooms),carSpaces:numeric(r.features?.parkingSpaces),landSize:sqm?`${sqm} m²`:'',landSizeSqm:sqm,propertyType:'House',soldDate:String(r.soldDate).slice(0,10),soldDateISO:String(r.soldDate).slice(0,10),scrapedAt:r.scrapedAt};return v;
});
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';const csv=SOURCE_COLUMNS.join(',')+'\n'+rows.map(row=>SOURCE_COLUMNS.map(c=>quote(row[c]??'')).join(',')).join('\n')+'\n';const parsed=parseSourceCsv(Buffer.from(csv));if(parsed.length!==rows.length)throw new Error('Round-trip count mismatch');
const file=`${root}/apify-2026-11-15-validated.csv`;await writeFile(file,csv,{flag:'wx'});const manifest={createdAt:new Date().toISOString(),window:inv.window,input:`${root}/2026-11-16-combined.json`,sourceSha256:createHash('sha256').update(await readFile(`${root}/2026-11-16-combined.json`)).digest('hex'),output:file,outputSha256:createHash('sha256').update(csv).digest('hex'),rows:rows.length,withheldAddressIds:unusable.map(r=>r.propertyId),repeats,outsideWindow:outWindow,exceptionCount:exceptions.length,exceptions,coverage:'partial/unverified',disclosedPrices:rows.filter(r=>r.priceValue).length};await writeFile(`${root}/apify-2026-11-15-import-manifest.json`,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...manifest,exceptions:undefined},null,2));
