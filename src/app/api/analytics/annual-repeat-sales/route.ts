import { motherduck } from "@/lib/motherduck";

export const dynamic = "force-dynamic";

export async function GET() {
  const sql = motherduck();
  try {
    const data = await sql`SELECT model_version,source_snapshot_id,source_snapshot_at,executed_at,reference_year,
        reporting_window_start,reporting_window_end,series_key,series_label,observation_year,index_level,
        index_lower_95,index_upper_95,annual_change_pct,annual_change_lower_95_pct,annual_change_upper_95_pct,
        pair_count,identifying_pair_count,same_year_diagnostic_pair_count,contributing_property_count,
        year_identifying_pair_count,year_contributing_property_count,sale_count,eligibility_criteria
      FROM annual_repeat_sales_index
      WHERE model_version='annual-repeat-sales-v1'
      ORDER BY series_key,observation_year`;
    return Response.json({ data, meta: { rows: data.length, source: "motherduck" } }, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } finally {
    await sql.end();
  }
}
