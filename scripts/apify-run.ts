import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { actorInput, inventory } from './apify-refresh';
type RunState = { scope: ReturnType<typeof inventory>[number]; input: ReturnType<typeof actorInput>; maxTotalChargeUsd: number; createdAt: string; status: string; runId?: string; datasetId?: string; finishedAt?: string; usageTotalUsd?: number; stats?: unknown; buildId?: string; chargedEventCounts?: unknown; downloadedRows?: number; completeness?: string };
type RunResponse = { data: { id: string; defaultDatasetId: string; status: string; finishedAt?: string; usageTotalUsd?: number; stats?: unknown; buildId?: string; chargedEventCounts?: unknown } };

// One paid run per invocation; recording intent before submission prevents blind retries.
async function main() {
  const [suburb, postcode, charge, output] = process.argv.slice(2);
  const cap = Number(charge);
  if (!suburb || !postcode || !Number.isFinite(cap) || cap <= 0 || !output) throw new Error('Usage: apify-run <suburb> <postcode> <max-charge-usd> <new-output-directory>');
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN must be supplied in the process environment');
  const baseline = JSON.parse(await readFile('captures/2026-07-baseline/manifest.json','utf8'));
  const dirs = ['captures/perth-houses-2026-10-12','captures/perth-houses-2026-10-12-supplement'];
  const captures = await Promise.all(dirs.map(async name=>({name,manifest:JSON.parse(await readFile(`${name}/manifest.json`,'utf8'))})));
  const scope = inventory(baseline,captures).find(s=>s.suburb===suburb.toUpperCase().trim() && s.postcode===postcode);
  if (!scope) throw new Error('Locality is not in captured inventory');
  await mkdir(output,{recursive:false});
  const stateFile = path.join(output,'run.json');
  const input = actorInput(scope,0);
  const state: RunState = {scope,input,maxTotalChargeUsd:cap,createdAt:new Date().toISOString(),status:'submission-uncertain'};
  const save = () => writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
  await save();
  const headers = {Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const response = await fetch(`https://api.apify.com/v2/acts/abotapi~realestate-au-scraper/runs?maxTotalChargeUsd=${encodeURIComponent(cap)}`,{method:'POST',headers,body:JSON.stringify(input)});
  if (!response.ok) throw new Error(`Apify start returned HTTP ${response.status}; inspect run.json and Apify console before retrying`);
  const started = await response.json() as RunResponse;
  state.runId = started.data.id; state.datasetId = started.data.defaultDatasetId; state.status = started.data.status; await save();
  for (;;) {
    const result = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(state.runId)}?waitForFinish=30`,{headers});
    if (!result.ok) throw new Error(`Apify run check returned HTTP ${result.status}; inspect run ${state.runId} before retrying`);
    const body = await result.json() as RunResponse; const run = body.data;
    state.status=run.status; state.finishedAt=run.finishedAt; state.usageTotalUsd=run.usageTotalUsd; state.stats=run.stats; state.buildId=run.buildId; state.chargedEventCounts=run.chargedEventCounts; await save();
    if (!['READY','RUNNING'].includes(run.status)) break;
  }
  if (state.status !== 'SUCCEEDED') throw new Error(`Run ${state.runId} ended ${state.status}; no completeness claim is possible`);
  const rows: unknown[] = [];
  for (let offset=0;;offset+=1000) {
    const result = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(state.datasetId)}/items?clean=true&limit=1000&offset=${offset}`,{headers});
    if (!result.ok) throw new Error(`Dataset download failed HTTP ${result.status}; retain run ID and retrieve manually`);
    const page: unknown = await result.json(); if (!Array.isArray(page)) throw new Error('Unexpected dataset response');
    rows.push(...page); if (page.length<1000) break;
  }
  await writeFile(path.join(output,'dataset.json'),JSON.stringify(rows,null,2)+'\n');
  state.downloadedRows=rows.length; state.completeness='unverified'; await save();
  console.log(JSON.stringify({runId:state.runId,datasetId:state.datasetId,status:state.status,rows:rows.length,completeness:state.completeness},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
