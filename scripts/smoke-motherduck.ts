import { motherduck } from "../src/lib/motherduck";

const sql=motherduck();
try {
  const postcode="6060",from="2020-01-01",to="2026-12-31";
  const rows=await sql`SELECT suburb,postcode,sale_month FROM suburb_monthly_sales
    WHERE true ${sql`AND postcode=${postcode}`}
      ${sql.unsafe(`AND sale_month>=DATE '${from}'`)}
      ${sql.unsafe(`AND sale_month<=DATE '${to}'`)}
    ORDER BY sale_month DESC LIMIT 5`;
  if(!rows.length) throw new Error("MotherDuck smoke query returned no rows");
  console.log(`MotherDuck smoke query passed: ${rows.length} rows sampled`);
} finally { await sql.end(); }
