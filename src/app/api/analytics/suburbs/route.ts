import { motherduck } from "@/lib/motherduck";
export const dynamic="force-dynamic";
export async function GET(){const sql=motherduck();try{const rows=await sql`SELECT suburb,postcode,min(sale_month) first_month,max(sale_month) last_month,sum(sale_count)::bigint sale_count FROM suburb_monthly_sales GROUP BY suburb,postcode ORDER BY suburb,postcode`;return Response.json({data:rows,meta:{rows:rows.length,source:"motherduck"}},{headers:{"Cache-Control":"public, s-maxage=86400, stale-while-revalidate=604800"}});}finally{await sql.end();}}
