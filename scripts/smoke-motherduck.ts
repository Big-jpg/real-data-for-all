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
  console.log(`MotherDuck smoke query passed: ${rows.length} rows sampled`);
} finally { await sql.end(); }
