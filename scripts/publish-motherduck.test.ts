import { createHash } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  assertHistoricalRangePreserved, publicationNames, publishServingDataset, requiredMotherDuckToken,
  rollbackStatements, sourceDatabaseUrl, validateServingDataset, type ServingDataset,
} from "./publish-motherduck";

const propertyKey = "a".repeat(64);
const pairKey = "b".repeat(64);

function dataset(): ServingDataset {
  const annualIndex = ["annual_median_price", "repeat_sales_huber", "repeat_sales_ols_return_band", "repeat_sales_ols_untrimmed"]
    .flatMap((series_key) => Array.from({ length: 17 }, (_, offset) => ({
      model_version: "annual-repeat-sales-v1",
      source_snapshot_id: "fixture_snapshot",
      source_snapshot_at: "2026-01-01T00:00:00Z",
      executed_at: "2026-01-01T00:00:01Z",
      reference_year: 2020,
      reporting_window_start: 2009,
      reporting_window_end: 2025,
      series_key,
      series_label: series_key,
      observation_year: 2009 + offset,
      index_level: 100,
      index_lower_95: series_key === "annual_median_price" ? null : 99,
      index_upper_95: series_key === "annual_median_price" ? null : 101,
      annual_change_pct: 0,
      annual_change_lower_95_pct: series_key === "annual_median_price" ? null : -1,
      annual_change_upper_95_pct: series_key === "annual_median_price" ? null : 1,
      pair_count: series_key === "annual_median_price" ? null : 36,
      identifying_pair_count: series_key === "annual_median_price" ? null : 36,
      same_year_diagnostic_pair_count: series_key === "annual_median_price" ? null : 0,
      contributing_property_count: series_key === "annual_median_price" ? null : 12,
      year_identifying_pair_count: series_key === "annual_median_price" ? null : 24,
      year_contributing_property_count: series_key === "annual_median_price" ? null : 12,
      sale_count: series_key === "annual_median_price" ? 100 : null,
      eligibility_criteria: "fixture eligibility",
    })));
  return {
    dimensions: [{ suburb_key: "hocking", suburb: "Hocking", canonical_postcode: "6065", observed_postcodes: "6065", sale_count: "2", postcode_confidence: "1.0000" }],
    monthly: [
      { suburb_key: "hocking", suburb: "Hocking", postcode: "6065", sale_month: "2001-01-01", sale_count: "1" },
      { suburb_key: "hocking", suburb: "Hocking", postcode: "6065", sale_month: "2026-09-01", sale_count: "1" },
    ],
    facts: [
      { property_key: propertyKey, suburb_key: "hocking", sold_date: "2001-01-12", price_aud: 100000, property_type: "House" },
      { property_key: propertyKey, suburb_key: "hocking", sold_date: "2026-09-12", price_aud: 200000, property_type: "House" },
    ],
    pairs: [{
      pair_key: pairKey, property_key: propertyKey, earlier_suburb_key: "hocking", later_suburb_key: "hocking",
      earlier_sold_date: "2001-01-12", later_sold_date: "2026-09-12", earlier_price_aud: 100000, later_price_aud: 200000,
    }],
    annualIndex,
  };
}

function checksum(rows: Record<string, unknown>[], eligible = false) {
  const keys = rows.filter((row) => !eligible || (Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
      && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000))
    .map((row) => String(row.pair_key)).sort();
  return keys.length ? createHash("sha256").update(keys.join("\n")).digest("hex") : null;
}

function pairAnalysis(rows: Record<string, unknown>[]) {
  const pairs = rows.map((row) => {
    const holdingDays = (Date.parse(String(row.later_sold_date)) - Date.parse(String(row.earlier_sold_date))) / 86400000;
    const validPrices = Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
      && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000;
    const returnEligible = validPrices && holdingDays > 0 && Number(row.earlier_price_aud) > 0 && Number(row.later_price_aud) > 0;
    const annualizedReturn = returnEligible
      ? (Math.exp(Math.log(Number(row.later_price_aud) / Number(row.earlier_price_aud)) * 365.25 / holdingDays) - 1) * 100
      : null;
    return { holdingDays, validPrices, returnEligible, plausible: annualizedReturn !== null && annualizedReturn >= -50 && annualizedReturn <= 100 };
  });
  const eligibleAt = (days: number) => pairs.filter((pair) => pair.validPrices && pair.holdingDays >= days).length;
  const plausibleAt = (days: number) => pairs.filter((pair) => pair.validPrices && pair.holdingDays >= days && pair.plausible).length;
  const excludedBefore = (days: number) => pairs.filter((pair) => pair.validPrices && pair.holdingDays > 0 && pair.holdingDays < days).length;
  return {
    positive_hold_valid_count: pairs.filter((pair) => pair.returnEligible).length,
    plausible_return_count: pairs.filter((pair) => pair.returnEligible && pair.plausible).length,
    eligible_90_day_count: eligibleAt(90), eligible_180_day_count: eligibleAt(180), eligible_365_day_count: eligibleAt(365),
    plausible_90_day_count: plausibleAt(90), plausible_180_day_count: plausibleAt(180), plausible_365_day_count: plausibleAt(365),
    short_hold_excluded_90_count: excludedBefore(90), short_hold_excluded_180_count: excludedBefore(180),
    short_hold_excluded_365_count: excludedBefore(365),
  };
}

function transactionTarget(options: { failLiveViewOn?: number } = {}) {
  const old = dataset();
  old.monthly.pop();
  old.facts.pop();
  old.dimensions[0].sale_count = "1";
  old.pairs = [];
  const initialNames = publicationNames("fixture1");
  let stored = new Map<string, Record<string, unknown>[]>(initialNames.slice(0, 3).map((table, index) =>
    [table.live, structuredClone([old.dimensions, old.monthly, old.facts][index])]));
  const original = structuredClone(stored);
  let views = new Map<string, string>();
  let commits = 0, rollbacks = 0, liveViewCreates = 0;

  const target = {
    begin: async (callback: (sql: postgres.TransactionSql) => Promise<unknown>) => {
      const pending = structuredClone(stored), pendingViews = structuredClone(views);
      const query = (input: TemplateStringsArray | string | Record<string, unknown>[], ...parameters: unknown[]): unknown => {
        if (typeof input === "string") {
          if (parameters.length === 0) return input;
          const statement = input.trim();
          if (statement.startsWith("CREATE VIEW ")) {
            const [, name, source] = /^CREATE VIEW ([a-z0-9_]+) AS[\s\S]*?\bFROM ([a-z0-9_]+)/i.exec(statement) ?? [];
            if (!name || !source || !pending.has(source)) throw new Error("Invalid view source in publication fixture");
            if (name === "repeat_sale_pairs") {
              liveViewCreates++;
              if (liveViewCreates === options.failLiveViewOn) throw new Error("Injected failure during pair-view promotion");
            }
            pendingViews.set(name, statement);
            return Promise.resolve([]);
          }
          if (statement.startsWith("SELECT count") && statement.includes("FROM repeat_sale_pairs")) {
            const viewName = /FROM ([a-z0-9_]+)$/.exec(statement)?.[1];
            const source = viewName && /\bFROM ([a-z0-9_]+)/i.exec(pendingViews.get(viewName) ?? "")?.[1];
            const rows = source && pending.get(source);
            if (!rows) throw new Error("Invalid repeat-sale view in publication fixture");
            const valid = rows.filter((row) => Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
              && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000);
            return Promise.resolve([{
              pair_count: rows.length, unique_pair_count: new Set(rows.map((row) => row.pair_key)).size,
              all_identity_checksum: checksum(rows), valid_price_pair_count: valid.length, valid_identity_checksum: checksum(rows, true), invalid_rows: 0,
              ...pairAnalysis(rows),
            }]);
          }
          if (statement.startsWith("DROP VIEW ")) { pendingViews.delete(statement.replace(/^DROP VIEW IF EXISTS |^DROP VIEW /i, "").replace(/;$/, "")); return Promise.resolve([]); }
          throw new Error(`Unexpected raw query: ${statement}`);
        }
        if (Array.isArray(input) && !Object.hasOwn(input, "raw")) return input;
        const fragments = input as TemplateStringsArray;
        const statement = fragments.reduce((text, fragment, index) => text + fragment + (parameters[index] ?? ""), "").trim();
        if (statement.includes("information_schema.tables")) return Promise.resolve([...pending.keys()].map((table_name) => ({ table_name })));
        if (statement.includes("information_schema.views")) {
          const definition = pendingViews.get("repeat_sale_pairs");
          return Promise.resolve(definition ? [{ view_definition: definition.replace(/^CREATE VIEW repeat_sale_pairs AS\s*/i, "") }] : []);
        }
        if (statement.startsWith("SELECT * FROM")) {
          const name = /SELECT \* FROM ([a-z0-9_]+)/i.exec(statement)?.[1];
          const rows = name && pending.get(name);
          if (!rows) throw new Error("Unknown staged table in publication fixture");
          return Promise.resolve([...rows].sort((left, right) => String(left.series_key).localeCompare(String(right.series_key))
            || Number(left.observation_year) - Number(right.observation_year)));
        }
        if (statement.startsWith("CREATE TABLE")) { pending.set(parameters[0] as string, []); return Promise.resolve([]); }
        if (statement.startsWith("INSERT INTO")) { pending.get(parameters[0] as string)!.push(...parameters[1] as Record<string, unknown>[]); return Promise.resolve([]); }
        if (statement.startsWith("DROP TABLE")) { pending.delete(parameters[0] as string); return Promise.resolve([]); }
        if (statement.startsWith("SELECT count") && statement.includes("FROM repeat_sale_pairs")) {
          const viewName = /FROM ([a-z0-9_]+)$/.exec(statement)?.[1];
          const source = viewName && /\bFROM ([a-z0-9_]+)\s*;?$/.exec(pendingViews.get(viewName) ?? "")?.[1];
          const rows = source && pending.get(source);
          if (!rows) throw new Error("Invalid repeat-sale view in publication fixture");
          const valid = rows.filter((row) => Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
            && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000);
          return Promise.resolve([{
            pair_count: rows.length, unique_pair_count: new Set(rows.map((row) => row.pair_key)).size,
            all_identity_checksum: checksum(rows), valid_price_pair_count: valid.length, valid_identity_checksum: checksum(rows, true), invalid_rows: 0,
            ...pairAnalysis(rows),
          }]);
        }
        if (statement.startsWith("SELECT count")) {
          const name = parameters[0] as string, rows = pending.get(name)!;
          if (statement.includes("min(sold_date)")) {
            const dates = rows.map((row) => String(row.sold_date)).sort();
            return Promise.resolve([{ count: rows.length, sold_date_from: dates[0], sold_date_to: dates.at(-1) }]);
          }
          if (statement.includes("valid_price_pairs")) {
            const valid = rows.filter((row) => Number(row.earlier_price_aud) >= 50000 && Number(row.earlier_price_aud) <= 20000000
              && Number(row.later_price_aud) >= 50000 && Number(row.later_price_aud) <= 20000000);
            return Promise.resolve([{ count: rows.length, valid_price_pairs: valid.length,
              same_day_valid_pairs: valid.filter((row) => row.earlier_sold_date === row.later_sold_date).length }]);
          }
          return Promise.resolve([{ count: rows.length }]);
        }
        if (statement.startsWith("ALTER TABLE")) {
          const source = parameters[0] as string, destination = parameters[1] as string;
          if (!pending.has(source) || pending.has(destination)) throw new Error("Invalid table rename in publication fixture");
          pending.set(destination, pending.get(source)!); pending.delete(source); return Promise.resolve([]);
        }
        throw new Error(`Unexpected mutation outside publication contract: ${statement}`);
      };
      const sqlClient = Object.assign(query, {
        unsafe: (text: string) => /^(?:CREATE VIEW|DROP VIEW|SELECT)\b/i.test(text.trim()) ? query(text, true) : text,
      });
      try {
        const result = await callback(sqlClient as unknown as postgres.TransactionSql);
        stored = pending;
        views = pendingViews;
        commits++;
        return result;
      } catch (error) {
        rollbacks++;
        throw error;
      }
    },
  } as unknown as postgres.Sql;
  return { target, inspect: () => ({ stored, original, views, commits, rollbacks }) };
}

describe("recoverable repeat-sale publication", () => {
  it("uses a valid read connection or direct connection and skips redacted credentials without logging them", () => {
    const direct = "postgresql://user:pass@direct.example.test/estate";
    const read = "postgresql://user:pass@read.example.test/estate";
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "[SENSITIVE]", DATABASE_URL_UNPOOLED: direct, DATABASE_URL: "[SENSITIVE]" })).toBe(direct);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: read, DATABASE_URL_UNPOOLED: direct })).toBe(read);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "not a connection", DATABASE_URL: direct })).toBe(direct);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "postgresql://user:[SENSITIVE]@read.example.test/estate", DATABASE_URL_UNPOOLED: direct })).toBe(direct);
    expect(() => sourceDatabaseUrl({ DATABASE_URL: "******" })).toThrow("A usable DATABASE_READ_URL");
    expect(() => requiredMotherDuckToken("[SENSITIVE]")).toThrow("usable MOTHERDUCK_TOKEN");
    expect(requiredMotherDuckToken(" fixture-token ")).toBe("fixture-token");
  });

  it("validates property keys, pair identities, dates, and serving-mart reconciliation", () => {
    expect(validateServingDataset(dataset())).toEqual({
      dimensions: 1, monthly: 2, facts: 2, pairs: 1, validPricePairs: 1, sameDayValidPairs: 0,
      annualIndexRows: 68, soldDateFrom: "2001-01-12", soldDateTo: "2026-09-12",
    });
    const missingPropertyKey = dataset(); missingPropertyKey.facts[1].property_key = null;
    expect(() => validateServingDataset(missingPropertyKey)).toThrow("Invalid pseudonymous property key");
    const duplicatePair = dataset(); duplicatePair.pairs.push({ ...duplicatePair.pairs[0] });
    expect(() => validateServingDataset(duplicatePair)).toThrow("duplicated repeat-sale pair key");
    const missingMonth = dataset(); missingMonth.monthly.pop();
    expect(() => validateServingDataset(missingMonth)).toThrow("missing sale-fact months");
    const nonHouse = dataset(); nonHouse.facts[1].property_type = "Other";
    expect(() => validateServingDataset(nonHouse)).toThrow("canonical House scope");
  });

  it("blocks replacement by a truncated history", () => {
    const complete = validateServingDataset(dataset());
    const truncated = dataset(); truncated.facts.shift(); truncated.monthly.shift(); truncated.dimensions[0].sale_count = "1";
    expect(() => assertHistoricalRangePreserved(validateServingDataset(truncated), complete)).toThrow("truncated replacement");
  });

  it("publishes staged pair data only after exact pair-identity checks and preserves the prior snapshot", async () => {
    const fixture = transactionTarget();
    const report = await publishServingDataset(fixture.target, dataset(), "fixture1");
    expect(report.source.validPricePairs).toBe(1);
    expect(report.pairAnalysis?.plausibleAnnualizedReturns).toBe(1);
    expect(report.pairAnalysis?.eligibleAt90Days).toBe(1);
    expect(report.pairAnalysis?.eligibleAt180Days).toBe(1);
    expect(report.pairAnalysis?.eligibleAt365Days).toBe(1);
    expect(report.previous?.facts).toBe(1);
    const state = fixture.inspect();
    for (const names of publicationNames("fixture1").slice(0, 3)) {
      expect(state.stored.get(names.previous)).toEqual(state.original.get(names.live));
    }
    expect(state.stored.get("suburb_sale_facts")).toHaveLength(2);
    expect(state.stored.get("repeat_sale_pair_data")).toHaveLength(1);
    expect(state.views.get("repeat_sale_pairs")).toContain("FROM repeat_sale_pair_data");
    expect(state.commits).toBe(1);
    expect(state.rollbacks).toBe(0);
  });

  it("supports repeat publication and preserves the previous view definition in rollback SQL", async () => {
    const fixture = transactionTarget();
    await publishServingDataset(fixture.target, dataset(), "fixture1");
    const firstView = fixture.inspect().views.get("repeat_sale_pairs");
    const second = await publishServingDataset(fixture.target, dataset(), "fixture2");
    expect(second.snapshotTables).toHaveLength(5);
    expect(second.rollbackSql).toContain("DROP VIEW IF EXISTS repeat_sale_pairs;");
    const restoredView = second.rollbackSql?.find((statement) => statement.startsWith("CREATE VIEW repeat_sale_pairs AS"));
    expect(restoredView?.replace(/\s+/g, " ")).toBe(`${firstView};`.replace(/\s+/g, " "));
    expect(fixture.inspect().views.get("repeat_sale_pairs")).toContain("FROM repeat_sale_pair_data");
    expect(fixture.inspect().stored.get("repeat_sale_pair_data_previous_fixture2")).toHaveLength(1);
  });

  it("rolls back all promoted tables and restores the exact prior view after an injected promotion failure", async () => {
    const failing = transactionTarget({ failLiveViewOn: 2 });
    await publishServingDataset(failing.target, dataset(), "fixture1");
    const before = structuredClone(failing.inspect());
    await expect(publishServingDataset(failing.target, dataset(), "fixture2")).rejects.toThrow("Injected failure during pair-view promotion");
    expect(failing.inspect().stored).toEqual(before.stored);
    expect(failing.inspect().views).toEqual(before.views);
    expect(failing.inspect().rollbacks).toBe(1);
  });

  it("validates staged data and removes scratch objects without promoting", async () => {
    const fixture = transactionTarget();
    const before = structuredClone(fixture.inspect());
    const report = await publishServingDataset(fixture.target, dataset(), "validate1", { validateOnly: true });
    expect(report.status).toBe("validated");
    expect(fixture.inspect().stored).toEqual(before.stored);
    expect(fixture.inspect().views).toEqual(before.views);
    expect(fixture.inspect().commits).toBe(1);
    expect(fixture.inspect().rollbacks).toBe(0);
  });

  it("produces rollback SQL that restores a captured view and only restores tables present in the snapshot", () => {
    expect(() => publicationNames("bad; DROP TABLE suburb_sale_facts")).toThrow("Snapshot ID");
    const viewDefinition = "CREATE VIEW repeat_sale_pairs AS SELECT * FROM repeat_sale_pair_data;";
    const statements = rollbackStatements("fixture1", "rollback1", viewDefinition, publicationNames("fixture1").slice(0, 3).map((table) => table.previous));
    expect(statements[0]).toBe("BEGIN TRANSACTION;");
    expect(statements).toContain("ALTER TABLE suburb_sale_facts RENAME TO suburb_sale_facts_previous_rollback1;");
    expect(statements).not.toContain("ALTER TABLE repeat_sale_pair_data_previous_fixture1 RENAME TO repeat_sale_pair_data;");
    expect(statements).toContain(viewDefinition);
    expect(statements.at(-1)).toBe("COMMIT;");
    expect(statements.some((statement) => statement.includes("DROP TABLE"))).toBe(false);
  });
});
