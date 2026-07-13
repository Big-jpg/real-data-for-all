import { motherduck } from "@/lib/motherduck";
import { z } from "zod";

export const dynamic="force-dynamic";

const querySchema=z.object({
  suburb_key:z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  suburb:z.string().trim().min(1).max(100).optional(),
  postcode:z.string().regex(/^6\d{3}$/).optional(),
  from:z.iso.date().optional(),
  to:z.iso.date().optional(),
  bedrooms:z.coerce.number().int().min(1).max(6).optional(),
  limit:z.coerce.number().int().min(1).max(5000).default(1200),
});

export async function GET(request: Request) {
  const parsed=querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success) return Response.json({error:parsed.error.flatten()},{status:400});
  const input=parsed.data;
  const sql=motherduck();
  try {
    const suburbKeyFilter=input.suburb_key?sql`AND f.suburb_key=${input.suburb_key}`:sql``;
    const suburbFilter=input.suburb?sql`AND lower(d.suburb)=lower(${input.suburb})`:sql``;
    const postcodeFilter=input.postcode?sql`AND d.canonical_postcode=${input.postcode}`:sql``;
    const bedroomFilter=input.bedrooms?sql`AND f.bedrooms=${input.bedrooms}`:sql``;
    // MotherDuck's PostgreSQL endpoint currently rejects bound strings cast to
    // DATE. Zod has already constrained these values to strict ISO dates.
    const fromFilter=input.from?sql.unsafe(`AND f.sold_date>=DATE '${input.from}'`):sql``;
    const toFilter=input.to?sql.unsafe(`AND f.sold_date<=DATE '${input.to}'`):sql``;
    const rows=await sql`SELECT d.suburb,d.canonical_postcode postcode,date_trunc('month',f.sold_date)::date sale_month,
        count(*)::bigint sale_count,
        percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud) FILTER(WHERE f.price_aud IS NOT NULL)::bigint median_price_aud,
        avg(f.price_aud) FILTER(WHERE f.price_aud IS NOT NULL)::bigint average_price_aud,
        min(f.price_aud) FILTER(WHERE f.price_aud IS NOT NULL)::bigint minimum_price_aud,
        max(f.price_aud) FILTER(WHERE f.price_aud IS NOT NULL)::bigint maximum_price_aud
      FROM suburb_sale_facts f JOIN suburb_dimension d ON d.suburb_key=f.suburb_key
      WHERE true ${suburbKeyFilter} ${suburbFilter} ${postcodeFilter} ${bedroomFilter} ${fromFilter} ${toFilter}
      GROUP BY d.suburb,d.canonical_postcode,date_trunc('month',f.sold_date)::date
      ORDER BY sale_month DESC,d.suburb,d.canonical_postcode LIMIT ${input.limit}`;
    return Response.json({data:rows,meta:{rows:rows.length,source:"motherduck",filters:input}},{headers:{"Cache-Control":"public, s-maxage=3600, stale-while-revalidate=86400"}});
  } finally { await sql.end(); }
}
