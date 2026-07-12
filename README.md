# REA for All

Open, auditable analytical property-sales data for Perth. The application migrates the existing Fabric medallion pipeline to immutable CSV sources, Vercel Workflow orchestration, Neon Postgres canonical records, and MotherDuck OLAP serving.

## Data flow

1. A CSV is retained in private Vercel Blob and registered in `ops.ingest_file` by SHA-256. Workflow steps read it through the authenticated Blob SDK.
2. A durable workflow parses one bounded file and idempotently lands observations in `raw.sale_observation`.
3. `core.curate_file` selects the best listing observation and resolves it to a canonical property.
4. `core.sale_event` preserves transactions independently of listing identity.
5. `mart.suburb_monthly_sales` serves common application reads from Neon.
6. `scripts/publish-motherduck.ts` uses the native integration token and MotherDuck PostgreSQL endpoint to publish the curated aggregate for columnar analytics.

The current canonical key is a SHA-256 fingerprint of normalized address, state, and postcode. It is marked as `NORMALIZED_ADDRESS` with a confidence of `0.9000`; authoritative parcel/title identifiers can later be attached without changing `property_id` references.

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm db:migrate
pnpm test
pnpm ingest:local -- --limit=1
pnpm db:status
pnpm ingest:local
```

Archive the historical CSV source after pulling a fresh short-lived Blob OIDC token without overwriting the Neon credentials in `.env.local`:

```bash
vercel env pull .env.blob --environment=production
pnpm archive:blob
```

Standalone database scripts load `.env.local` explicitly. Pull the connected Production variables before the first migration with `vercel env pull .env.local --environment=production`.

## HTTP ingestion

Upload an immutable CSV to Vercel Blob, then call `POST /api/ingest` with `Authorization: Bearer $INGEST_SECRET`:

```json
{"fileName":"rea-sold-ALFRED-COVE-WA-6154.csv","objectUrl":"https://...blob.vercel-storage.com/raw/...csv","expectedSha256":"optional-64-character-checksum"}
```

The route returns `202` and a Vercel Workflow run ID. The Workflow state contains only file metadata; CSV bytes remain in Blob.
If `INGEST_SECRET` is not configured, the route fails closed with HTTP 503.

## Baseline reconciliation

The last Fabric notebook run reported 347,887 observations, 296,422 listings, 232,596 core analytical records, and 333 suburbs. The current local archive contains 347,902 rows and 347,886 unique observation keys (16 repeated observations), a one-observation drift from that earlier Fabric run. Compare the Neon counts through `/api/stats` after the full load. Differences must be explained by an explicit quality rule rather than silent deletion.

## Production notes

- Co-locate Vercel Functions, Neon, and MotherDuck as closely as available.
- Use the direct Neon URL for migrations/ingestion and a read replica or pooled URL for public APIs.
- The first 121 MB historical load is intentionally supported by the local bulk driver; incremental files use Vercel Workflow.
- Keep the raw CSV archive immutable. Do not use Neon raw tables as the only recovery source.
