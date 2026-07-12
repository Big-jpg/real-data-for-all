import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { curateFile, loadObservations, refreshMarts, registerFile } from "../src/lib/db";
import { parseIngestArgs } from "../src/lib/cli";
import { parseSourceCsv, sourceFileHash } from "../src/lib/source";

const args=parseIngestArgs(process.argv.slice(2));
const directory=path.resolve(args.directory);
const files=(await readdir(directory)).filter((f)=>f.endsWith(".csv")).sort();
const selected=args.limit?files.slice(0,Number(args.limit)):files;
let observations=0;
for(const [index,fileName] of selected.entries()){
  const content=await readFile(path.join(directory,fileName)); const hash=sourceFileHash(content);
  const registered=await registerFile(fileName,null,hash,content.byteLength);
  if(registered.status==="curated"){console.log(`[${index+1}/${selected.length}] skip ${fileName}`);continue;}
  const rows=parseSourceCsv(content); observations+=await loadObservations(registered.fileId,rows); await curateFile(registered.fileId);
  console.log(`[${index+1}/${selected.length}] curated ${fileName}: ${rows.length} rows`);
}
await refreshMarts(); console.log(`complete: ${selected.length} files, ${observations} observations`);
