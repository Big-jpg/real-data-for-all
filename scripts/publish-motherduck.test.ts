import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { assertHistoricalRangePreserved, publicationNames, publishServingDataset, requiredMotherDuckToken, rollbackStatements, sourceDatabaseUrl, validateServingDataset, type ServingDataset } from "./publish-motherduck";

function dataset(): ServingDataset {
  return { dimensions: [{ suburb_key: "hocking", suburb: "Hocking", canonical_postcode: "6065", observed_postcodes: "6065", sale_count: "2", postcode_confidence: "1.0000" }],
    monthly: [{ suburb_key: "hocking", suburb: "Hocking", postcode: "6065", sale_month: "2001-01-01", sale_count: "1" },
      { suburb_key: "hocking", suburb: "Hocking", postcode: "6065", sale_month: "2026-09-01", sale_count: "1" }],
    facts: [{ suburb_key: "hocking", sold_date: "2001-01-12", property_type: "House" },
      { suburb_key: "hocking", sold_date: "2026-09-12", property_type: "House" }] };
}

function transactionTarget(failRenameNumber?: number, stagedCountMismatch = false) {
  const old = dataset();
  old.monthly.pop(); old.facts.pop(); old.dimensions[0].sale_count = "1";
  let stored = new Map<string, Record<string, unknown>[]>(publicationNames("fixture1").map((table, index) => [table.live, structuredClone([old.dimensions, old.monthly, old.facts][index])]));
  const original = structuredClone(stored);
  let commits = 0, rollbacks = 0, renames = 0;
  const target = { begin: async (callback: (sql: postgres.TransactionSql) => Promise<unknown>) => {
    const pending = structuredClone(stored);
    const query = (input: TemplateStringsArray | string | Record<string, unknown>[], ...parameters: unknown[]): unknown => {
      if (typeof input === "string") return input;
      if (Array.isArray(input) && !Object.hasOwn(input, "raw")) return input;
      const fragments = input as TemplateStringsArray;
      const statement = fragments.reduce((text, fragment, index) => text + fragment + (parameters[index] ?? ""), "").trim();
      if (statement.includes("information_schema.tables")) return Promise.resolve([...pending.keys()].map((table_name) => ({ table_name })));
      if (statement.startsWith("CREATE TABLE")) { pending.set(parameters[0] as string, []); return Promise.resolve([]); }
      if (statement.startsWith("INSERT INTO")) { pending.get(parameters[0] as string)!.push(...parameters[1] as Record<string, unknown>[]); return Promise.resolve([]); }
      if (statement.startsWith("SELECT count")) {
        const name = parameters[0] as string, rows = pending.get(name)!;
        if (statement.includes("min(sold_date)")) { const dates = rows.map((row) => String(row.sold_date)).sort(); return Promise.resolve([{ count: rows.length, sold_date_from: dates[0], sold_date_to: dates.at(-1) }]); }
        return Promise.resolve([{ count: rows.length + (stagedCountMismatch && name.includes("_next_") ? 1 : 0) }]);
      }
      if (statement.startsWith("ALTER TABLE")) {
        if (++renames === failRenameNumber) throw new Error("Injected rename failure");
        if (pending.has(parameters[1] as string)) throw new Error("Snapshot name collision");
        pending.set(parameters[1] as string, pending.get(parameters[0] as string)!); pending.delete(parameters[0] as string); return Promise.resolve([]);
      }
      throw new Error(`Unexpected mutation outside publication contract: ${statement}`);
    };
    query.unsafe = (text: string) => text;
    try { const result = await callback(query as unknown as postgres.TransactionSql); stored = pending; commits++; return result; }
    catch (error) { rollbacks++; throw error; }
  } } as unknown as postgres.Sql;
  return { target, inspect: () => ({ stored, original, commits, rollbacks, renames }) };
}

describe("recoverable canonical serving publication", () => {
  it("uses a valid read connection or direct connection and skips redacted credentials without logging them", () => {
    const direct = "postgresql://fixture:direct-password@direct.example.test/estate";
    const read = "postgresql://fixture:read-password@read.example.test/estate";
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "[SENSITIVE]", DATABASE_URL_UNPOOLED: direct, DATABASE_URL: "[SENSITIVE]" })).toBe(direct);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: read, DATABASE_URL_UNPOOLED: direct })).toBe(read);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "not a connection", DATABASE_URL: direct })).toBe(direct);
    expect(sourceDatabaseUrl({ DATABASE_READ_URL: "postgresql://fixture:%5BSENSITIVE%5D@read.example.test/estate", DATABASE_URL_UNPOOLED: direct })).toBe(direct);
    expect(() => sourceDatabaseUrl({ DATABASE_URL: "postgresql://fixture:private-value@" })).toThrow("A usable DATABASE_READ_URL");
    expect(() => requiredMotherDuckToken("[SENSITIVE]")).toThrow("usable MOTHERDUCK_TOKEN");
    expect(requiredMotherDuckToken(" fixture-token ")).toBe("fixture-token");
  });

  it("accepts full canonical history and rejects stale marts, missing months and non-House facts", () => {
    expect(validateServingDataset(dataset())).toEqual({ dimensions: 1, monthly: 2, facts: 2, soldDateFrom: "2001-01-12", soldDateTo: "2026-09-12" });
    const stale = dataset(); stale.monthly[1].sale_count = "3";
    expect(() => validateServingDataset(stale)).toThrow("Monthly mart does not reconcile");
    const missingMonth = dataset(); missingMonth.monthly.pop();
    expect(() => validateServingDataset(missingMonth)).toThrow("missing sale-fact months");
    const nonHouse = dataset(); nonHouse.facts[1].property_type = "Other";
    expect(() => validateServingDataset(nonHouse)).toThrow("canonical House scope");
  });

  it("blocks replacement by a six-month-only export even when its own marts reconcile", () => {
    const complete = validateServingDataset(dataset());
    const truncated = dataset(); truncated.facts.shift(); truncated.monthly.shift(); truncated.dimensions[0].sale_count = "1";
    expect(() => assertHistoricalRangePreserved(validateServingDataset(truncated), complete)).toThrow("truncated replacement");
  });

  it("preserves all old tables under one snapshot and commits a consistent new generation", async () => {
    const fixture = transactionTarget();
    const report = await publishServingDataset(fixture.target, dataset(), "fixture1");
    expect(report.source.facts).toBe(2);
    expect(report.previous.facts).toBe(1);
    const state = fixture.inspect();
    for (const names of publicationNames("fixture1")) {
      expect(state.stored.get(names.previous)).toEqual(state.original.get(names.live));
      expect(state.stored.has(names.staged)).toBe(false);
    }
    expect(state.stored.get("suburb_sale_facts")).toHaveLength(2);
    expect(state.commits).toBe(1);
    expect(state.rollbacks).toBe(0);
  });

  it("keeps the old generation when staged verification fails or a rename fails halfway", async () => {
    for (const fixture of [transactionTarget(undefined, true), transactionTarget(2)]) {
      await expect(publishServingDataset(fixture.target, dataset(), "fixture1")).rejects.toThrow();
      const state = fixture.inspect();
      expect(state.stored).toEqual(state.original);
      expect(state.commits).toBe(0);
      expect(state.rollbacks).toBe(1);
    }
  });

  it("rejects unsafe snapshot names and produces rollback SQL retaining the displaced generation", () => {
    expect(() => publicationNames("bad; DROP TABLE suburb_sale_facts")).toThrow("Snapshot ID");
    const statements = rollbackStatements("fixture1", "rollback1");
    expect(statements[0]).toBe("BEGIN TRANSACTION;");
    expect(statements).toContain("ALTER TABLE suburb_sale_facts RENAME TO suburb_sale_facts_previous_rollback1;");
    expect(statements).toContain("ALTER TABLE suburb_sale_facts_previous_fixture1 RENAME TO suburb_sale_facts;");
    expect(statements.at(-1)).toBe("COMMIT;");
    expect(statements.some((statement) => statement.includes("DROP"))).toBe(false);
    const generatedId = `${new Date("2026-10-12T08:12:34.123Z").toISOString().replace(/[-:.]/g, "").toLowerCase()}_a1b2c3d4`;
    expect(generatedId).toHaveLength(28);
    expect(publicationNames(generatedId).every((name) => name.previous.length < 63 && name.staged.length < 63)).toBe(true);
  });
});
