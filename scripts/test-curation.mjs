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
  await pg.exec(after);
  const { rows } = await pg.query("SELECT count(*)::integer AS raw_rows FROM raw.sale_observation");
  if (rows[0].raw_rows !== 0) throw new Error("SQL regression did not roll back its fixtures");
  console.log(JSON.stringify({ status: "passed", engine: "PGlite in-memory PostgreSQL with pgcrypto", migrations: 5,
    assertions: (fixture.match(/SELECT pg_temp\.assert_true\(/g) ?? []).length,
    productionConnection: false, fixturesRolledBack: true }));
} finally {
  await pg.close();
}
