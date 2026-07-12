import postgres from "postgres";
import { database } from "../src/lib/db";

const source=database(process.env.DATABASE_READ_URL||process.env.DATABASE_URL);
const token=process.env.MOTHERDUCK_TOKEN;
if(!token) throw new Error("MOTHERDUCK_TOKEN is required");
const target=postgres({
  host:process.env.MOTHERDUCK_PG_HOST||"pg.us-east-1-aws.motherduck.com",
  port:5432,
  database:"md:real_data_for_all",
  username:"postgres",
  password:token,
  ssl:"require",
  max:2,
  prepare:false,
});
try{
  await target`CREATE TABLE IF NOT EXISTS suburb_monthly_sales(suburb varchar,postcode varchar,sale_month date,sale_count bigint,median_price_aud bigint,average_price_aud bigint,minimum_price_aud bigint,maximum_price_aud bigint)`;
  await target`DELETE FROM suburb_monthly_sales`;
  const rows=await source`SELECT * FROM mart.suburb_monthly_sales ORDER BY suburb,sale_month`;
  for(let i=0;i<rows.length;i+=1000) await target`INSERT INTO suburb_monthly_sales ${target(rows.slice(i,i+1000) as Record<string,unknown>[])}`;
  const [{count}]=await target`SELECT count(*)::int count FROM suburb_monthly_sales`;
  console.log(`published ${Number(count)} aggregate rows to MotherDuck real_data_for_all`);
}finally{await source.end();await target.end();}
