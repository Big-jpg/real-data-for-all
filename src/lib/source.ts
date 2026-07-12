import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export const SOURCE_COLUMNS = ["sourceUrl","pageNumber","ordinalOnPage","price","priceValue","address","detailPath","detailUrl","bedrooms","bathrooms","carSpaces","landSize","landSizeSqm","propertyType","soldDate","soldDateISO","scrapedAt"] as const;
export type SourceRow = Record<(typeof SOURCE_COLUMNS)[number], string>;

export type RawObservation = {
  observationKey: string; recordHash: string; sourceRowNumber: number; values: SourceRow;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const clean = (value: unknown) => value == null || String(value).trim() === "" ? "" : String(value).trim();

export function parseSourceCsv(content: Buffer): RawObservation[] {
  const records = parse(content, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false, quote: '"', escape: '"' }) as Record<string,string>[];
  return records.map((record, index) => {
    const values = Object.fromEntries(SOURCE_COLUMNS.map((column) => [column, clean(record[column])])) as SourceRow;
    const missing = SOURCE_COLUMNS.filter((column) => !(column in record));
    if (missing.length) throw new Error(`Row ${index + 2} is missing columns: ${missing.join(", ")}`);
    const identity = (values.detailUrl || values.detailPath).toLowerCase();
    if (!identity) throw new Error(`Row ${index + 2} has no listing URL or path`);
    const recordHash = sha256(JSON.stringify(SOURCE_COLUMNS.map((column) => values[column] || null)));
    const observationKey = sha256(`${identity}||${values.scrapedAt || `NO_SCRAPE_TIMESTAMP:${recordHash}`}`);
    return { observationKey, recordHash, sourceRowNumber: index + 2, values };
  });
}

export function sourceFileHash(content: Buffer) { return sha256(content); }

export function normaliseAddress(value: string) {
  return value.normalize("NFKC").replace(/[.'’]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}

export function propertyFingerprint(address: string, postcode = "") {
  return sha256(`${normaliseAddress(address)}|WA|${postcode}`);
}
