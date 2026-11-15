import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyse, dateWindow, type Scope, type ActorRow } from './apify-refresh';
const [datasetPath, inventoryPath, reportPath] = process.argv.slice(2);
if (!datasetPath || !inventoryPath || !reportPath) throw new Error('Usage: apify-review-batch <dataset.json> <inventory.json> <report.json>');
const raw = await readFile(datasetPath,'utf8');
const rows = JSON.parse(raw), inventory = JSON.parse(await readFile(inventoryPath,'utf8'));
if (!Array.isArray(rows) || !Array.isArray(inventory.scopes)) throw new Error('Expected a dataset array and inventory object');
const window = inventory.window ?? dateWindow();
const key = (suburb: unknown, postcode: unknown) => `${String(suburb ?? '').trim().toUpperCase()}|${String(postcode ?? '').trim()}`;
const scopes = new Map<string, Scope>(inventory.scopes.map((s:Scope) => [key(s.suburb,s.postcode),s]));
const byScope = new Map<string, ActorRow[]>();
let unknownScope=0;
for(const row of rows) { const k=key(row.address?.suburb,row.address?.postcode); if(!scopes.has(k)) {unknownScope++;continue;} const arr=byScope.get(k) ?? []; arr.push(row); byScope.set(k,arr); }
const seen = new Map<string,string>();
const totals = {returned:rows.length,inWindow:0,outsideWindow:0,duplicates:0,conflicts:0,exceptions:0,unknownScope,scopesWithRows:byScope.size,scopesWithInWindowRows:0};
const scopeReports=[];
for(const [k, group] of byScope) {
 const scope=scopes.get(k)!; const result=analyse(group,scope,window); totals.inWindow+=result.inWindow; totals.outsideWindow+=result.outsideWindow; totals.duplicates+=result.duplicates; totals.exceptions+=result.exceptions.length;
 if(result.inWindow) totals.scopesWithInWindowRows++;
 for(const row of result.records) { const id=String(row.propertyId), earlier=seen.get(id); if(earlier && earlier!==k) totals.conflicts++; else seen.set(id,k); }
 scopeReports.push({suburb:scope.suburb,postcode:scope.postcode,total:result.total,inWindow:result.inWindow,outsideWindow:result.outsideWindow,duplicates:result.duplicates,exceptions:result.exceptions});
}
const report={schemaVersion:1,window,inputSha256:createHash('sha256').update(raw).digest('hex'),requestedScopes:scopes.size,totals,scopeReports,completeness:'unverified',publishable:false,note:'Scopes without returned records are unknown, not verified empty. Dataset rows alone do not prove all requested searches completed.'};
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,scopeReports:undefined},null,2));
