import { database } from "../src/lib/db";

const sql=database(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL);
try {
  const [counts]=await sql`SELECT
    (SELECT count(*) FROM ops.ingest_file)::int files,
    (SELECT count(*) FROM raw.sale_observation)::int observations,
    (SELECT count(*) FROM core.property)::int properties,
    (SELECT count(*) FROM core.listing)::int listings,
    (SELECT count(*) FROM core.listing WHERE property_id IS NULL)::int listings_without_property,
    (SELECT count(*) FROM core.sale_event)::int sales,
    (SELECT count(*) FROM core.sale_event WHERE price_aud IS NULL)::int sales_without_numeric_price,
    (SELECT count(*) FROM core.sale_event WHERE sold_date IS NULL)::int sales_without_sold_date,
    (SELECT count(*) FROM mart.suburb_monthly_sales)::int monthly_mart_rows`;
  const files=await sql`SELECT file_name,status,source_rows,accepted_rows,rejected_rows,error FROM ops.ingest_file ORDER BY created_at DESC LIMIT 10`;
  console.log(JSON.stringify({counts,files},null,2));
} finally { await sql.end(); }
