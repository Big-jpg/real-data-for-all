import { database } from "../src/lib/db";

const source=database(process.env.DATABASE_READ_URL||process.env.DATABASE_URL);
const target=database(process.env.MOTHERDUCK_DATABASE_URL);
try{
  await target`CREATE TABLE IF NOT EXISTS suburb_monthly_sales(suburb varchar,postcode varchar,sale_month date,sale_count bigint,median_price_aud bigint,average_price_aud bigint,minimum_price_aud bigint,maximum_price_aud bigint)`;
  await target`DELETE FROM suburb_monthly_sales`;
  const rows=await source`SELECT * FROM mart.suburb_monthly_sales ORDER BY suburb,sale_month`;
  for(let i=0;i<rows.length;i+=1000) await target`INSERT INTO suburb_monthly_sales ${target(rows.slice(i,i+1000) as Record<string,unknown>[])}`;
  console.log(`published ${rows.length} aggregate rows to MotherDuck`);
}finally{await source.end();await target.end();}
