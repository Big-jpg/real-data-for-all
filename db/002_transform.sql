CREATE OR REPLACE FUNCTION core.normalise_address(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT NULLIF(trim(regexp_replace(upper(translate(coalesce(value,''),'.''’','   ')),'\s+',' ','g')),'') $$;

CREATE OR REPLACE PROCEDURE core.curate_file(target_file_id uuid) LANGUAGE plpgsql AS $$
BEGIN
 UPDATE ops.ingest_file SET status='cleaning',error=NULL WHERE file_id=target_file_id;
 INSERT INTO core.property(canonical_address,address_fingerprint,street_address,suburb,postcode,first_observed_at,last_observed_at)
 SELECT address_clean,encode(digest(address_clean||'|WA|'||coalesce(postcode,''),'sha256'),'hex'),street_address,suburb,postcode,min(scraped_at),max(scraped_at)
 FROM (SELECT core.normalise_address(address_text) address_clean,
   core.normalise_address(regexp_replace(address_text,',[^,]+$','')) street_address,
   initcap(trim((regexp_match(address_text,',\s*([^,]+?)\s*$'))[1])) suburb,
   coalesce((regexp_match(address_text,'\b(6\d{3})\b'))[1],(regexp_match(f.file_name,'_(6\d{3})_'))[1]) postcode,
   CASE WHEN scraped_at_source ~ '^\d{4}-' THEN scraped_at_source::timestamptz END scraped_at
  FROM raw.sale_observation r JOIN ops.ingest_file f USING(file_id) WHERE r.file_id=target_file_id AND address_text IS NOT NULL
   AND address_text!~*'^(address (available|withheld)|contact agent)') x
 WHERE address_clean IS NOT NULL AND street_address IS NOT NULL AND suburb IS NOT NULL
 GROUP BY address_clean,street_address,suburb,postcode
 ON CONFLICT(address_fingerprint) DO UPDATE SET last_observed_at=greatest(core.property.last_observed_at,excluded.last_observed_at),updated_at=now();

 WITH candidates AS (SELECT r.*,
   (regexp_match(coalesce(r.detail_path,r.detail_url),'(\d+)(?:[/?#].*)?$'))[1]::bigint listing_id,
   core.normalise_address(r.address_text) address_clean,coalesce((regexp_match(r.address_text,'\b(6\d{3})\b'))[1],(regexp_match(f.file_name,'_(6\d{3})_'))[1]) postcode,
   CASE WHEN r.scraped_at_source~'^\d{4}-' THEN r.scraped_at_source::timestamptz END scraped_at,
   (CASE WHEN r.price_value_source~'^\d+$' THEN 100 ELSE 0 END+CASE WHEN r.sold_date_iso_source~'^\d{4}-' THEN 80 ELSE 0 END+
    CASE WHEN r.address_text IS NOT NULL THEN 40 ELSE 0 END+CASE WHEN r.land_size_sqm_source~'^\d+$' THEN 30 ELSE 0 END+
    CASE WHEN r.property_type_source IS NOT NULL THEN 10 ELSE 0 END) quality_score
  FROM raw.sale_observation r JOIN ops.ingest_file f USING(file_id) WHERE r.file_id=target_file_id)
 INSERT INTO core.listing(listing_id,property_id,detail_url,selected_observation_key,first_scraped_at,last_scraped_at,observation_count)
 SELECT c.listing_id,p.property_id,coalesce(max(c.detail_url),max(c.detail_path)),
  (array_agg(c.observation_key ORDER BY c.quality_score DESC,c.scraped_at DESC NULLS LAST))[1],min(c.scraped_at),max(c.scraped_at),count(*)
 FROM candidates c LEFT JOIN core.property p ON p.address_fingerprint=encode(digest(c.address_clean||'|WA|'||coalesce(c.postcode,''),'sha256'),'hex')
 WHERE c.listing_id IS NOT NULL GROUP BY c.listing_id,p.property_id
 ON CONFLICT(listing_id) DO UPDATE SET property_id=coalesce(excluded.property_id,core.listing.property_id),
  last_scraped_at=greatest(core.listing.last_scraped_at,excluded.last_scraped_at),
  observation_count=greatest(core.listing.observation_count,excluded.observation_count),updated_at=now();

 INSERT INTO core.sale_event(property_id,listing_id,sold_date,price_aud,property_type,bedrooms,bathrooms,car_spaces,land_size_sqm,quality_score,sale_fingerprint)
 SELECT l.property_id,l.listing_id,
  CASE WHEN r.sold_date_iso_source~'^\d{4}-\d{2}-\d{2}$' THEN r.sold_date_iso_source::date END,
  CASE WHEN r.price_value_source~'^\d+$' THEN r.price_value_source::bigint END,initcap(r.property_type_source),
  CASE WHEN r.bedrooms_source~'^\d+$' THEN r.bedrooms_source::smallint END,
  CASE WHEN r.bathrooms_source~'^\d+$' THEN r.bathrooms_source::smallint END,
  CASE WHEN r.car_spaces_source~'^\d+$' THEN r.car_spaces_source::smallint END,
  CASE WHEN r.land_size_sqm_source~'^\d+$' THEN r.land_size_sqm_source::bigint END,220,
  encode(digest(l.property_id::text||'|'||coalesce(r.sold_date_iso_source,'')||'|'||coalesce(r.price_value_source,'')||'|'||l.listing_id::text,'sha256'),'hex')
 FROM core.listing l JOIN raw.sale_observation r ON r.observation_key=l.selected_observation_key
 WHERE r.file_id=target_file_id AND l.property_id IS NOT NULL
 ON CONFLICT(sale_fingerprint) DO UPDATE SET updated_at=now();
 UPDATE ops.ingest_file SET status='curated',completed_at=now() WHERE file_id=target_file_id;
END $$;
