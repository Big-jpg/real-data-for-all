import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This optional development runtime lives only in the ignored capture directory.
// npm install --prefix captures/_runtime/curation-test --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.8
const require = createRequire(path.resolve("captures/_runtime/curation-test/package.json"));
const { PGlite } = await import(pathToFileURL(require.resolve("@electric-sql/pglite")).href);
const { pgcrypto } = await import(pathToFileURL(require.resolve("@electric-sql/pglite/contrib/pgcrypto")).href);
const pg = new PGlite({ extensions: { pgcrypto } });
try {
  for (const migration of ["001_initial.sql", "002_transform.sql", "003_canonical_suburbs.sql", "004_house_scope.sql"]) {
    await pg.exec(await readFile(path.resolve("db", migration), "utf8"));
  }
  const fixture = await readFile(path.resolve("tests/sql/current-observation-regression.sql"), "utf8");
  const [before, after, unexpected] = fixture.split("-- APPLY_CURRENT_OBSERVATION_MIGRATION_HERE");
  if (!before || !after || unexpected) throw new Error("Regression fixture migration boundary is invalid");
  await pg.exec(before);
  await pg.exec(await readFile(path.resolve("db/005_current_observation.sql"), "utf8"));
  const parallelSafety = await readFile(path.resolve("db/006_parser_parallel_safety.sql"), "utf8");
  const freshSafety = await pg.query("SELECT count(*)::integer AS unsafe_parsers FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='core' AND p.proname IN ('source_listing_id','source_timestamp','source_date','source_integer','disclosed_price') AND p.proparallel='u'");
  if (freshSafety.rows[0].unsafe_parsers !== 5) throw new Error("Fresh parser definitions are not parallel unsafe");
  // Simulate the original 005 metadata, then test the corrective upgrade without invoking its functions.
  await pg.exec(parallelSafety.replaceAll("PARALLEL UNSAFE", "PARALLEL SAFE"));
  await pg.exec(parallelSafety);
  await pg.exec(after);
  const { rows } = await pg.query("SELECT count(*)::integer AS raw_rows FROM raw.sale_observation");
  if (rows[0].raw_rows !== 0) throw new Error("SQL regression did not roll back its fixtures");
  console.log(JSON.stringify({ status: "passed", engine: "PGlite in-memory PostgreSQL with pgcrypto", migrations: 6,
    assertions: (fixture.match(/SELECT pg_temp\.assert_true\(/g) ?? []).length,
    freshParallelMetadataVerified: true, upgradeParallelMetadataVerified: true,
    productionConnection: false, fixturesRolledBack: true }));
} finally {
  await pg.close();
}
