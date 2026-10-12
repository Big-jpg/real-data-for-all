import { motherduck } from "../src/lib/motherduck";
import { requiredMotherDuckToken } from "./publish-motherduck";

process.env.MOTHERDUCK_TOKEN = requiredMotherDuckToken();
const sql=motherduck();
try {
  const [summary] = await sql`SELECT (SELECT count(*) FROM suburb_dimension)::bigint suburbs,
    (SELECT count(*) FROM suburb_monthly_sales)::bigint monthly_rows,count(*)::bigint house_facts,
    min(sold_date)::text sold_date_from,max(sold_date)::text sold_date_to FROM suburb_sale_facts`;
  if (!Number(summary.suburbs) || !Number(summary.monthly_rows) || !Number(summary.house_facts)) throw new Error("MotherDuck serving tables are empty");
  const [{ dimension_mismatches }] = await sql`WITH facts AS (SELECT suburb_key,count(*)::bigint sale_count FROM suburb_sale_facts GROUP BY suburb_key)
    SELECT count(*)::bigint dimension_mismatches FROM suburb_dimension d FULL OUTER JOIN facts f USING(suburb_key)
    WHERE d.sale_count IS DISTINCT FROM f.sale_count`;
  const [{ monthly_mismatches }] = await sql`WITH facts AS (
      SELECT suburb_key,date_trunc('month',sold_date)::date sale_month,count(*)::bigint sale_count FROM suburb_sale_facts GROUP BY 1,2)
    SELECT count(*)::bigint monthly_mismatches FROM suburb_monthly_sales m FULL OUTER JOIN facts f USING(suburb_key,sale_month)
    WHERE m.sale_count IS DISTINCT FROM f.sale_count`;
  if (Number(dimension_mismatches) || Number(monthly_mismatches)) throw new Error("MotherDuck dimensions, monthly counts and facts do not reconcile");
  const [{ duplicate_keys }] = await sql`SELECT
    (SELECT count(*)-count(DISTINCT suburb_key) FROM suburb_dimension)+
    (SELECT count(*) FROM (SELECT suburb_key,sale_month FROM suburb_monthly_sales GROUP BY 1,2 HAVING count(*)>1) AS duplicated_months) AS duplicate_keys`;
  if (Number(duplicate_keys)) throw new Error("MotherDuck serving tables contain duplicate canonical keys");
  const [{ invalid_property_keys }] = await sql`SELECT count(*)::bigint invalid_property_keys FROM suburb_sale_facts
    WHERE property_key IS NULL OR property_key !~ '^[a-f0-9]{64}$'`;
  if (Number(invalid_property_keys)) throw new Error(`MotherDuck serving facts contain ${invalid_property_keys} invalid pseudonymous property keys`);
  const [repeatPairs] = await sql`SELECT count(*)::bigint pair_count,count(DISTINCT pair_key)::bigint unique_pair_count,
    count(*) FILTER(WHERE pair_key !~ '^[a-f0-9]{64}$' OR property_key !~ '^[a-f0-9]{64}$'
      OR holding_days<0 OR (holding_days<=0 AND raw_annualized_return_pct IS NOT NULL)
      OR (holding_days>0 AND earlier_price_aud>0 AND later_price_aud>0
        AND NOT has_annualized_return_overflow AND raw_annualized_return_pct IS NULL))::bigint invalid_rows,
    count(*) FILTER(WHERE is_same_day_ambiguous)::bigint same_day_ambiguous_pairs,
    count(*) FILTER(WHERE return_eligible AND is_plausible_annualized_return)::bigint plausible_positive_hold_returns
    FROM repeat_sale_pairs`;
  if (!Number(repeatPairs.pair_count) || Number(repeatPairs.pair_count) !== Number(repeatPairs.unique_pair_count) || Number(repeatPairs.invalid_rows)) {
    throw new Error("MotherDuck repeat-sale pairs failed identity or return-integrity checks");
  }
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--expect-suburb" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[index + 1] ?? "")) throw new Error("Usage: smoke-motherduck.ts [--expect-suburb canonical-suburb-key]");
    const [observed] = await sql`SELECT count(*)::bigint count FROM suburb_dimension WHERE suburb_key=${args[index + 1]}`;
    if (Number(observed.count) !== 1) throw new Error(`Expected suburb absent from MotherDuck: ${args[index + 1]}`);
  }
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
  console.log(`MotherDuck smoke query passed: ${rows.length} months, ${Number(insight.sale_count)} house facts, ${bedrooms.length} bedroom groups, rolling annual medians, and ${Number(repeatPairs.pair_count)} repeat-sale pairs`);
  console.log(JSON.stringify({ servingIntegrity: "passed", ...summary, ...repeatPairs }, null, 2));
} finally { await sql.end(); }
