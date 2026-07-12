import postgres from "postgres";
import type { RawObservation } from "./source";

export function database(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  return postgres(url, { ssl: "require", max: 4, prepare: false });
}

export async function registerFile(fileName: string, objectUrl: string | null, sha256: string, byteSize: number) {
  const sql = database();
  try {
    const [file] = await sql`INSERT INTO ops.ingest_file(file_name,object_url,sha256,byte_size)
      VALUES(${fileName},${objectUrl},${sha256},${byteSize}) ON CONFLICT(sha256) DO UPDATE SET object_url=coalesce(excluded.object_url,ops.ingest_file.object_url)
      RETURNING file_id,status`;
    return { fileId: String(file.file_id), status: String(file.status) };
  } finally { await sql.end(); }
}

export async function loadObservations(fileId: string, rows: RawObservation[]) {
  const sql = database();
  const columns = ["observation_key","record_hash","file_id","source_row_number","source_url","page_number","ordinal_on_page","price_text","price_value_source","address_text","detail_path","detail_url","bedrooms_source","bathrooms_source","car_spaces_source","land_size_text","land_size_sqm_source","property_type_source","sold_date_text","sold_date_iso_source","scraped_at_source"] as const;
  try {
    await sql`UPDATE ops.ingest_file SET status='loading',source_rows=${rows.length},error=NULL WHERE file_id=${fileId}::uuid`;
    for (let offset=0; offset<rows.length; offset+=1000) {
      const batch = rows.slice(offset,offset+1000).map(({ observationKey,recordHash,sourceRowNumber,values:v }) => ({
        observation_key:observationKey,record_hash:recordHash,file_id:fileId,source_row_number:sourceRowNumber,
        source_url:v.sourceUrl||null,page_number:v.pageNumber||null,ordinal_on_page:v.ordinalOnPage||null,price_text:v.price||null,
        price_value_source:v.priceValue||null,address_text:v.address||null,detail_path:v.detailPath||null,detail_url:v.detailUrl||null,
        bedrooms_source:v.bedrooms||null,bathrooms_source:v.bathrooms||null,car_spaces_source:v.carSpaces||null,
        land_size_text:v.landSize||null,land_size_sqm_source:v.landSizeSqm||null,property_type_source:v.propertyType||null,
        sold_date_text:v.soldDate||null,sold_date_iso_source:v.soldDateISO||null,scraped_at_source:v.scrapedAt||null
      }));
      await sql`INSERT INTO raw.sale_observation ${sql(batch,columns)} ON CONFLICT(observation_key) DO NOTHING`;
    }
    const [{ count }] = await sql`SELECT count(*)::int count FROM raw.sale_observation WHERE file_id=${fileId}::uuid`;
    await sql`UPDATE ops.ingest_file SET status='loaded',accepted_rows=${Number(count)},rejected_rows=${rows.length-Number(count)} WHERE file_id=${fileId}::uuid`;
    return Number(count);
  } catch(error) {
    await sql`UPDATE ops.ingest_file SET status='failed',error=${error instanceof Error?error.message:String(error)} WHERE file_id=${fileId}::uuid`;
    throw error;
  } finally { await sql.end(); }
}

export async function curateFile(fileId: string) {
  const sql=database(); try { await sql`CALL core.curate_file(${fileId}::uuid)`; } finally { await sql.end(); }
}

export async function refreshMarts() {
  const sql=database(); try { await sql`REFRESH MATERIALIZED VIEW mart.suburb_monthly_sales`; } finally { await sql.end(); }
}
