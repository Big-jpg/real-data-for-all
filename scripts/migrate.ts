import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { database } from "../src/lib/db";

const sql=database();
try {
  await sql`CREATE SCHEMA IF NOT EXISTS ops`;
  await sql`CREATE TABLE IF NOT EXISTS ops.schema_migration(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
  for(const file of (await readdir(path.resolve("db"))).filter((f)=>f.endsWith(".sql")).sort()){
    const [seen]=await sql`SELECT 1 FROM ops.schema_migration WHERE version=${file}`;
    if(seen) { console.log(`skip ${file}`); continue; }
    await sql.begin(async(tx)=>{ await tx.unsafe(await readFile(path.resolve("db",file),"utf8")); await tx`INSERT INTO ops.schema_migration(version) VALUES(${file})`; });
    console.log(`applied ${file}`);
  }
} finally { await sql.end(); }
