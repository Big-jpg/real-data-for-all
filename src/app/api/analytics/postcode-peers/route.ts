import { motherduck } from "@/lib/motherduck";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  suburb_key: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  from: z.iso.date(),
  to: z.iso.date(),
  bedrooms: z.coerce.number().int().min(1).max(6).optional(),
}).refine(({ from, to }) => from <= to, { path: ["to"], message: "End date must not precede start date" });

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });

  const { suburb_key, from, to, bedrooms } = parsed.data;
  const sql = motherduck();
  try {
    const dateRange = sql.unsafe(`f.sold_date BETWEEN DATE '${from}' AND DATE '${to}'`);
    const bedroomFilter = bedrooms ? sql`AND f.bedrooms=${bedrooms}` : sql``;
    const rows = await sql`
      WITH target AS (
        SELECT canonical_postcode FROM suburb_dimension WHERE suburb_key=${suburb_key}
      ), area_sales AS (
        SELECT d.suburb_key,d.suburb,d.canonical_postcode,
          count(f.sold_date)::bigint sale_count,
          count(f.price_aud)::bigint priced_sales,
          percentile_cont(.5) WITHIN GROUP(ORDER BY f.price_aud)
            FILTER(WHERE f.price_aud IS NOT NULL)::bigint median_price_aud,
          avg(f.price_aud) FILTER(WHERE f.price_aud IS NOT NULL)::bigint average_price_aud,
          min(f.price_aud)::bigint minimum_price_aud,
          max(f.price_aud)::bigint maximum_price_aud,
          percentile_cont(.1) WITHIN GROUP(ORDER BY f.price_aud)
            FILTER(WHERE f.price_aud IS NOT NULL)::bigint p10_price_aud,
          percentile_cont(.9) WITHIN GROUP(ORDER BY f.price_aud)
            FILTER(WHERE f.price_aud IS NOT NULL)::bigint p90_price_aud
        FROM suburb_dimension d
        CROSS JOIN target t
        LEFT JOIN suburb_sale_facts f ON f.suburb_key=d.suburb_key
          AND ${dateRange} ${bedroomFilter}
        WHERE d.canonical_postcode=t.canonical_postcode
        GROUP BY d.suburb_key,d.suburb,d.canonical_postcode
      )
      SELECT *,
        CASE WHEN count(*) OVER()<2 THEN NULL
          ELSE round((100*percent_rank() OVER(ORDER BY sale_count))::numeric,1)::double precision
        END sale_count_percentile,
        CASE WHEN count(*) OVER()<2 OR median_price_aud IS NULL THEN NULL
          ELSE round((100*percent_rank() OVER(ORDER BY median_price_aud))::numeric,1)::double precision
        END median_price_percentile
      FROM area_sales
      ORDER BY sale_count DESC,median_price_aud DESC NULLS LAST,suburb`;

    if (!rows.some((row) => row.suburb_key === suburb_key)) {
      return Response.json({ error: "Suburb not found" }, { status: 404 });
    }

    return Response.json({
      data: rows,
      meta: {
        source: "motherduck",
        suburb_key,
        postcode: rows[0]?.canonical_postcode,
        peer_count: rows.length,
        filters: { from, to, bedrooms: bedrooms ?? null },
      },
    }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
  } finally {
    await sql.end();
  }
}
