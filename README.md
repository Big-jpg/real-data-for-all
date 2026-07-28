# Perth House Data

[Perth House Data](https://perthhousedata.com) is a free, public explorer for three decades of detached-house sales across Perth postcodes 6000–6200.

The project turns an immutable archive of sold-listing observations into a traceable analytical dataset. Visitors can explore suburb history, rolling price medians, sales volume, bedroom segments, and land-to-price relationships, then export the underlying results or create a styled snapshot.

## Analytical scope

- Detached houses only
- Perth postcodes 6000–6200
- Units, apartments, acreage, duplexes, and semi-detached properties excluded
- Unpriced sales retained for volume measures but excluded from price statistics
- Descriptive historical analysis—not a property valuation service

The current baseline contains 347,887 source observations across 296,422 listings and approximately 330 house-sale suburbs. Source and analytical counts are reconciled explicitly; unexplained differences are treated as data-quality issues rather than silently discarded.

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
- A Chrome extension in `rea-sold-scraper` for controlled source collection

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
