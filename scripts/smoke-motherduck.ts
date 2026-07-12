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
  console.log(`MotherDuck smoke query passed: ${rows.length} months sampled and ${Number(insight.sale_count)} sale facts analysed`);
} finally { await sql.end(); }
