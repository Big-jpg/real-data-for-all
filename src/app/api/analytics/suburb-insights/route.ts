import { motherduck } from "@/lib/motherduck";
import { z } from "zod";

export const dynamic="force-dynamic";

const querySchema=z.object({
  suburb_key:z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  from:z.iso.date(),
  to:z.iso.date(),
  months:z.coerce.number().int().min(1).max(120).optional(),
  bedrooms:z.coerce.number().int().min(1).max(6).optional(),
});

export async function GET(request:Request){
  const parsed=querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success)return Response.json({error:parsed.error.flatten()},{status:400});
  const {suburb_key,from,to,months,bedrooms:bedroom}=parsed.data;
  const sql=motherduck();
  try{
    const dateRange=sql.unsafe(`sold_date BETWEEN DATE '${from}' AND DATE '${to}'`);
    const bedroomFilter=bedroom?sql`AND bedrooms=${bedroom}`:sql``;
    const priorFrom=months
      ?sql.unsafe(`(DATE '${from}'-INTERVAL '${months} months')::date`)
      :sql.unsafe(`(DATE '${from}'-(((DATE '${to}'-DATE '${from}')+1)::integer))::date`);
    const [summary]=await sql`SELECT count(*)::bigint sale_count,count(price_aud)::bigint priced_sales,
      percentile_cont(.5) WITHIN GROUP(ORDER BY price_aud) FILTER(WHERE price_aud IS NOT NULL)::bigint median_price_aud,
      avg(price_aud) FILTER(WHERE price_aud IS NOT NULL)::bigint average_price_aud,
      count(*) FILTER(WHERE price_aud BETWEEN 50000 AND 20000000 AND land_size_sqm BETWEEN 50 AND 10000)::bigint land_sample,
      corr(price_aud::double precision,land_size_sqm::double precision) FILTER(WHERE price_aud BETWEEN 50000 AND 20000000 AND land_size_sqm BETWEEN 50 AND 10000) land_price_correlation,
      percentile_cont(.5) WITHIN GROUP(ORDER BY land_size_sqm) FILTER(WHERE land_size_sqm BETWEEN 50 AND 10000)::bigint median_land_size_sqm
      FROM suburb_sale_facts WHERE suburb_key=${suburb_key} AND ${dateRange} ${bedroomFilter}`;
    const [rolling]=await sql`WITH periods AS (
        SELECT DATE ${sql.unsafe(`'${from}'`)} current_from,DATE ${sql.unsafe(`'${to}'`)} current_to,
          ${priorFrom} prior_from,
          (DATE ${sql.unsafe(`'${from}'`)}-1)::date prior_to
      )
      SELECT p.current_from,p.current_to,p.prior_from,p.prior_to,
        count(*) FILTER(WHERE f.sold_date BETWEEN p.current_from AND p.current_to)::bigint current_sale_count,
        count(f.price_aud) FILTER(WHERE f.sold_date BETWEEN p.current_from AND p.current_to)::bigint current_priced_sales,
        percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud) FILTER(WHERE f.sold_date BETWEEN p.current_from AND p.current_to AND f.price_aud IS NOT NULL)::bigint current_median_price_aud,
        count(*) FILTER(WHERE f.sold_date BETWEEN p.prior_from AND p.prior_to)::bigint prior_sale_count,
        count(f.price_aud) FILTER(WHERE f.sold_date BETWEEN p.prior_from AND p.prior_to)::bigint prior_priced_sales,
        percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud) FILTER(WHERE f.sold_date BETWEEN p.prior_from AND p.prior_to AND f.price_aud IS NOT NULL)::bigint prior_median_price_aud
      FROM suburb_sale_facts f CROSS JOIN periods p
      WHERE f.suburb_key=${suburb_key} AND f.sold_date BETWEEN p.prior_from AND p.current_to ${bedroomFilter}
      GROUP BY p.current_from,p.current_to,p.prior_from,p.prior_to`;
    const bedroomSegments=await sql`SELECT bedrooms AS segment_label,count(*)::bigint sale_count,
      percentile_cont(.5) WITHIN GROUP(ORDER BY price_aud) FILTER(WHERE price_aud IS NOT NULL)::bigint median_price_aud
      FROM suburb_sale_facts WHERE suburb_key=${suburb_key} AND ${dateRange} AND bedrooms BETWEEN 1 AND 6 ${bedroomFilter}
      GROUP BY bedrooms ORDER BY bedrooms`;
    return Response.json({summary,rolling,bedrooms:bedroomSegments,meta:{source:"motherduck",scope:{property_type:"House",postcode_from:"6000",postcode_to:"6200"},filters:parsed.data}},
      {headers:{"Cache-Control":"public, s-maxage=3600, stale-while-revalidate=86400"}});
  }finally{await sql.end();}
}
