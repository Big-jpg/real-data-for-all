import { database } from "../src/lib/db";

const fabric={observations:347887,listings:296422,coreAnalytical:232596,suburbs:333};
const sql=database(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL);
try {
  const [actual]=await sql`SELECT
    (SELECT count(*) FROM raw.sale_observation)::int observations,
    (SELECT count(*) FROM core.listing)::int listings,
    (SELECT count(*) FROM core.sale_event s JOIN core.listing l USING(listing_id)
      JOIN raw.sale_observation r ON r.observation_key=l.selected_observation_key
      WHERE s.price_aud BETWEEN 10000 AND 100000000
        AND coalesce(r.price_text,'') !~* '[$]?[[:space:]]*[[:digit:],.]+[[:space:]]*[-–—][[:space:]]*[$]?[[:space:]]*[[:digit:],.]+' 
        AND coalesce(r.price_text,'') !~* 'price[[:space:]]+range|(^|[^[:alpha:]])range([^[:alpha:]]|$)|between[[:space:]]+[$]?'
        AND coalesce(r.price_text,'') !~* '^(from|offers?[[:space:]]+(from|over|above)|starting[[:space:]]+(from|at)|mid|high|low)'
        AND s.sold_date>=DATE '1990-01-01'
        AND (r.scraped_at_source IS NULL OR s.sold_date<=r.scraped_at_source::timestamptz::date))::int core_analytical,
    (SELECT count(DISTINCT p.suburb) FROM core.sale_event s JOIN core.property p USING(property_id))::int suburbs,
    (SELECT min(sold_date) FROM core.sale_event) minimum_sold_date,
    (SELECT max(sold_date) FROM core.sale_event) maximum_sold_date`;
  console.log(JSON.stringify({fabric,neon:actual,delta:{
    observations:Number(actual.observations)-fabric.observations,
    listings:Number(actual.listings)-fabric.listings,
    coreAnalytical:Number(actual.core_analytical)-fabric.coreAnalytical,
    suburbs:Number(actual.suburbs)-fabric.suburbs,
  }},null,2));
} finally { await sql.end(); }
