import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Scope = { suburb: string; postcode: string; state: 'WA'; evidence: string[] };
type SourceScope = { suburb?: unknown; postcode?: unknown; state?: unknown };
type CaptureSlice = SourceScope & { status?: string; summary?: { complete?: boolean; resolvedScopeVerified?: boolean } };
export type ActorRow = { propertyId: string; url: string; listingType?: string; propertyType?: string; isSold?: boolean; soldDate: string; soldPrice?: number; scrapedAt: string; address: { street?: string; suburb?: string; state?: string; postcode?: string; full?: string }; features?: { bedrooms?: number; bathrooms?: number; parkingSpaces?: number }; price?: { display?: string }; landSize?: number; landSizeUnit?: string };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const clean = (s: unknown) => String(s ?? '').trim();
const norm = (s: unknown) => clean(s).normalize('NFKC').toUpperCase().replace(/\s+/g, ' ');
export function dateWindow(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month] = today.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
  return { from: first, to: today };
}
export function inventory(baseline: { files?: { scope: SourceScope }[] }, captures: { name: string; manifest: { slices?: CaptureSlice[] } }[]): Scope[] {
  const scopes = new Map<string, Scope>();
  function add(scope: SourceScope, evidence: string) {
    const suburb = norm(scope.suburb), postcode = clean(scope.postcode);
    if (!suburb || !/^6\d{3}$/.test(postcode) || norm(scope.state) !== 'WA') return;
    const key = `${suburb}|${postcode}`;
    const item = scopes.get(key) ?? { suburb, postcode, state: 'WA' as const, evidence: [] };
    if (!item.evidence.includes(evidence)) item.evidence.push(evidence);
    scopes.set(key, item);
  }
  for (const file of baseline.files ?? []) add(file.scope, '2026-07-baseline');
  for (const capture of captures) for (const slice of capture.manifest.slices ?? []) {
    if (slice.status === 'complete' && slice.summary?.complete === true && slice.summary?.resolvedScopeVerified === true) add(slice, capture.name);
  }
  return [...scopes.values()].sort((a,b) => a.postcode.localeCompare(b.postcode) || a.suburb.localeCompare(b.suburb));
}
export function actorInput(scope: Scope, maxListings: number) {
  return { mode:'location', locations:[{suburb:scope.suburb,state:'WA',postcode:scope.postcode}], listingType:'sold', dateRange:'3months', propertyTypes:['house'], includeSurrounding:false, maxListings, maxPages:0, includeNearbySchools:false, includePriceHistory:false, includePcaInsights:false, incrementalMode:false };
}
function validDate(s: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10) === s; }
export function analyse(rows: ActorRow[], scope: Scope, window: {from:string;to:string}) {
  const accepted = new Map<string, { fields: object; row: ActorRow }>(), exceptions: { index:number; reason:string }[] = [];
  let outsideWindow = 0, duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const id = clean(row.propertyId), url = clean(row.url), date = clean(row.soldDate).slice(0,10);
    const match = url.match(/-(\d+)(?:[/?#].*)?$/);
    let reason = '';
    if (!/^\d+$/.test(id) || !match || match[1] !== id || !/^https:\/\/www\.realestate\.com\.au\//i.test(url)) reason = 'invalid listing identity';
    else if (norm(row.propertyType) !== 'HOUSE' || row.isSold !== true || norm(row.listingType) !== 'SOLD') reason = 'not a confirmed sold house';
    else if (norm(row.address?.suburb) !== norm(scope.suburb) || clean(row.address?.postcode) !== scope.postcode || norm(row.address?.state) !== 'WA') reason = 'outside exact locality';
    else if (!validDate(date)) reason = 'missing or invalid sold date';
    else if (!clean(row.address?.full) || !validDate(clean(row.scrapedAt).slice(0,10))) reason = 'missing address or capture timestamp';
    if (reason) { exceptions.push({index,reason}); continue; }
    if (date < window.from || date > window.to) { outsideWindow++; continue; }
    const fields = { id, url, date, address:row.address.full, price:row.soldPrice ?? null, priceDisplay:row.price?.display ?? null, bedrooms:row.features?.bedrooms ?? null, bathrooms:row.features?.bathrooms ?? null, parking:row.features?.parkingSpaces ?? null, landSize:row.landSize ?? null, landSizeUnit:row.landSizeUnit ?? null };
    const prior = accepted.get(id);
    if (prior) { if (JSON.stringify(prior.fields) !== JSON.stringify(fields)) exceptions.push({index,reason:`conflicting listing ${id}`}); else duplicates++; continue; }
    accepted.set(id,{fields,row});
  }
  return { total:rows.length, inWindow:accepted.size, outsideWindow, duplicates, exceptions, records:[...accepted.values()].map(x=>x.row) };
}
const json = async (p:string) => JSON.parse(await readFile(p,'utf8'));
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const baseline = await json('captures/2026-07-baseline/manifest.json');
  const dirs = ['captures/perth-houses-2026-10-12','captures/perth-houses-2026-10-12-supplement'];
  const captures = await Promise.all(dirs.map(async name => ({name,manifest:await json(`${name}/manifest.json`)})));
  const scopes = inventory(baseline,captures);
  if (command === 'inventory') {
    const result = {generatedAt:new Date().toISOString(),window:dateWindow(),count:scopes.length,postcodes:new Set(scopes.map(x=>x.postcode)).size,scopes};
    if (args[0]) { await mkdir(path.dirname(args[0]),{recursive:true}); await writeFile(args[0],JSON.stringify(result,null,2)+'\n'); }
    console.log(JSON.stringify({...result,scopes:undefined},null,2)); return;
  }
  if (command === 'prepare') {
    const [file, suburb, postcode, output] = args;
    if (!file || !suburb || !postcode || !output) throw new Error('Usage: prepare <dataset.json> <suburb> <postcode> <report.json>');
    const scope = scopes.find(x=>x.suburb===norm(suburb) && x.postcode===postcode);
    if (!scope) throw new Error('Locality is not in the captured inventory');
    const raw = await readFile(file,'utf8'), rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('Dataset must be a JSON array');
    const window = dateWindow(), analysis = analyse(rows,scope,window);
    const report = {schemaVersion:1, scope, window, inputSha256:hash(raw), analysis, completeness:'unverified', publishable:false, reason:'Actor dataset does not demonstrate resolved scope, source total or terminal pagination; successful run alone is insufficient.'};
    await mkdir(path.dirname(output),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({...report,analysis:{...analysis,records:undefined}},null,2)); return;
  }
  throw new Error('Usage: apify-refresh inventory [output.json] | prepare <dataset.json> <suburb> <postcode> <report.json>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1});
