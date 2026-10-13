import { motherduck } from "@/lib/motherduck";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  window: z.coerce.number().int().min(1).max(12).default(3),
});

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: parsed.error.flatten() }, { status: 400 });

  const sql = motherduck();
  try {
    const [bounds] = await sql`
      SELECT
        to_char(min(date_trunc('month', sold_date)), 'YYYY-MM') AS first_month,
        to_char(max(date_trunc('month', sold_date)) FILTER (
          WHERE sold_date < date_trunc('month', current_date)
        ), 'YYYY-MM') AS latest_month
      FROM suburb_sale_facts
    `;
    if (!bounds?.first_month || !bounds.latest_month) {
      return Response.json({ data: [], meta: { firstMonth: null, latestMonth: null, month: null, window: parsed.data.window } }, {
        headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
      });
    }

    const month = parsed.data.month ?? bounds.latest_month;
    if (month < bounds.first_month || month > bounds.latest_month) {
      return Response.json({ error: "Month is outside the available completed sales history." }, { status: 400 });
    }

    const [year, monthNumber] = month.split("-").map(Number);
    const requestedStart = new Date(Date.UTC(year, monthNumber - parsed.data.window, 1));
    const firstDate = `${bounds.first_month}-01`;
    const start = requestedStart.toISOString().slice(0, 10) < firstDate
      ? firstDate
      : requestedStart.toISOString().slice(0, 10);
    const observedMonths = (year - Number(start.slice(0, 4))) * 12 +
      monthNumber - Number(start.slice(5, 7)) + 1;
    const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    const startFilter = sql.unsafe(`sold_date >= DATE '${start}'`);
    const endFilter = sql.unsafe(`sold_date <= DATE '${end}'`);
    const rows = await sql`
      SELECT d.suburb_key,d.suburb,d.canonical_postcode postcode,count(*)::bigint sale_count
      FROM suburb_sale_facts f
      JOIN suburb_dimension d ON d.suburb_key=f.suburb_key
      WHERE ${startFilter} AND ${endFilter}
      GROUP BY d.suburb_key,d.suburb,d.canonical_postcode
      ORDER BY d.suburb
    `;

    return Response.json({
      data: rows,
      meta: {
        source: "motherduck",
        scope: { property_type: "House", postcode_from: "6000", postcode_to: "6200" },
        firstMonth: bounds.first_month,
        latestMonth: bounds.latest_month,
        month,
        window: parsed.data.window,
        observedMonths,
        from: start,
        to: end,
      },
    }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
  } finally {
    await sql.end();
  }
}
