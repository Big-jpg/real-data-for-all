import { database } from "../src/lib/db";

const sql=database(process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL);
try {
  const unresolved=await sql`SELECT l.listing_id,r.address_text,r.detail_url,r.price_text,r.sold_date_text
    FROM core.listing l JOIN raw.sale_observation r ON r.observation_key=l.selected_observation_key
    WHERE l.property_id IS NULL ORDER BY l.listing_id`;
  const pricePatterns=await sql`SELECT coalesce(r.price_text,'<NULL>') price_text,count(*)::int rows
    FROM core.sale_event s JOIN core.listing l USING(listing_id)
    JOIN raw.sale_observation r ON r.observation_key=l.selected_observation_key
    WHERE s.price_aud IS NULL GROUP BY r.price_text ORDER BY rows DESC,price_text LIMIT 25`;
  const datePatterns=await sql`SELECT coalesce(r.sold_date_text,'<NULL>') sold_date_text,
      coalesce(r.sold_date_iso_source,'<NULL>') sold_date_iso_source,count(*)::int rows
    FROM core.sale_event s JOIN core.listing l USING(listing_id)
    JOIN raw.sale_observation r ON r.observation_key=l.selected_observation_key
    WHERE s.sold_date IS NULL GROUP BY r.sold_date_text,r.sold_date_iso_source
    ORDER BY rows DESC,sold_date_text LIMIT 25`;
  console.log(JSON.stringify({unresolved,pricePatterns,datePatterns},null,2));
} finally { await sql.end(); }
