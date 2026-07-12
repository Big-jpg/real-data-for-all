import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { database } from "../src/lib/db";
import { sourceFileHash } from "../src/lib/source";

const oidcFile=path.resolve(process.env.VERCEL_ENV_FILE||".env.blob");
if(existsSync(oidcFile)) {
  const pulled=parseEnv(await readFile(oidcFile,"utf8"));
  if(pulled.VERCEL_OIDC_TOKEN) process.env.VERCEL_OIDC_TOKEN=pulled.VERCEL_OIDC_TOKEN;
  if(pulled.BLOB_STORE_ID) process.env.BLOB_STORE_ID=pulled.BLOB_STORE_ID;
}
if(!process.env.VERCEL_OIDC_TOKEN) throw new Error("Fresh VERCEL_OIDC_TOKEN required; run: vercel env pull .env.blob --environment=production");

const { head,put }=await import("@vercel/blob");
const directory=path.resolve(process.argv.find((value,index)=>index>1&&!value.startsWith("--"))||"rea_sales_data_model");
const files=(await readdir(directory)).filter((file)=>file.endsWith(".csv")).sort();
const sql=database(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL);
let uploaded=0,skipped=0;
try {
  for(const [index,fileName] of files.entries()) {
    const content=await readFile(path.join(directory,fileName));
    const sha256=sourceFileHash(content);
    const [manifest]=await sql`SELECT file_id,object_url FROM ops.ingest_file WHERE sha256=${sha256} LIMIT 1`;
    if(!manifest) throw new Error(`No Neon manifest matches ${fileName}`);
    if(manifest.object_url) { skipped++; console.log(`[${index+1}/${files.length}] skip ${fileName}`); continue; }
    const pathname=`raw/realestate.com.au/${sha256}.csv`;
    let blob;
    try {
      blob=await put(pathname,content,{access:"private",addRandomSuffix:false,contentType:"text/csv"});
    } catch(error) {
      const existing=await head(pathname);
      if(!existing) throw error;
      blob=existing;
    }
    await sql`UPDATE ops.ingest_file SET object_url=${blob.url} WHERE file_id=${manifest.file_id}`;
    uploaded++; console.log(`[${index+1}/${files.length}] archived ${fileName}`);
  }
  const [{linked}]=await sql`SELECT count(*) FILTER(WHERE object_url IS NOT NULL)::int linked FROM ops.ingest_file`;
  console.log(`complete: ${uploaded} uploaded, ${skipped} skipped, ${Number(linked)} manifests linked`);
} finally { await sql.end(); }
