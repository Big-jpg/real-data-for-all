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
  const dimensions=await source`SELECT * FROM mart.suburb_dimension ORDER BY suburb`;
  const rows=await source`SELECT * FROM mart.suburb_monthly_sales ORDER BY suburb,sale_month`;

  await target`DROP TABLE IF EXISTS suburb_dimension_next`;
  await target`CREATE TABLE suburb_dimension_next(suburb_key varchar,suburb varchar,canonical_postcode varchar,observed_postcodes varchar,sale_count bigint,postcode_confidence decimal(5,4))`;
  for(let i=0;i<dimensions.length;i+=1000) await target`INSERT INTO suburb_dimension_next ${target(dimensions.slice(i,i+1000) as Record<string,unknown>[])}`;

  await target`DROP TABLE IF EXISTS suburb_monthly_sales_next`;
  await target`CREATE TABLE suburb_monthly_sales_next(suburb_key varchar,suburb varchar,postcode varchar,sale_month date,sale_count bigint,median_price_aud bigint,average_price_aud bigint,minimum_price_aud bigint,maximum_price_aud bigint)`;
  for(let i=0;i<rows.length;i+=1000) await target`INSERT INTO suburb_monthly_sales_next ${target(rows.slice(i,i+1000) as Record<string,unknown>[])}`;

  await target`DROP TABLE IF EXISTS suburb_dimension`;
  await target`ALTER TABLE suburb_dimension_next RENAME TO suburb_dimension`;
  await target`DROP TABLE IF EXISTS suburb_monthly_sales`;
  await target`ALTER TABLE suburb_monthly_sales_next RENAME TO suburb_monthly_sales`;
  console.log(`published ${dimensions.length} canonical suburbs and ${rows.length} aggregate rows to MotherDuck real_data_for_all`);
}finally{await source.end();await target.end();}
