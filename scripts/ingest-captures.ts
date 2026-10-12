import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCaptureInputs } from "./compare-captures";
import { database, registerFile, loadObservations, curateFile, refreshMarts } from "../src/lib/db";
import { parseSourceCsv, sourceFileHash } from "../src/lib/source";

export async function prepareCaptureIngestion(captureDirectory: string, baselineDirectory: string, additionalCaptureDirectories: readonly string[] = []) {
  const verified = await verifyCaptureInputs(captureDirectory, baselineDirectory, additionalCaptureDirectories);
  const files = verified.captures.flatMap(({ directory, manifest, manifestSha256 }) => manifest.slices
    .filter((slice) => slice.status === "complete" && (slice.csv?.rows ?? 0) > 0)
    .map((slice) => ({ runId: manifest.runId, directory, manifestSha256, slice: slice.name,
      file: slice.csv!.file, sha256: slice.csv!.sha256, bytes: slice.csv!.bytes, rows: slice.csv!.rows! })));
  return { schemaVersion: 1, preparedAt: new Date().toISOString(), captureRunIds: verified.captures.map((capture) => capture.manifest.runId),
    baselineManifestSha256: verified.baselineManifestSha256,
    skippedIncompleteScopes: verified.scopes.filter((scope) => scope.status !== "complete").length,
    skippedVerifiedEmptyScopes: verified.scopes.filter((scope) => scope.status === "complete" && scope.currentCapturedRows === 0).length,
    nonemptyFiles: files.length, sourceRows: files.reduce((sum, file) => sum + file.rows, 0), files };
}

async function main() {
  const args = process.argv.slice(2);
  const directories = { capture: "captures/perth-houses-2026-10-12", baseline: "captures/2026-07-baseline" };
  const additional: string[] = [];
  let apply = false, report: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--apply") { apply = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (key === "--capture" || key === "--baseline") directories[key.slice(2) as keyof typeof directories] = value;
    else if (key === "--additional-capture") additional.push(path.resolve(value));
    else if (key === "--report") report = value;
    else throw new Error(`Unsupported argument: ${key}`);
  }
  const plan = await prepareCaptureIngestion(path.resolve(directories.capture), path.resolve(directories.baseline), additional);
  if (report) await writeFile(path.resolve(report), JSON.stringify(plan, null, 2) + "\n");
  console.log(JSON.stringify({ ...plan, files: undefined, apply }, null, 2));
  if (!apply) return;
  const connection = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connection || !/^postgres(?:ql)?:\/\//.test(connection)) throw new Error("A usable production database connection is required");
  process.env.DATABASE_URL = connection;
  const sql = database(connection);
  try {
    const [migration] = await sql`SELECT 1 FROM ops.schema_migration WHERE version='005_current_observation.sql'`;
    if (!migration) throw new Error("Apply the current-observation migration before ingesting repeated captures");
  } finally { await sql.end(); }
  let insertedRows = 0, skippedCuratedFiles = 0;
  for (const [index, file] of plan.files.entries()) {
    const manifest = await readFile(path.join(file.directory, "manifest.json"));
    if (sourceFileHash(manifest) !== file.manifestSha256) throw new Error(`Capture manifest changed after verification: ${file.runId}`);
    const content = await readFile(path.join(file.directory, file.file));
    if (content.byteLength !== file.bytes || sourceFileHash(content) !== file.sha256) throw new Error(`Verified source changed: ${file.file}`);
    const rows = parseSourceCsv(content);
    if (rows.length !== file.rows) throw new Error(`Source row count changed: ${file.file}`);
    const registered = await registerFile(path.basename(file.file), null, file.sha256, content.byteLength);
    if (registered.status === "curated") { skippedCuratedFiles++; continue; }
    insertedRows += await loadObservations(registered.fileId, rows);
    await curateFile(registered.fileId);
    console.log(`[${index + 1}/${plan.files.length}] curated ${file.slice}: ${rows.length} rows`);
  }
  const rebuild = database(connection);
  try { await rebuild`CALL core.rebuild_current_sales()`; } finally { await rebuild.end(); }
  await refreshMarts();
  console.log(JSON.stringify({ completed: true, files: plan.files.length, insertedRows, skippedCuratedFiles }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Capture ingestion failed"); process.exitCode = 1; });
}
