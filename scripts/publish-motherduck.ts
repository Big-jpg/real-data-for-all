import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { database } from "../src/lib/db";
import { createAnnualRepeatSalesDataset, type AnnualMedianPoint, type RepeatSalePair } from "./repeat-sales-index";
import { sourceDatabaseUrl } from "./database-urls";

export { sourceDatabaseUrl } from "./database-urls";

type Row = Record<string, string | number | boolean | Date | null>;
export type ServingDataset = { dimensions: Row[]; monthly: Row[]; facts: Row[]; pairs: Row[]; annualIndex: Row[] };
export type ServingSummary = {
  dimensions: number; monthly: number; facts: number; pairs: number; validPricePairs: number; sameDayValidPairs: number;
  annualIndexRows: number; soldDateFrom: string; soldDateTo: string;
};

const isPlaceholder = (value: string) => /\[(?:SENSITIVE|REDACTED)\]|<[^>]+>|\*{4,}|^(?:redacted|changeme|your[_ -].*)$/i.test(value);

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
    columns: ["property_key", "suburb_key", "sold_date", "price_aud", "land_size_sqm", "property_type", "bedrooms", "bathrooms", "car_spaces"],
    definition: "property_key varchar(64),suburb_key varchar,sold_date date,price_aud bigint,land_size_sqm bigint,property_type varchar,bedrooms smallint,bathrooms smallint,car_spaces smallint" },
  { name: "repeat_sale_pair_data", dataset: "pairs", batchSize: 4000,
    columns: ["pair_key", "property_key", "earlier_suburb_key", "later_suburb_key", "earlier_sold_date", "later_sold_date", "earlier_price_aud", "later_price_aud"],
    definition: "pair_key varchar(64),property_key varchar(64),earlier_suburb_key varchar,later_suburb_key varchar,earlier_sold_date date,later_sold_date date,earlier_price_aud bigint,later_price_aud bigint" },
  { name: "annual_repeat_sales_index", dataset: "annualIndex", batchSize: 1000,
    columns: ["model_version", "source_snapshot_id", "source_snapshot_at", "executed_at", "reference_year", "reporting_window_start", "reporting_window_end",
      "series_key", "series_label", "observation_year", "index_level", "index_lower_95", "index_upper_95", "annual_change_pct",
      "annual_change_lower_95_pct", "annual_change_upper_95_pct", "pair_count", "identifying_pair_count", "same_year_diagnostic_pair_count",
      "contributing_property_count", "year_identifying_pair_count", "year_contributing_property_count", "sale_count", "eligibility_criteria"],
    definition: "model_version varchar,source_snapshot_id varchar,source_snapshot_at varchar,executed_at varchar,reference_year integer,reporting_window_start integer,reporting_window_end integer,series_key varchar,series_label varchar,observation_year integer,index_level double precision,index_lower_95 double precision,index_upper_95 double precision,annual_change_pct double precision,annual_change_lower_95_pct double precision,annual_change_upper_95_pct double precision,pair_count bigint,identifying_pair_count bigint,same_year_diagnostic_pair_count bigint,contributing_property_count bigint,year_identifying_pair_count bigint,year_contributing_property_count bigint,sale_count bigint,eligibility_criteria varchar" },
] as const;

const validOriginalTables = ["suburb_dimension", "suburb_monthly_sales", "suburb_sale_facts"] as const;
const livePairView = "repeat_sale_pairs";
const propertyKeyPattern = /^[a-f0-9]{64}$/;

function pairViewSql(viewName: string, tableName: string) {
  for (const name of [viewName, tableName]) if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error("Unsafe repeat-sale view object name");
  return `CREATE VIEW ${viewName} AS
WITH dated_pairs AS (
  SELECT pair_key,property_key,earlier_suburb_key,later_suburb_key,
    earlier_sold_date,later_sold_date,earlier_price_aud,later_price_aud,
    (later_sold_date-earlier_sold_date)::integer AS holding_days
  FROM ${tableName}
), return_inputs AS (
  SELECT *,
    CASE WHEN holding_days>0 AND earlier_price_aud>0 AND later_price_aud>0
      THEN ln(later_price_aud::double precision/earlier_price_aud::double precision)*365.25/holding_days
    END AS annualized_log_return
  FROM dated_pairs
), annualized AS (
  SELECT *,
    CASE
      WHEN annualized_log_return IS NULL THEN NULL
      WHEN annualized_log_return>700 THEN NULL
      WHEN annualized_log_return< -700 THEN -100.0
      ELSE (exp(annualized_log_return)-1)*100
    END AS raw_annualized_return_pct
  FROM return_inputs
), diagnostics AS (
  SELECT *,
    (earlier_price_aud IS NULL OR later_price_aud IS NULL) AS has_missing_endpoint_price,
    (coalesce(earlier_price_aud<=0,false) OR coalesce(later_price_aud<=0,false)) AS has_nonpositive_endpoint_price,
    (coalesce(earlier_price_aud NOT BETWEEN 50000 AND 20000000,false)
      OR coalesce(later_price_aud NOT BETWEEN 50000 AND 20000000,false)) AS has_price_outside_analysis_range,
    (holding_days=0) AS is_same_day_ambiguous,
    (holding_days<0) AS has_invalid_holding_period,
    (annualized_log_return>700) AS has_annualized_return_overflow,
    coalesce(earlier_price_aud BETWEEN 50000 AND 20000000
      AND later_price_aud BETWEEN 50000 AND 20000000,false) AS has_valid_price_endpoints
  FROM annualized
)
SELECT *,
  (holding_days>0 AND has_valid_price_endpoints) AS return_eligible,
  (raw_annualized_return_pct BETWEEN -50 AND 100) AS is_plausible_annualized_return,
  (holding_days>=90 AND has_valid_price_endpoints) AS eligible_at_90_days,
  (holding_days>=180 AND has_valid_price_endpoints) AS eligible_at_180_days,
  (holding_days>=365 AND has_valid_price_endpoints) AS eligible_at_365_days,
  (holding_days>=90 AND has_valid_price_endpoints AND raw_annualized_return_pct BETWEEN -50 AND 100) AS plausible_at_90_days,
  (holding_days>=180 AND has_valid_price_endpoints AND raw_annualized_return_pct BETWEEN -50 AND 100) AS plausible_at_180_days,
  (holding_days>=365 AND has_valid_price_endpoints AND raw_annualized_return_pct BETWEEN -50 AND 100) AS plausible_at_365_days,
  CASE
    WHEN is_same_day_ambiguous THEN 'same_day_ambiguous'
    WHEN has_invalid_holding_period THEN 'invalid_holding_period'
    WHEN has_missing_endpoint_price THEN 'missing_endpoint_price'
    WHEN has_nonpositive_endpoint_price THEN 'nonpositive_endpoint_price'
    WHEN has_price_outside_analysis_range THEN 'price_outside_analysis_range'
    WHEN has_annualized_return_overflow THEN 'annualized_return_overflow'
    ELSE NULL
  END AS primary_exclusion_reason
FROM diagnostics`;
}

function identityChecksum(keys: string[]) {
  return createHash("sha256").update([...keys].sort().join("\n")).digest("hex");
}

function normalizeViewDefinition(definition: string) {
  const normalized = definition.trim().replace(/;+\s*$/, "");
  const createStatement = /^CREATE VIEW repeat_sale_pairs AS\s+([\s\S]+)$/i.exec(normalized);
  const query = createStatement?.[1] ?? normalized;
  if (!/^(?:WITH\b|SELECT\b)/i.test(query)) throw new Error("Existing repeat-sale view definition is not safe to preserve");
  return `CREATE VIEW ${livePairView} AS ${query};`;
}

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
  const propertyKeys = new Set<string>();
  let soldDateFrom = "9999-12-31", soldDateTo = "0000-01-01";
  for (const row of dataset.facts) {
    const key = String(row.suburb_key);
    if (!dimensions.has(key) || String(row.property_type).trim().toLowerCase() !== "house") throw new Error(`Sale fact outside canonical House scope: ${key}`);
    if (!propertyKeyPattern.test(String(row.property_key ?? ""))) throw new Error(`Invalid pseudonymous property key in sale fact: ${key}`);
    propertyKeys.add(String(row.property_key));
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
  const pairKeys = new Set<string>();
  for (const row of dataset.pairs) {
    const pairKey = String(row.pair_key ?? ""), propertyKey = String(row.property_key ?? "");
    if (!/^[a-f0-9]{64}$/.test(pairKey) || pairKeys.has(pairKey)) throw new Error(`Invalid or duplicated repeat-sale pair key: ${pairKey}`);
    if (!propertyKeyPattern.test(propertyKey) || !propertyKeys.has(propertyKey)) throw new Error(`Repeat-sale pair has no matching serving property key: ${pairKey}`);
    if (!dimensions.has(String(row.earlier_suburb_key)) || !dimensions.has(String(row.later_suburb_key))) throw new Error(`Repeat-sale pair suburb is outside the serving dimensions: ${pairKey}`);
    const earlierDate = isoDate(row.earlier_sold_date), laterDate = isoDate(row.later_sold_date);
    if (earlierDate < "1990-01-01" || laterDate < earlierDate) throw new Error(`Repeat-sale pair has an invalid holding period: ${pairKey}`);
    pairKeys.add(pairKey);
  }
  const validPricePairs = dataset.pairs.filter((row) => Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
    && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000);
  const analyticalSeries = ["annual_median_price", "repeat_sales_huber", "repeat_sales_ols_return_band", "repeat_sales_ols_untrimmed"];
  const analyticalKeys = new Set<string>();
  const releaseSnapshotId = String(dataset.annualIndex[0]?.source_snapshot_id ?? "");
  const releaseSnapshotAt = String(dataset.annualIndex[0]?.source_snapshot_at ?? "");
  const releaseExecutedAt = String(dataset.annualIndex[0]?.executed_at ?? "");
  if (!/^[a-z0-9_]{8,64}$/.test(releaseSnapshotId) || !releaseSnapshotAt || !releaseExecutedAt) throw new Error("Annual index source snapshot metadata is invalid");
  for (const row of dataset.annualIndex) {
    const series = String(row.series_key ?? ""), year = countValue(row.observation_year);
    const key = `${series}|${year}`;
    if (!analyticalSeries.includes(series) || year < 2009 || year > 2025 || analyticalKeys.has(key)) throw new Error(`Invalid or duplicated annual index record: ${key}`);
    if (String(row.model_version) !== "annual-repeat-sales-v1" || String(row.source_snapshot_id) !== releaseSnapshotId
      || String(row.source_snapshot_at) !== releaseSnapshotAt || String(row.executed_at) !== releaseExecutedAt
      || countValue(row.reference_year) !== 2020 || countValue(row.reporting_window_start) !== 2009
      || countValue(row.reporting_window_end) !== 2025 || !String(row.eligibility_criteria ?? "")) throw new Error(`Annual index metadata is incomplete: ${key}`);
    const index = row.index_level == null ? NaN : Number(row.index_level);
    if (!Number.isFinite(index)) throw new Error(`Annual index level is invalid: ${key}`);
    if (year === 2020 && Math.abs(index - 100) > 1e-8) throw new Error(`Annual series is not normalized to 100 in 2020: ${key}`);
    const pairCount = row.pair_count == null ? null : countValue(row.pair_count);
    if (series === "annual_median_price") {
      if (row.index_lower_95 != null || row.index_upper_95 != null || row.sale_count == null) throw new Error(`Median comparator uncertainty or counts are invalid: ${key}`);
    } else {
      if (pairCount === null || pairCount < 1 || countValue(row.identifying_pair_count) < 1
        || countValue(row.contributing_property_count) < 1 || row.sale_count != null) throw new Error(`Repeat-sales sample counts are invalid: ${key}`);
      const lower = Number(row.index_lower_95), upper = Number(row.index_upper_95);
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > index || index > upper) throw new Error(`Annual index confidence interval is invalid: ${key}`);
      const annualChange = Number(row.annual_change_pct), annualLower = Number(row.annual_change_lower_95_pct), annualUpper = Number(row.annual_change_upper_95_pct);
      if (!Number.isFinite(annualChange) || !Number.isFinite(annualLower) || !Number.isFinite(annualUpper)
        || annualLower > annualChange || annualChange > annualUpper) throw new Error(`Annual appreciation confidence interval is invalid: ${key}`);
    }
    analyticalKeys.add(key);
  }
  if (analyticalKeys.size !== analyticalSeries.length * 17) throw new Error("Annual analytical dataset must contain all four 2009–2025 series");
  for (const series of analyticalSeries) for (let year = 2009; year <= 2025; year++) {
    if (!analyticalKeys.has(`${series}|${year}`)) throw new Error(`Annual analytical dataset is missing ${series} for ${year}`);
  }
  return {
    dimensions: dataset.dimensions.length, monthly: dataset.monthly.length, facts: dataset.facts.length,
    pairs: dataset.pairs.length, validPricePairs: validPricePairs.length,
    sameDayValidPairs: validPricePairs.filter((row) => isoDate(row.earlier_sold_date) === isoDate(row.later_sold_date)).length,
    annualIndexRows: dataset.annualIndex.length,
    soldDateFrom, soldDateTo,
  };
}

export function assertHistoricalRangePreserved(next: ServingSummary, previous: ServingSummary) {
  if (previous.facts && (next.soldDateFrom > previous.soldDateFrom || next.soldDateTo < previous.soldDateTo)) throw new Error("Source history does not span the existing serving history; refusing a truncated replacement");
}

export function rollbackStatements(
  snapshotId: string,
  displacedSnapshotId: string,
  previousViewDefinition?: string,
  previousTables: string[] = publicationNames(snapshotId).map((table) => table.previous),
) {
  const originals = publicationNames(snapshotId), displaced = publicationNames(displacedSnapshotId);
  const restoreView = previousViewDefinition ? normalizeViewDefinition(previousViewDefinition) : undefined;
  const statements = ["BEGIN TRANSACTION;", `DROP VIEW IF EXISTS ${livePairView};`];
  for (const [index, table] of originals.entries()) {
    statements.push(`ALTER TABLE ${table.live} RENAME TO ${displaced[index].previous};`);
    if (previousTables.includes(table.previous)) statements.push(`ALTER TABLE ${table.previous} RENAME TO ${table.live};`);
  }
  if (restoreView) statements.push(restoreView);
  statements.push("COMMIT;");
  return statements;
}

type LoadedSource = {
  dataset: Omit<ServingDataset, "annualIndex">;
  medians: AnnualMedianPoint[];
  sourceSnapshotAt: string;
};

async function loadServingDataset(source: postgres.Sql): Promise<LoadedSource> {
  // One consistent source snapshot includes retained canonical history, not just the new capture.
  return source.begin("isolation level repeatable read read only", async (sql) => {
    const [{ source_snapshot_at }] = await sql<{ source_snapshot_at: string }[]>`SELECT current_timestamp::text source_snapshot_at`;
    const dimensions = await sql`SELECT suburb_key,suburb,canonical_postcode,observed_postcodes,sale_count,postcode_confidence FROM mart.suburb_dimension ORDER BY suburb`;
    const monthly = await sql`SELECT suburb_key,suburb,postcode,sale_month::text sale_month,sale_count,median_price_aud,average_price_aud,minimum_price_aud,maximum_price_aud
      FROM mart.suburb_monthly_sales ORDER BY suburb,sale_month`;
    const facts = await sql`SELECT encode(digest('perth-house-data:property:v1:'||s.property_id::text,'sha256'),'hex') AS property_key,
      d.suburb_key,s.sold_date::text sold_date,s.price_aud,s.land_size_sqm,s.property_type,s.bedrooms,s.bathrooms,s.car_spaces
      FROM core.sale_event s JOIN core.property p USING(property_id)
      JOIN mart.suburb_dimension d ON d.suburb_key=trim(both '-' from regexp_replace(lower(trim(p.suburb)),'[^a-z0-9]+','-','g'))
      WHERE s.sold_date>=DATE '1990-01-01' AND p.postcode BETWEEN '6000' AND '6200'
        AND lower(trim(s.property_type))='house' ORDER BY d.suburb_key,s.sold_date`;
    const pairs = await sql`WITH dated_events AS (
        SELECT s.sale_event_id,s.property_id,s.sold_date,s.price_aud,
          trim(both '-' from regexp_replace(lower(trim(p.suburb)),'[^a-z0-9]+','-','g')) AS suburb_key,
          (s.sold_date>=DATE '1990-01-01' AND p.postcode BETWEEN '6000' AND '6200'
            AND lower(trim(s.property_type))='house' AND nullif(trim(p.suburb),'') IS NOT NULL) AS in_serving_scope
        FROM core.sale_event s JOIN core.property p USING(property_id)
        WHERE s.sold_date IS NOT NULL
      ), sequenced AS (
        SELECT *,
          lag(sale_event_id) OVER property_history AS earlier_sale_event_id,
          lag(property_id) OVER property_history AS earlier_property_id,
          lag(sold_date) OVER property_history AS earlier_sold_date,
          lag(price_aud) OVER property_history AS earlier_price_aud,
          lag(suburb_key) OVER property_history AS earlier_suburb_key,
          lag(in_serving_scope) OVER property_history AS earlier_in_serving_scope
        FROM dated_events
        WINDOW property_history AS (PARTITION BY property_id ORDER BY sold_date,sale_event_id)
      )
      SELECT encode(digest(earlier_sale_event_id::text||':'||sale_event_id::text,'sha256'),'hex') AS pair_key,
        encode(digest('perth-house-data:property:v1:'||property_id::text,'sha256'),'hex') AS property_key,
        earlier_suburb_key,later_suburb_key,earlier_sold_date::text earlier_sold_date,sold_date::text later_sold_date,
        earlier_price_aud,price_aud later_price_aud,(sold_date-earlier_sold_date)::integer holding_days
      FROM (
        SELECT *,suburb_key AS later_suburb_key FROM sequenced
      ) adjacent
      WHERE earlier_sale_event_id IS NOT NULL AND earlier_in_serving_scope AND in_serving_scope
      ORDER BY property_key,earlier_sold_date,sold_date,pair_key`;
    const medians = await sql<AnnualMedianPoint[]>`SELECT date_part('year',s.sold_date)::int AS year,
        count(*)::int AS sale_count,
        percentile_cont(.5) WITHIN GROUP(ORDER BY s.price_aud)::double precision AS median_price_aud
      FROM core.sale_event s JOIN core.property p USING(property_id)
      WHERE s.sold_date BETWEEN DATE '2008-01-01' AND DATE '2025-12-31'
        AND s.price_aud IS NOT NULL AND s.sold_date>=DATE '1990-01-01'
        AND p.postcode BETWEEN '6000' AND '6200' AND lower(trim(s.property_type))='house'
        AND nullif(trim(p.suburb),'') IS NOT NULL
      GROUP BY 1 ORDER BY 1`;
    return {
      dataset: { dimensions: [...dimensions], monthly: [...monthly], facts: [...facts], pairs: [...pairs] },
      medians: [...medians],
      sourceSnapshotAt: source_snapshot_at,
    };
  });
}

function repeatPairsForIndex(dataset: Omit<ServingDataset, "annualIndex">): RepeatSalePair[] {
  const suburbs = new Map(dataset.dimensions.map((row) => [String(row.suburb_key), String(row.suburb)]));
  return dataset.pairs.flatMap((row) => {
    const earlierPrice = Number(row.earlier_price_aud), laterPrice = Number(row.later_price_aud);
    const earlierDate = isoDate(row.earlier_sold_date), laterDate = isoDate(row.later_sold_date);
    const holdingDays = countValue(row.holding_days);
    if (earlierPrice < 50000 || earlierPrice > 20000000 || laterPrice < 50000 || laterPrice > 20000000 || holdingDays <= 0) return [];
    const suburb = suburbs.get(String(row.later_suburb_key));
    const propertyKey = String(row.property_key ?? "");
    if (!suburb || !propertyKeyPattern.test(propertyKey)) throw new Error("Repeat-sale index input has an invalid serving suburb or pseudonymous property key");
    return [{
      property_key: propertyKey,
      suburb,
      postcode: null,
      property_type: "House",
      bedrooms: null,
      bathrooms: null,
      car_spaces: null,
      land_size_sqm: null,
      earlier_sold_date: earlierDate,
      later_sold_date: laterDate,
      earlier_price_aud: earlierPrice,
      later_price_aud: laterPrice,
      holding_days: holdingDays,
    }];
  });
}

async function readSummary(
  sql: postgres.TransactionSql,
  names: ReturnType<typeof publicationNames>,
  version: "live" | "staged",
  hasPairTable = true,
  hasAnnualIndexTable = true,
): Promise<ServingSummary> {
  const [{ count: dimensions }] = await sql`SELECT count(*)::bigint count FROM ${sql(names[0][version])}`;
  const [{ count: monthly }] = await sql`SELECT count(*)::bigint count FROM ${sql(names[1][version])}`;
  const [facts] = await sql`SELECT count(*)::bigint count,min(sold_date)::text sold_date_from,max(sold_date)::text sold_date_to FROM ${sql(names[2][version])}`;
  const pairSummary = hasPairTable
    ? (await sql`SELECT count(*)::bigint count,
        count(*) FILTER(WHERE earlier_price_aud BETWEEN 50000 AND 20000000 AND later_price_aud BETWEEN 50000 AND 20000000)::bigint valid_price_pairs,
        count(*) FILTER(WHERE earlier_sold_date=later_sold_date AND earlier_price_aud BETWEEN 50000 AND 20000000 AND later_price_aud BETWEEN 50000 AND 20000000)::bigint same_day_valid_pairs
      FROM ${sql(names[3][version])}`)[0]
    : { count: 0, valid_price_pairs: 0, same_day_valid_pairs: 0 };
  const [{ count: annualIndexRows }] = hasAnnualIndexTable
    ? await sql`SELECT count(*)::bigint count FROM ${sql(names[4][version])}`
    : [{ count: 0 }];
  return {
    dimensions: countValue(dimensions), monthly: countValue(monthly), facts: countValue(facts.count),
    pairs: countValue(pairSummary.count), validPricePairs: countValue(pairSummary.valid_price_pairs),
    sameDayValidPairs: countValue(pairSummary.same_day_valid_pairs),
    annualIndexRows: countValue(annualIndexRows),
    soldDateFrom: facts.sold_date_from ? isoDate(facts.sold_date_from) : "",
    soldDateTo: facts.sold_date_to ? isoDate(facts.sold_date_to) : "",
  };
}

async function validatePairView(sql: postgres.TransactionSql, viewName: string, dataset: ServingDataset, expected: ServingSummary) {
  const allKeys = dataset.pairs.map((row) => String(row.pair_key));
  const eligibleKeys = dataset.pairs.filter((row) => Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
    && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000).map((row) => String(row.pair_key));
  const [actual] = await sql.unsafe(`SELECT count(*)::bigint pair_count,count(DISTINCT pair_key)::bigint unique_pair_count,
    sha256(string_agg(pair_key,chr(10) ORDER BY pair_key)) all_identity_checksum,
    count(*) FILTER(WHERE has_valid_price_endpoints)::bigint valid_price_pair_count,
    sha256(string_agg(pair_key,chr(10) ORDER BY pair_key) FILTER(WHERE has_valid_price_endpoints)) valid_identity_checksum,
    count(*) FILTER(WHERE pair_key !~ '^[a-f0-9]{64}$' OR property_key !~ '^[a-f0-9]{64}$'
      OR holding_days<0 OR (holding_days=0 AND raw_annualized_return_pct IS NOT NULL)
      OR (holding_days>0 AND earlier_price_aud>0 AND later_price_aud>0
        AND NOT has_annualized_return_overflow AND raw_annualized_return_pct IS NULL))::bigint invalid_rows,
    count(*) FILTER(WHERE return_eligible)::bigint positive_hold_valid_count,
    count(*) FILTER(WHERE return_eligible AND is_plausible_annualized_return)::bigint plausible_return_count,
    count(*) FILTER(WHERE eligible_at_90_days)::bigint eligible_90_day_count,
    count(*) FILTER(WHERE eligible_at_180_days)::bigint eligible_180_day_count,
    count(*) FILTER(WHERE eligible_at_365_days)::bigint eligible_365_day_count,
    count(*) FILTER(WHERE plausible_at_90_days)::bigint plausible_90_day_count,
    count(*) FILTER(WHERE plausible_at_180_days)::bigint plausible_180_day_count,
    count(*) FILTER(WHERE plausible_at_365_days)::bigint plausible_365_day_count,
    count(*) FILTER(WHERE has_valid_price_endpoints AND holding_days>0 AND holding_days<90)::bigint short_hold_excluded_90_count,
    count(*) FILTER(WHERE has_valid_price_endpoints AND holding_days>0 AND holding_days<180)::bigint short_hold_excluded_180_count,
    count(*) FILTER(WHERE has_valid_price_endpoints AND holding_days>0 AND holding_days<365)::bigint short_hold_excluded_365_count
    FROM ${viewName}`);
  if (countValue(actual.pair_count) !== expected.pairs
    || countValue(actual.unique_pair_count) !== expected.pairs
    || actual.all_identity_checksum !== identityChecksum(allKeys)
    || countValue(actual.valid_price_pair_count) !== expected.validPricePairs
    || actual.valid_identity_checksum !== identityChecksum(eligibleKeys)
    || countValue(actual.invalid_rows) !== 0) {
    throw new Error(`Repeat-sale staged identities failed validation for ${viewName}`);
  }
  return {
    positiveHoldValidPairs: countValue(actual.positive_hold_valid_count),
    plausibleAnnualizedReturns: countValue(actual.plausible_return_count),
    eligibleAt90Days: countValue(actual.eligible_90_day_count),
    eligibleAt180Days: countValue(actual.eligible_180_day_count),
    eligibleAt365Days: countValue(actual.eligible_365_day_count),
    plausibleAt90Days: countValue(actual.plausible_90_day_count),
    plausibleAt180Days: countValue(actual.plausible_180_day_count),
    plausibleAt365Days: countValue(actual.plausible_365_day_count),
    excludedBy90DayMinimum: countValue(actual.short_hold_excluded_90_count),
    excludedBy180DayMinimum: countValue(actual.short_hold_excluded_180_count),
    excludedBy365DayMinimum: countValue(actual.short_hold_excluded_365_count),
  };
}

async function validateAnnualIndexTable(sql: postgres.TransactionSql, tableName: string, expected: Row[]) {
  if (!/^[a-z0-9_]{1,63}$/.test(tableName)) throw new Error("Unsafe annual index table name");
  const actual = await sql`SELECT * FROM ${sql(tableName)} ORDER BY series_key,observation_year`;
  const expectedSorted = [...expected].sort((left, right) => String(left.series_key).localeCompare(String(right.series_key))
    || Number(left.observation_year) - Number(right.observation_year));
  const numericFields = new Set([
    "reference_year", "reporting_window_start", "reporting_window_end", "observation_year", "index_level", "index_lower_95", "index_upper_95",
    "annual_change_pct", "annual_change_lower_95_pct", "annual_change_upper_95_pct", "pair_count", "identifying_pair_count",
    "same_year_diagnostic_pair_count", "contributing_property_count", "year_identifying_pair_count",
    "year_contributing_property_count", "sale_count",
  ]);
  if (actual.length !== expectedSorted.length) throw new Error(`Annual index staged row count mismatch for ${tableName}`);
  for (let index = 0; index < expectedSorted.length; index++) {
    for (const [field, expectedValue] of Object.entries(expectedSorted[index])) {
      const actualValue = actual[index][field];
      if (numericFields.has(field)) {
        if (expectedValue == null || actualValue == null) {
          if (expectedValue !== actualValue) throw new Error(`Annual index staged value mismatch for ${field} at row ${index}`);
        } else if (!Number.isFinite(Number(actualValue)) || Math.abs(Number(actualValue) - Number(expectedValue)) > 1e-8) {
          throw new Error(`Annual index staged value mismatch for ${field} at row ${index}`);
        }
      } else if (String(actualValue ?? "") !== String(expectedValue ?? "")) {
        throw new Error(`Annual index staged value mismatch for ${field} at row ${index}`);
      }
    }
  }
}

export async function publishServingDataset(
  target: postgres.Sql,
  dataset: ServingDataset,
  snapshotId: string,
  options: { validateOnly?: boolean } = {},
) {
  const expected = validateServingDataset(dataset);
  const names = publicationNames(snapshotId);
  const previous = await target.begin(async (sql) => {
    const existing = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_catalog=current_database()
      AND table_name IN ('suburb_dimension','suburb_monthly_sales','suburb_sale_facts','repeat_sale_pair_data','annual_repeat_sales_index')`;
    const existingTables = new Set(existing.map((row) => String(row.table_name)));
    if (!validOriginalTables.every((table) => existingTables.has(table))) throw new Error("All three existing serving tables are required for a recoverable publication");
    const [oldView] = await sql`SELECT view_definition FROM information_schema.views WHERE table_schema=current_schema() AND table_catalog=current_database()
      AND table_name=${livePairView}`;
    const previousViewDefinition = oldView?.view_definition ? normalizeViewDefinition(String(oldView.view_definition)) : undefined;
    if (existingTables.has(names[3].live) !== Boolean(previousViewDefinition)) throw new Error("Repeat-sale pair table and view are not in a recoverable state");
    const previous = await readSummary(sql, names, "live", existingTables.has(names[3].live), existingTables.has(names[4].live));
    assertHistoricalRangePreserved(expected, previous);
    for (const [index, table] of tables.entries()) {
      await sql`CREATE TABLE ${sql(names[index].staged)} (${sql.unsafe(table.definition)})`;
      const rows = dataset[table.dataset];
      for (let offset = 0; offset < rows.length; offset += table.batchSize) await sql`INSERT INTO ${sql(names[index].staged)} ${sql(rows.slice(offset, offset + table.batchSize), ...table.columns)}`;
    }
    const staged = await readSummary(sql, names, "staged");
    if (JSON.stringify(staged) !== JSON.stringify(expected)) throw new Error("Staged serving tables do not reconcile with the source snapshot");
    await validateAnnualIndexTable(sql, names[4].staged, dataset.annualIndex);
    const stagedView = `repeat_sale_pairs_next_${snapshotId}`;
    await sql.unsafe(pairViewSql(stagedView, names[3].staged));
    const pairAnalysis = await validatePairView(sql, stagedView, dataset, expected);
    await sql.unsafe(`DROP VIEW ${stagedView}`);

    if (options.validateOnly) {
      for (const table of [...names].reverse()) await sql`DROP TABLE ${sql(table.staged)}`;
      return { previous, previousViewDefinition, previousTableNames: [] as string[], pairAnalysis };
    }

    if (previousViewDefinition) await sql.unsafe(`DROP VIEW ${livePairView}`);
    const previousTableNames = names.filter((table) => existingTables.has(table.live));
    for (const table of previousTableNames) {
      const current = names.find((name) => name.live === table.live)!;
      await sql`ALTER TABLE ${sql(current.live)} RENAME TO ${sql(current.previous)}`;
    }
    for (const table of names) await sql`ALTER TABLE ${sql(table.staged)} RENAME TO ${sql(table.live)}`;
    await sql.unsafe(pairViewSql(livePairView, names[3].live));
    const promotedPairAnalysis = await validatePairView(sql, livePairView, dataset, expected);
    return { previous, previousViewDefinition, previousTableNames: previousTableNames.map((table) => table.previous), pairAnalysis: promotedPairAnalysis };
  });
  if (options.validateOnly) return { status: "validated" as const, snapshotId, source: expected, pairAnalysis: previous.pairAnalysis,
    verification: "Staged table schemas and repeat-sale pair identities validated; all scratch staging objects were removed without promotion." };
  return { snapshotId, source: expected, pairAnalysis: previous.pairAnalysis, previous: previous.previous, snapshotTables: previous.previousTableNames,
    rollbackSql: rollbackStatements(snapshotId, `rollback_${randomUUID().slice(0, 8)}`, previous.previousViewDefinition, previous.previousTableNames),
    verification: "Run smoke:motherduck; previous tables and any prior pair-view definition remain recoverable in the retained snapshot." };
}

async function main() {
  const token = requiredMotherDuckToken();
  const source = database(sourceDatabaseUrl());
  const target = postgres({ host: process.env.MOTHERDUCK_PG_HOST || "pg.us-east-1-aws.motherduck.com", port: 5432,
    database: "md:real_data_for_all", username: "postgres", password: token, ssl: "require", max: 1, prepare: false });
  try {
    const snapshotId = `${new Date().toISOString().replace(/[-:.]/g, "").toLowerCase()}_${randomUUID().slice(0, 8)}`;
    const validateOnly = process.argv.includes("--validate-only");
    const loaded = await loadServingDataset(source);
    const executedAt = new Date().toISOString();
    const annualIndex = createAnnualRepeatSalesDataset(
      repeatPairsForIndex(loaded.dataset), loaded.medians, snapshotId, loaded.sourceSnapshotAt, executedAt,
    );
    const result = await publishServingDataset(target, { ...loaded.dataset, annualIndex }, snapshotId, { validateOnly });
    console.log(JSON.stringify({ status: validateOnly ? "validated" : "published", database: "real_data_for_all", ...result }, null, 2));
  } finally { await source.end(); await target.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
