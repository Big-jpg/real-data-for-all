import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curateFile, database, loadObservations, refreshMarts, registerFile, type DatabaseClient } from "./db";
import { SOURCE_COLUMNS, type RawObservation, type SourceRow } from "./source";

const mock = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("postgres", () => ({ default: mock.factory }));

function fixtureClient(failPrefix?: string) {
  const statements: string[] = [];
  const batches: Record<string, unknown>[][] = [];
  const query = (input: TemplateStringsArray | Record<string, unknown>[]): unknown => {
    if (!Object.hasOwn(input, "raw")) {
      batches.push(input as Record<string, unknown>[]);
      return { rows: input };
    }
    const statement = (input as TemplateStringsArray).join("?").trim();
    statements.push(statement);
    if (failPrefix && statement.startsWith(failPrefix)) return Promise.reject(new Error("Fixture query failed"));
    if (statement.startsWith("INSERT INTO ops.ingest_file")) return Promise.resolve([{ file_id: "fixture-file", status: "loaded" }]);
    if (statement.startsWith("SELECT count")) return Promise.resolve([{ count: 1 }]);
    return Promise.resolve([]);
  };
  const end = vi.fn(async () => {});
  return { client: Object.assign(query, { end }) as unknown as DatabaseClient, statements, batches, end };
}

function observation(): RawObservation {
  const values = Object.fromEntries(SOURCE_COLUMNS.map((column) => [column, ""])) as SourceRow;
  Object.assign(values, { address: "43 Majorca Elbow, Hocking", carSpaces: "0", detailPath: "/sold/property-house-wa-hocking-152180832" });
  return { observationKey: "a".repeat(64), recordHash: "b".repeat(64), sourceRowNumber: 2, values };
}

beforeEach(() => {
  mock.factory.mockReset();
  vi.stubEnv("DATABASE_URL", "postgres://fixture@localhost/fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("database client ownership", () => {
  it("reuses one caller-owned client through registration, loading, curation and mart refresh", async () => {
    const fixture = fixtureClient();
    mock.factory.mockReturnValue(fixture.client);
    const shared = database();
    expect(await registerFile("capture.csv", null, "c".repeat(64), 1, shared)).toEqual({ fileId: "fixture-file", status: "loaded" });
    expect(await loadObservations("fixture-file", [observation()], shared)).toBe(1);
    await curateFile("fixture-file", shared);
    await refreshMarts(shared);
    expect(mock.factory).toHaveBeenCalledTimes(1);
    expect(fixture.end).not.toHaveBeenCalled();
    expect(fixture.batches[0][0]).toMatchObject({ file_id: "fixture-file", car_spaces_source: "0" });
    expect(fixture.statements.filter((statement) => statement.startsWith("REFRESH MATERIALIZED VIEW"))).toHaveLength(2);
    await shared.end();
    expect(fixture.end).toHaveBeenCalledTimes(1);
  });

  it("retains independent client ownership for existing callers that do not supply a client", async () => {
    const fixtures = Array.from({ length: 4 }, () => fixtureClient());
    for (const fixture of fixtures) mock.factory.mockReturnValueOnce(fixture.client);
    await registerFile("capture.csv", null, "c".repeat(64), 1);
    await loadObservations("fixture-file", [observation()]);
    await curateFile("fixture-file");
    await refreshMarts();
    expect(mock.factory).toHaveBeenCalledTimes(4);
    for (const fixture of fixtures) expect(fixture.end).toHaveBeenCalledTimes(1);
  });

  it("reports failed loading without closing a caller-owned client", async () => {
    const fixture = fixtureClient("INSERT INTO raw.sale_observation");
    await expect(loadObservations("fixture-file", [observation()], fixture.client)).rejects.toThrow("Fixture query failed");
    expect(fixture.statements.some((statement) => statement.includes("status='failed'"))).toBe(true);
    expect(fixture.end).not.toHaveBeenCalled();
    expect(mock.factory).not.toHaveBeenCalled();
  });

  it("still closes a helper-owned client after a curation failure", async () => {
    const fixture = fixtureClient("CALL core.curate_file");
    mock.factory.mockReturnValue(fixture.client);
    await expect(curateFile("fixture-file")).rejects.toThrow("Fixture query failed");
    expect(fixture.end).toHaveBeenCalledTimes(1);
  });
});
