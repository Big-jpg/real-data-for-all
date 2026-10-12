import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { database } from "../src/lib/db";

type Row = Record<string, string | number | Date | null>;
export type ServingDataset = { dimensions: Row[]; monthly: Row[]; facts: Row[] };
export type ServingSummary = { dimensions: number; monthly: number; facts: number; soldDateFrom: string; soldDateTo: string };

const isPlaceholder = (value: string) => /\[(?:SENSITIVE|REDACTED)\]|<[^>]+>|\*{4,}|^(?:redacted|changeme|your[_ -].*)$/i.test(value);

export function sourceDatabaseUrl(environment: Record<string, string | undefined> = process.env) {
  for (const name of ["DATABASE_READ_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]) {
    const value = environment[name]?.trim();
    if (!value || isPlaceholder(value)) continue;
    try {
      const parsed = new URL(value);
      if (["postgres:", "postgresql:"].includes(parsed.protocol) && parsed.hostname && parsed.username && parsed.password && !isPlaceholder(decodeURIComponent(parsed.password))) return value;
    } catch { /* Skip invalid candidates without exposing connection values. */ }
  }
  throw new Error("A usable DATABASE_READ_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is required; empty, redacted and invalid values are not accepted");
}

export function requiredMotherDuckToken(value = process.env.MOTHERDUCK_TOKEN) {
  const token = value?.trim();
  if (!token || isPlaceholder(token)) throw new Error("A usable MOTHERDUCK_TOKEN is required; empty or redacted values are not accepted");
  return token;
}

const tables = [
  { name: "suburb_dimension", dataset: "dimensions", batchSize: 1000,
    columns: ["suburb_key", "suburb", "canonical_postcode", "observed_postcodes", "sale_count", "postcode_confidence"],
    definition: "suburb_key varchar,suburb varchar,canonical_postcode varchar,observed_postcodes varchar,sale_count bigint,postcode_confidence decimal(5,4)" },
  { name: "suburb_monthly_sales", dataset: "monthly", batchSize: 1000,
    columns: ["suburb_key", "suburb", "postcode", "sale_month", "sale_count", "median_price_aud", "average_price_aud", "minimum_price_aud", "maximum_price_aud"],
    definition: "suburb_key varchar,suburb varchar,postcode varchar,sale_month date,sale_count bigint,median_price_aud bigint,average_price_aud bigint,minimum_price_aud bigint,maximum_price_aud bigint" },
  { name: "suburb_sale_facts", dataset: "facts", batchSize: 4000,
    columns: ["suburb_key", "sold_date", "price_aud", "land_size_sqm", "property_type", "bedrooms", "bathrooms", "car_spaces"],
    definition: "suburb_key varchar,sold_date date,price_aud bigint,land_size_sqm bigint,property_type varchar,bedrooms smallint,bathrooms smallint,car_spaces smallint" },
] as const;

const countValue = (value: unknown) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid serving count: ${String(value)}`);
  return number;
};
const isoDate = (value: unknown) => {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`Invalid serving date: ${date}`);
  return date;
};

export function publicationNames(snapshotId: string) {
  if (!/^[a-z0-9_]{8,32}$/.test(snapshotId)) throw new Error("Snapshot ID must contain 8–32 lowercase letters, numbers or underscores");
  return tables.map((table) => ({ live: table.name, staged: `${table.name}_next_${snapshotId}`, previous: `${table.name}_previous_${snapshotId}` }));
}

export function validateServingDataset(dataset: ServingDataset): ServingSummary {
  if (!dataset.dimensions.length || !dataset.monthly.length || !dataset.facts.length) throw new Error("Refusing to publish an empty serving dataset");
  const dimensions = new Map<string, Row>();
  for (const row of dataset.dimensions) {
    const key = String(row.suburb_key ?? "");
    if (!key || dimensions.has(key) || !String(row.suburb ?? "").trim()) throw new Error(`Invalid or duplicated suburb key: ${key}`);
    if (!/^6\d{3}$/.test(String(row.canonical_postcode)) || String(row.canonical_postcode) > "6200") throw new Error(`Suburb postcode outside serving scope: ${key}`);
    dimensions.set(key, row);
  }
  const factCounts = new Map<string, number>();
  const suburbCounts = new Map<string, number>();
  let soldDateFrom = "9999-12-31", soldDateTo = "0000-01-01";
  for (const row of dataset.facts) {
    const key = String(row.suburb_key);
    if (!dimensions.has(key) || String(row.property_type).trim().toLowerCase() !== "house") throw new Error(`Sale fact outside canonical House scope: ${key}`);
    const date = isoDate(row.sold_date);
    if (date < "1990-01-01") throw new Error(`Sale fact outside historical serving scope: ${date}`);
    soldDateFrom = date < soldDateFrom ? date : soldDateFrom;
    soldDateTo = date > soldDateTo ? date : soldDateTo;
    const monthKey = `${key}|${date.slice(0, 7)}`;
    factCounts.set(monthKey, (factCounts.get(monthKey) ?? 0) + 1);
    suburbCounts.set(key, (suburbCounts.get(key) ?? 0) + 1);
  }
  const monthlyKeys = new Set<string>();
  for (const row of dataset.monthly) {
    const key = String(row.suburb_key);
    const month = isoDate(row.sale_month);
    const monthKey = `${key}|${month.slice(0, 7)}`;
    if (!dimensions.has(key) || !month.endsWith("-01") || monthlyKeys.has(monthKey)) throw new Error(`Invalid or duplicated monthly key: ${monthKey}`);
    if (row.postcode !== dimensions.get(key)!.canonical_postcode || row.suburb !== dimensions.get(key)!.suburb || countValue(row.sale_count) !== factCounts.get(monthKey)) throw new Error(`Monthly mart does not reconcile with canonical facts: ${monthKey}`);
    monthlyKeys.add(monthKey);
  }
  if (monthlyKeys.size !== factCounts.size) throw new Error("Monthly mart is missing sale-fact months; refresh marts before publication");
  for (const [key, row] of dimensions) if (countValue(row.sale_count) !== suburbCounts.get(key)) throw new Error(`Suburb dimension does not reconcile with canonical facts: ${key}`);
  return { dimensions: dataset.dimensions.length, monthly: dataset.monthly.length, facts: dataset.facts.length, soldDateFrom, soldDateTo };
}

export function assertHistoricalRangePreserved(next: ServingSummary, previous: ServingSummary) {
  if (previous.facts && (next.soldDateFrom > previous.soldDateFrom || next.soldDateTo < previous.soldDateTo)) throw new Error("Source history does not span the existing serving history; refusing a truncated replacement");
}

export function rollbackStatements(snapshotId: string, displacedSnapshotId: string) {
  const originals = publicationNames(snapshotId), displaced = publicationNames(displacedSnapshotId);
  return ["BEGIN TRANSACTION;", ...originals.flatMap((table, index) => [
    `ALTER TABLE ${table.live} RENAME TO ${displaced[index].previous};`,
    `ALTER TABLE ${table.previous} RENAME TO ${table.live};`,
  ]), "COMMIT;"];
}

async function loadServingDataset(source: postgres.Sql): Promise<ServingDataset> {
  // One consistent source snapshot includes retained canonical history, not just the new capture.
  return source.begin("isolation level repeatable read read only", async (sql) => {
    const dimensions = await sql`SELECT suburb_key,suburb,canonical_postcode,observed_postcodes,sale_count,postcode_confidence FROM mart.suburb_dimension ORDER BY suburb`;
    const monthly = await sql`SELECT suburb_key,suburb,postcode,sale_month::text sale_month,sale_count,median_price_aud,average_price_aud,minimum_price_aud,maximum_price_aud
      FROM mart.suburb_monthly_sales ORDER BY suburb,sale_month`;
    const facts = await sql`SELECT d.suburb_key,s.sold_date::text sold_date,s.price_aud,s.land_size_sqm,s.property_type,s.bedrooms,s.bathrooms,s.car_spaces
      FROM core.sale_event s JOIN core.property p USING(property_id)
      JOIN mart.suburb_dimension d ON d.suburb_key=trim(both '-' from regexp_replace(lower(trim(p.suburb)),'[^a-z0-9]+','-','g'))
      WHERE s.sold_date>=DATE '1990-01-01' AND p.postcode BETWEEN '6000' AND '6200'
        AND lower(trim(s.property_type))='house' ORDER BY d.suburb_key,s.sold_date`;
    return { dimensions: [...dimensions], monthly: [...monthly], facts: [...facts] };
  });
}

async function readSummary(sql: postgres.TransactionSql, names: ReturnType<typeof publicationNames>, version: "live" | "staged"): Promise<ServingSummary> {
  const [{ count: dimensions }] = await sql`SELECT count(*)::bigint count FROM ${sql(names[0][version])}`;
  const [{ count: monthly }] = await sql`SELECT count(*)::bigint count FROM ${sql(names[1][version])}`;
  const [facts] = await sql`SELECT count(*)::bigint count,min(sold_date)::text sold_date_from,max(sold_date)::text sold_date_to FROM ${sql(names[2][version])}`;
  return { dimensions: countValue(dimensions), monthly: countValue(monthly), facts: countValue(facts.count), soldDateFrom: facts.sold_date_from ? isoDate(facts.sold_date_from) : "", soldDateTo: facts.sold_date_to ? isoDate(facts.sold_date_to) : "" };
}

export async function publishServingDataset(target: postgres.Sql, dataset: ServingDataset, snapshotId: string) {
  const expected = validateServingDataset(dataset);
  const names = publicationNames(snapshotId);
  const previous = await target.begin(async (sql) => {
    const existing = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_catalog=current_database()
      AND table_name IN ('suburb_dimension','suburb_monthly_sales','suburb_sale_facts')`;
    if (existing.length !== 3) throw new Error("All three existing serving tables are required for a recoverable publication");
    const previous = await readSummary(sql, names, "live");
    assertHistoricalRangePreserved(expected, previous);
    for (const [index, table] of tables.entries()) {
      await sql`CREATE TABLE ${sql(names[index].staged)} (${sql.unsafe(table.definition)})`;
      const rows = dataset[table.dataset];
      for (let offset = 0; offset < rows.length; offset += table.batchSize) await sql`INSERT INTO ${sql(names[index].staged)} ${sql(rows.slice(offset, offset + table.batchSize), ...table.columns)}`;
    }
    const staged = await readSummary(sql, names, "staged");
    if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Error("Staged serving tables do not reconcile with the source snapshot");
    // Preserve the previous generation and switch all serving names in the same transaction.
    for (const table of names) await sql`ALTER TABLE ${sql(table.live)} RENAME TO ${sql(table.previous)}`;
    for (const table of names) await sql`ALTER TABLE ${sql(table.staged)} RENAME TO ${sql(table.live)}`;
    return previous;
  });
  return { snapshotId, source: expected, previous, snapshotTables: names.map((table) => table.previous),
    rollbackSql: rollbackStatements(snapshotId, `rollback_${randomUUID().slice(0, 8)}`),
    verification: "Run smoke:motherduck and compare live table counts/date range to source; snapshots remain retained until explicitly removed." };
}

async function main() {
  const token = requiredMotherDuckToken();
  const source = database(sourceDatabaseUrl());
  const target = postgres({ host: process.env.MOTHERDUCK_PG_HOST || "pg.us-east-1-aws.motherduck.com", port: 5432,
    database: "md:real_data_for_all", username: "postgres", password: token, ssl: "require", max: 1, prepare: false });
  try {
    const snapshotId = `${new Date().toISOString().replace(/[-:.]/g, "").toLowerCase()}_${randomUUID().slice(0, 8)}`;
    const result = await publishServingDataset(target, await loadServingDataset(source), snapshotId);
    console.log(JSON.stringify({ status: "published", database: "real_data_for_all", ...result }, null, 2));
  } finally { await source.end(); await target.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
