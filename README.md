# Perth House Data

[Perth House Data](https://perthhousedata.com) is a free, public explorer for three decades of detached-house sales across Perth postcodes 6000–6200.

The project turns an immutable archive of sold-listing observations into a traceable analytical dataset. Visitors can explore suburb history, rolling price medians, sales volume, bedroom segments, and land-to-price relationships, then export the underlying results or create a styled snapshot.

## Analytical scope

- Detached houses only
- Perth postcodes 6000–6200
- Units, apartments, acreage, duplexes, and semi-detached properties excluded
- Unpriced sales retained for volume measures but excluded from price statistics
- Descriptive historical analysis—not a property valuation service

The July 2026 published baseline contained 347,887 source observations across 296,422 listings and approximately 330 house-sale suburbs. Each subsequent capture retains its own inventory and comparison. Source and analytical counts are reconciled explicitly; unexplained differences are treated as data-quality issues rather than silently discarded.

## How it works

```text
Immutable CSV archive
        ↓
Private Vercel Blob + Vercel Workflow
        ↓
Neon Postgres raw, canonical, and sale-event records
        ↓
MotherDuck analytical marts
        ↓
Next.js APIs and the public explorer
```

1. Each source CSV is registered by SHA-256 before ingestion.
2. Raw listing observations are loaded idempotently and retain their source lineage.
3. The canonical layer normalises addresses, resolves repeated listings, and preserves sale events separately from listing identity.
4. Suburbs receive stable analytical keys independent of display postcode.
5. Monthly medians and related statistics are calculated from individual sales—not averages of pre-aggregated values.
6. MotherDuck serves the public analytical queries used by the Next.js application.

The current property identity is a SHA-256 fingerprint of normalised address, state, and postcode. It is deliberately replaceable if authoritative parcel or title identifiers become available later.

## Public explorer

The production application provides:

- Suburb and postcode discovery
- Monthly sale counts and price distributions
- Rolling annual medians and year-over-year comparisons
- Sales-velocity measures based on completed sales
- Bedroom-segment and land-size analysis with visible sample sizes
- CSV export
- Downloadable and clipboard-ready visual snapshots
- Perth Warm, Microsoft Corporate, Excel Analysis, and PowerPoint Sales snapshot styles

Sales velocity means completed detached-house sales per month over the latest rolling 12 months. It is not an inventory-turnover or days-on-market measure.

## Technology

- Next.js 16 and React 19
- Vercel Functions, Workflow, Blob, Analytics, and Speed Insights
- Neon Postgres as the canonical system of record
- MotherDuck as the analytical serving layer
- TypeScript, Zod, Vitest, and ESLint
- A Chrome response collector for current captures; the earlier extension remains in `rea-sold-scraper`

## Local setup

Requirements:

- Node.js 22
- pnpm 10.28
- Neon/Postgres and MotherDuck credentials

```bash
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm test
pnpm typecheck
pnpm lint
pnpm ingest:local -- --limit=1
pnpm db:status
```

After validating a bounded ingestion, load and publish the complete archive:

```bash
pnpm ingest:local
pnpm db:reconcile
pnpm publish:motherduck
pnpm smoke:motherduck
```

Standalone database scripts load `.env.local` explicitly. Never commit populated environment files.

## Dated Chrome captures

The current collector reads the structured sold-listing responses used by a normal Chrome session. It supports the initial page's JSON cache and the matching `soldSearchByQuery` GraphQL response used for subsequent pages. It does not scrape listing cards or replay session cookies and challenge headers through curl.

- `scripts/chrome-listing-collector.mjs` controls navigation, response selection and durable checkpoints.
- `src/lib/rea-listing-capture.ts` validates resolved locality, listing fields, dates, pagination and completeness, then writes the existing 17-column CSV contract.
- `scripts/compare-captures.ts` compares validated dated captures with the preserved July baseline.

Generate the static browser-tool bootstrap with `node scripts/build-chrome-collector.mjs` (or `pnpm capture:build`). It writes `captures/_runtime/chrome-collector-bootstrap.js`. The bootstrap runs in the approved CUA JavaScript session with `captureFiles`, `capturePath` and `collectorCrypto` bound to the native Node modules, and a Chrome tab plus its documented `cdp` capability. Paste it as ordinary tool code; it requires no file-module imports or runtime code generation. This is an operator-controlled browser capture, not a standalone headless CLI.

Create the collector with `createChromeCollector({ tab, cdp, core: collectorCore, planPath, outputDirectory })`, then call `runBatch()` in bounded batches. The plan must specify WA, House, exact suburb/postcode and a six-month sold window. Each validated page is committed with a SHA-256 before the manifest advances. Recreating the collector with the same plan and directory verifies the saved pages and resumes from the first uncommitted page. A completed slice has all pages and a unique listing count matching the response total. Failed, incomplete, capped and unresolved scopes remain explicit.

The default run uses one tab, at least five seconds between navigations and a 100-page limit per suburb. A source verification or rate-limit response stops the run. Resume only after normal browser access is restored; use `retryExceptions([sliceName])` for the interrupted slice. A restart after the terminal page checkpoint finalizes that slice without requesting another page.

Allow the browser tool more time than the batch budget: `runBatch({ maxMs: 50000 })` pairs with a CUA tool timeout of at least 65 seconds. The collector starts another page only when 35 seconds remain, plus any pending navigation delay; otherwise it returns with the checkpoint intact. After a browser-control interruption, if the page contains structured listing data but matching CDP events are missing, re-arm capture on the dedicated tab with `await cdp.send("Network.disable")` followed by `await cdp.send("Network.enable")`, then recreate the collector from its saved plan and checkpoint before retrying the affected scopes.

Captures live in separate, ignored directories under `captures/`. `2026-07-baseline/` contains byte-identical copies of all 358 July source files plus their integrity inventory. `perth-houses-2026-10-12/` contains the new plan, manifest, safe listing projections and CSVs. `perth-houses-2026-10-12-supplement/` adds 43 exact queries absent from the July filename inventory, using the public [Main Roads WA suburb/postcode reference](https://gisservices.mainroads.wa.gov.au/arcgis/rest/services/Overlay/MapServer/5). Its source metadata, response, hashes and coverage evidence are retained separately. Every candidate still requires live Chrome locality validation. These files are local artifacts; they are not added to Git or published to the analytical databases by collection.

After collection stops, generate the local comparison:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/compare-captures.ts --capture captures/perth-houses-2026-10-12 --baseline captures/2026-07-baseline --additional-capture captures/perth-houses-2026-10-12-supplement
```

The comparison verifies source checksums and page-to-CSV agreement first. It distinguishes newly observed listing IDs from newly dated sales and corrections to existing listings. House statistics exclude other property types returned by the source's House filter. Full-capture identity counts include the six-month window; the aligned historical comparison starts June 1. July's capture day, the current partial month, differing historical surrounding-suburb scopes and incomplete current coverage are reported explicitly. A listing absent from the new six-month window is not treated as deleted.

Historical locality matching uses actual House address suburbs across the retained WA archive. The old query postcode remains provenance; it is not assigned as the property's actual postcode. This recovers observations collected under nearby or alias query names. Areas with no July House-address evidence have unavailable baseline coverage, rather than zero sales. They appear in coverage-expansion and full-current monthly outputs, while matched historical/monthly comparisons use the shared observed locality cohort. July address evidence establishes an observed sample, not complete historical market coverage.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Application database connection |
| `DATABASE_URL_UNPOOLED` | Direct connection for migrations and ingestion |
| `DATABASE_READ_URL` | Optional read-only or pooled serving connection |
| `BLOB_READ_WRITE_TOKEN` | Private Vercel Blob access |
| `MOTHERDUCK_TOKEN` | MotherDuck publication and query access |
| `MOTHERDUCK_PG_HOST` | Optional MotherDuck PostgreSQL endpoint override |
| `INGEST_SECRET` | Bearer secret protecting the HTTP ingestion endpoint |

Use `.env.example` as the configuration template. Production secrets belong in the deployment platform's encrypted environment store.

## Data ingestion

### Validated dated captures

Use `scripts/ingest-captures.ts` for a dated Chrome capture. It verifies the saved plans, page projections, CSVs and July inventory, then selects only complete nonempty scopes. Its default is a dry run; `--apply` requires migration `005_current_observation.sql`. Failed searches and verified empty searches are not registered as source files.

```powershell
node node_modules/tsx/dist/cli.mjs scripts/ingest-captures.ts --capture captures/perth-houses-2026-10-12 --baseline captures/2026-07-baseline --additional-capture captures/perth-houses-2026-10-12-supplement
```

Production credentials must be supplied through an ignored local environment file or the existing production runtime. Vercel's non-exportable Secret values appear as placeholders in `env pull`; placeholders cannot authenticate database operations. Do not put credential values in commands, logs, Git or capture artifacts.

After verifying the intended production estate and retaining the current canonical tables and procedure definitions, apply the migration and ingest with `--apply`. Migration 005 makes the latest retained observation authoritative, preserves older raw observations, and maintains one stable sale identity per REA listing. Its locality reference resolves postcodes from actual address suburbs rather than query filenames. The ingestion driver runs `CALL core.rebuild_current_sales()` after loading the capture to apply those rules across retained history, then refreshes both materialized marts. Reconcile the new capture against selected observations and sale facts before publication.

Publish the full rebuilt canonical history with `scripts/publish-motherduck.ts`. The publisher checks source consistency and stages all three serving tables inside one target transaction. It retains the prior tables under dated snapshot names and emits rollback SQL. Verify the live MotherDuck endpoint's transactional DDL support first, then run the enhanced smoke checks and public API checks before completing the release. April and October are partial months in this capture; recent price-disclosure gaps and unavailable historical locality coverage remain explicit.

### Local archive

The local bulk driver is the supported path for the historical archive:

```bash
pnpm ingest:local -- --limit=1
pnpm db:status
pnpm ingest:local
pnpm db:reconcile
```

### Incremental HTTP ingestion

Upload an immutable CSV to private Vercel Blob, then call `POST /api/ingest` with `Authorization: Bearer $INGEST_SECRET`:

```json
{
  "fileName": "rea-sold-ALFRED-COVE-WA-6154.csv",
  "objectUrl": "https://example.blob.vercel-storage.com/raw/example.csv",
  "expectedSha256": "optional-64-character-checksum"
}
```

The endpoint returns HTTP 202 with a Workflow run identifier. CSV bytes remain in Blob; workflow state contains only bounded file metadata. If `INGEST_SECRET` is missing, the endpoint fails closed with HTTP 503.

To archive source files using a fresh short-lived Vercel OIDC token:

```bash
vercel env pull .env.blob --environment=production
pnpm archive:blob
```

## Analytics API

### List suburbs

```http
GET /api/analytics/suburbs
```

### Monthly suburb sales

```http
GET /api/analytics/suburb-sales?suburb=Yokine&from=2020-01-01
```

Supported filters include `suburb_key`, `suburb`, `postcode`, `from`, `to`, `bedrooms`, and `limit`.

### Suburb insights

```http
GET /api/analytics/suburb-insights?suburb_key=yokine&from=2020-01-01&to=2025-12-31
```

The response includes rolling and prior-period medians, explicit sample sizes, land-to-price correlation, plausible median land size, and bedroom segments.

### System statistics

```http
GET /api/stats
```

## Data-quality principles

- Keep the raw CSV archive immutable.
- Preserve missing prices instead of converting them to zero.
- Keep source observations, canonical properties, listings, and sale events at distinct grains.
- Recalculate medians from sale facts.
- Make exclusions and sample sizes visible.
- Use idempotent ingestion and content hashes so retries do not duplicate records.
- Do not rely on Neon raw tables as the only recovery source.

## Production

The public site is deployed at [perthhousedata.com](https://perthhousedata.com).

For production operations:

- Keep Vercel Functions, Neon, and MotherDuck geographically close where possible.
- Use the direct Neon connection for migrations and ingestion, and a pooled or read-only connection for public traffic.
- Store all secrets in encrypted deployment configuration.
- Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` before deployment.
- Run reconciliation and MotherDuck smoke checks after material data refreshes.

## Disclaimer

Perth House Data is an independent project and is not affiliated with realestate.com.au. The dataset may contain source errors, omissions, delayed records, and inferred identities. Results are provided for exploration and should not be treated as financial advice or a formal valuation.
