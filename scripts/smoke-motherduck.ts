import { motherduck } from "../src/lib/motherduck";

const sql=motherduck();
try {
  const suburbKey="yokine",from="2020-01-01",to="2026-12-31";
  const rows=await sql`SELECT suburb_key,suburb,postcode,sale_month FROM suburb_monthly_sales
    WHERE true ${sql`AND suburb_key=${suburbKey}`}
      ${sql.unsafe(`AND sale_month>=DATE '${from}'`)}
      ${sql.unsafe(`AND sale_month<=DATE '${to}'`)}
    ORDER BY sale_month DESC LIMIT 5`;
  if(!rows.length) throw new Error("MotherDuck smoke query returned no rows");
  const [insight]=await sql`SELECT count(*)::bigint sale_count,
    corr(price_aud::double precision,land_size_sqm::double precision)
      FILTER(WHERE price_aud BETWEEN 50000 AND 20000000 AND land_size_sqm BETWEEN 50 AND 10000) land_price_correlation
    FROM suburb_sale_facts WHERE suburb_key=${suburbKey}
      AND ${sql.unsafe(`sold_date BETWEEN DATE '${from}' AND DATE '${to}'`)}`;
  if(!insight||Number(insight.sale_count)<1) throw new Error("MotherDuck insight smoke query returned no sales");
  const dateRange=sql.unsafe(`sold_date BETWEEN DATE '${from}' AND DATE '${to}'`);
  const bedrooms=await sql`SELECT bedrooms AS segment_label,count(*)::bigint sale_count,
    percentile_cont(.5) WITHIN GROUP(ORDER BY price_aud) FILTER(WHERE price_aud IS NOT NULL)::bigint median_price_aud
    FROM suburb_sale_facts WHERE suburb_key=${suburbKey} AND ${dateRange} AND bedrooms BETWEEN 1 AND 6
    GROUP BY bedrooms ORDER BY bedrooms`;
  const [rolling]=await sql`WITH anchor AS (
      SELECT (date_trunc('month',max(sold_date))+INTERVAL '1 month'-INTERVAL '1 day')::date anchor_date
      FROM suburb_sale_facts WHERE suburb_key=${suburbKey} AND sold_date<=DATE ${sql.unsafe(`'${to}'`)}
    ), periods AS (
      SELECT anchor_date,(date_trunc('month',anchor_date)-INTERVAL '11 months')::date current_from,
        (date_trunc('month',anchor_date)-INTERVAL '23 months')::date prior_from,
        (date_trunc('month',anchor_date)-INTERVAL '12 months'+INTERVAL '1 month'-INTERVAL '1 day')::date prior_to FROM anchor
    )
    SELECT percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud)
      FILTER(WHERE f.sold_date BETWEEN p.current_from AND p.anchor_date AND f.price_aud IS NOT NULL)::bigint current_median_price_aud,
      percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud)
      FILTER(WHERE f.sold_date BETWEEN p.prior_from AND p.prior_to AND f.price_aud IS NOT NULL)::bigint prior_median_price_aud
    FROM suburb_sale_facts f CROSS JOIN periods p
    WHERE f.suburb_key=${suburbKey} AND f.sold_date BETWEEN p.prior_from AND p.anchor_date`;
  if(!rolling?.current_median_price_aud||!rolling?.prior_median_price_aud) throw new Error("MotherDuck rolling median smoke query returned an incomplete comparison");
  const [{excluded}]=await sql`SELECT count(*)::int excluded FROM suburb_sale_facts WHERE lower(trim(property_type))<>'house'`;
  if(Number(excluded)!==0) throw new Error(`MotherDuck fact scope contains ${excluded} non-house rows`);
  console.log(`MotherDuck smoke query passed: ${rows.length} months, ${Number(insight.sale_count)} house facts, ${bedrooms.length} bedroom groups, and rolling annual medians`);
} finally { await sql.end(); }
