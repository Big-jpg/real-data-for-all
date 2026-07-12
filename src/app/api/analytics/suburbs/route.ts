import { motherduck } from "@/lib/motherduck";
export const dynamic="force-dynamic";
export async function GET(){const sql=motherduck();try{const rows=await sql`SELECT suburb_key,suburb,canonical_postcode,observed_postcodes,sale_count,postcode_confidence FROM suburb_dimension ORDER BY suburb`;return Response.json({data:rows,meta:{rows:rows.length,source:"motherduck"}},{headers:{"Cache-Control":"public, s-maxage=86400, stale-while-revalidate=604800"}});}finally{await sql.end();}}
