import { motherduck } from "@/lib/motherduck";
import { z } from "zod";

export const dynamic="force-dynamic";

const querySchema=z.object({
  suburb:z.string().trim().min(1).max(100).optional(),
  postcode:z.string().regex(/^6\d{3}$/).optional(),
  from:z.iso.date().optional(),
  to:z.iso.date().optional(),
  limit:z.coerce.number().int().min(1).max(5000).default(1200),
});

export async function GET(request: Request) {
  const parsed=querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success) return Response.json({error:parsed.error.flatten()},{status:400});
  const input=parsed.data;
  const sql=motherduck();
  try {
    const suburbFilter=input.suburb?sql`AND lower(suburb)=lower(${input.suburb})`:sql``;
    const postcodeFilter=input.postcode?sql`AND postcode=${input.postcode}`:sql``;
    // MotherDuck's PostgreSQL endpoint currently rejects bound strings cast to
    // DATE. Zod has already constrained these values to strict ISO dates.
    const fromFilter=input.from?sql.unsafe(`AND sale_month>=DATE '${input.from}'`):sql``;
    const toFilter=input.to?sql.unsafe(`AND sale_month<=DATE '${input.to}'`):sql``;
    const rows=await sql`SELECT suburb,postcode,sale_month,sale_count,median_price_aud,average_price_aud,minimum_price_aud,maximum_price_aud
      FROM suburb_monthly_sales
      WHERE true ${suburbFilter} ${postcodeFilter} ${fromFilter} ${toFilter}
      ORDER BY sale_month DESC,suburb,postcode LIMIT ${input.limit}`;
    return Response.json({data:rows,meta:{rows:rows.length,source:"motherduck",filters:input}},{headers:{"Cache-Control":"public, s-maxage=3600, stale-while-revalidate=86400"}});
  } finally { await sql.end(); }
}
