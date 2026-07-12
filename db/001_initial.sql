CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;

CREATE TABLE IF NOT EXISTS ops.schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ops.ingest_file (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_name text NOT NULL DEFAULT 'realestate.com.au',
  file_name text NOT NULL, object_url text, sha256 char(64) NOT NULL UNIQUE, byte_size bigint NOT NULL CHECK(byte_size>=0),
  schema_version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'registered'
    CHECK(status IN ('registered','loading','loaded','cleaning','curated','failed')),
  source_rows integer, accepted_rows integer, rejected_rows integer, error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS ops.data_quality_result (
  result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, file_id uuid REFERENCES ops.ingest_file(file_id),
  rule_name text NOT NULL, severity text NOT NULL CHECK(severity IN ('info','warning','error')),
  affected_rows bigint NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw.sale_observation (
  observation_key char(64) PRIMARY KEY, record_hash char(64) NOT NULL,
  file_id uuid NOT NULL REFERENCES ops.ingest_file(file_id), source_row_number integer NOT NULL,
  source_url text, page_number integer, ordinal_on_page integer, price_text text, price_value_source text,
  address_text text, detail_path text, detail_url text, bedrooms_source text, bathrooms_source text,
  car_spaces_source text, land_size_text text, land_size_sqm_source text, property_type_source text,
  sold_date_text text, sold_date_iso_source text, scraped_at_source text,
  loaded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(file_id,source_row_number)
);
CREATE INDEX IF NOT EXISTS raw_observation_detail_url_idx ON raw.sale_observation(detail_url);

CREATE TABLE IF NOT EXISTS core.property (
  property_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), canonical_address text NOT NULL,
  address_fingerprint char(64) NOT NULL UNIQUE, street_address text NOT NULL, suburb text NOT NULL,
  state char(2) NOT NULL DEFAULT 'WA', postcode char(4), match_method text NOT NULL DEFAULT 'NORMALIZED_ADDRESS',
  match_confidence numeric(5,4) NOT NULL DEFAULT .9000, first_observed_at timestamptz,
  last_observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS property_suburb_postcode_idx ON core.property(suburb,postcode);
CREATE TABLE IF NOT EXISTS core.listing (
  listing_id bigint PRIMARY KEY, property_id uuid REFERENCES core.property(property_id), detail_url text NOT NULL,
  selected_observation_key char(64) REFERENCES raw.sale_observation(observation_key), first_scraped_at timestamptz,
  last_scraped_at timestamptz, observation_count integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_property_idx ON core.listing(property_id);
CREATE TABLE IF NOT EXISTS core.sale_event (
  sale_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES core.property(property_id),
  listing_id bigint NOT NULL REFERENCES core.listing(listing_id), sold_date date, price_aud bigint, property_type text,
  bedrooms smallint, bathrooms smallint, car_spaces smallint, land_size_sqm bigint, quality_score integer NOT NULL,
  sale_fingerprint char(64) NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sale_event_date_idx ON core.sale_event(sold_date);
CREATE INDEX IF NOT EXISTS sale_event_property_idx ON core.sale_event(property_id,sold_date);

CREATE MATERIALIZED VIEW IF NOT EXISTS mart.suburb_monthly_sales AS
SELECT p.suburb,p.postcode,date_trunc('month',s.sold_date)::date sale_month,count(*)::bigint sale_count,
 percentile_cont(.5) WITHIN GROUP(ORDER BY s.price_aud) FILTER(WHERE s.price_aud IS NOT NULL)::bigint median_price_aud,
 avg(s.price_aud)::bigint average_price_aud,min(s.price_aud) minimum_price_aud,max(s.price_aud) maximum_price_aud
FROM core.sale_event s JOIN core.property p USING(property_id) WHERE s.sold_date>=DATE '1990-01-01'
GROUP BY p.suburb,p.postcode,date_trunc('month',s.sold_date)::date WITH NO DATA;
CREATE UNIQUE INDEX IF NOT EXISTS suburb_monthly_sales_key ON mart.suburb_monthly_sales(suburb,postcode,sale_month);
