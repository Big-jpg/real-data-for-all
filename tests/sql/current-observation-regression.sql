-- Disposable database only. scripts/test-curation.mjs executes the migration at the marker.
-- All fixtures and the migration are rolled back after their assertions.
BEGIN;

CREATE FUNCTION pg_temp.assert_true(condition boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Regression failed: %', message; END IF; END $$;

INSERT INTO ops.ingest_file(file_id, file_name, sha256, byte_size, status) VALUES
 ('00000000-0000-0000-0000-000000000001', 'historical-PERTH-_6001_.csv', repeat('1',64), 1, 'loaded'),
 ('00000000-0000-0000-0000-000000000002', 'fresh-PERTH-_6000_.csv', repeat('2',64), 1, 'loaded'),
 ('00000000-0000-0000-0000-000000000003', 'late-historical-PERTH-_6001_.csv', repeat('3',64), 1, 'loaded'),
 ('00000000-0000-0000-0000-000000000004', 'surrounding-BANJUP-_6164_.csv', repeat('4',64), 1, 'loaded'),
 ('00000000-0000-0000-0000-000000000005', 'later-price-withdrawal-PERTH-_6000_.csv', repeat('5',64), 1, 'loaded');

INSERT INTO raw.sale_observation(observation_key, record_hash, file_id, source_row_number, address_text, detail_path, detail_url,
 price_text, price_value_source, property_type_source, sold_date_iso_source, scraped_at_source, land_size_sqm_source) VALUES
 (repeat('1',64), repeat('1',64), '00000000-0000-0000-0000-000000000001', 1, '1 River Road, Perth', '/sold/property-house-wa-perth-1001', 'https://www.realestate.com.au/sold/property-house-wa-perth-1001', '$750,000', '750000', 'House', '2026-06-01', '2026-07-02T12:00:00.000Z', '400'),
 (repeat('2',64), repeat('2',64), '00000000-0000-0000-0000-000000000001', 2, '2 River Road, Perth', '/sold/property-house-wa-perth-1002', 'https://www.realestate.com.au/sold/property-house-wa-perth-1002', '$700,000 - $750,000', '725000', 'House', '2026-06-03', '2026-07-03T12:00:00.000Z', '400'),
 (repeat('3',64), repeat('3',64), '00000000-0000-0000-0000-000000000001', 3, '4 River Road, Perth', '/sold/property-house-wa-perth-1004', 'https://www.realestate.com.au/sold/property-house-wa-perth-1004', '$900,000', '900000', 'House', '2026-06-04', '2026-07-04T12:00:00.000Z', '400'),
 (repeat('4',64), repeat('4',64), '00000000-0000-0000-0000-000000000004', 1, '3 River Road, Canning Vale', '/sold/property-house-wa-canning+vale-1003', 'https://www.realestate.com.au/sold/property-house-wa-canning+vale-1003', '$950,000', '950000', 'House', '2026-06-05', '2026-07-03T12:00:00.000Z', '500'),
 (repeat('5',64), repeat('5',64), '00000000-0000-0000-0000-000000000004', 2, '5 River Road, Unknown Test Locality', '/sold/property-house-wa-unknown-1005', 'https://www.realestate.com.au/sold/property-house-wa-unknown-1005', '$950,000', '950000', 'House', '2026-06-05', '2026-07-03T12:00:00.000Z', '500'),
 (repeat('6',64), repeat('6',64), '00000000-0000-0000-0000-000000000002', 1, '1 River Road, Perth', '/sold/property-house-wa-perth-1001', 'https://www.realestate.com.au/sold/property-house-wa-perth-1001', '$1,100,000', '1100000', 'House', '2026-06-08', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('7',64), repeat('7',64), '00000000-0000-0000-0000-000000000002', 2, '2 River Road, Perth', '/sold/property-house-wa-perth-1002', 'https://www.realestate.com.au/sold/property-house-wa-perth-1002', '$825,000', '725000', 'House', '2026-06-04', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('8',64), repeat('8',64), '00000000-0000-0000-0000-000000000002', 3, NULL, '/sold/property-house-wa-perth-1004', 'https://www.realestate.com.au/sold/property-house-wa-perth-1004', '$900,000', '900000', 'House', '2026-06-04', '2026-10-11T12:00:00.000Z', NULL),
 (repeat('9',64), repeat('9',64), '00000000-0000-0000-0000-000000000002', 4, '6 River Road, Perth', '/sold/property-house-wa-perth-1006', 'https://www.realestate.com.au/sold/property-house-wa-perth-1006', '$900,000', '900000', 'House', '2026-02-30', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('a',64), repeat('a',64), '00000000-0000-0000-0000-000000000002', 5, '7 River Road, Perth', '/sold/property-house-wa-perth-1007', 'https://www.realestate.com.au/sold/property-house-wa-perth-1007', '$900,000', '900000', 'House', '2026-12-01', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('b',64), repeat('b',64), '00000000-0000-0000-0000-000000000002', 6, '8 River Road, Perth', '/sold/property-other-wa-perth-1008', 'https://www.realestate.com.au/sold/property-other-wa-perth-1008', '$900,000', '900000', 'Other', '2026-06-04', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('c',64), repeat('c',64), '00000000-0000-0000-0000-000000000001', 4, '9 River Road, Perth', '/sold/property-house-wa-perth-1009', 'https://www.realestate.com.au/sold/property-house-wa-perth-1009', '$1,200,000', '1200000', 'House', '2026-06-04', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('d',64), repeat('d',64), '00000000-0000-0000-0000-000000000002', 7, '9 River Road, Perth', '/sold/property-house-wa-perth-1009', 'https://www.realestate.com.au/sold/property-house-wa-perth-1009', '$1,300,000', '1300000', 'House', '2026-06-04', '2026-10-11T12:00:00.000Z', '400'),
 (repeat('e',64), repeat('e',64), '00000000-0000-0000-0000-000000000001', 5, '10 River Road, Perth', '/sold/property-house-wa-perth-1010', 'https://www.realestate.com.au/sold/property-house-wa-perth-1010', '$900,000', '900000', 'House', '2026-06-04', '2026-07-04T12:00:00.000Z', '400'),
 (repeat('f',64), repeat('f',64), '00000000-0000-0000-0000-000000000002', 8, '10 River Road, Perth', '/sold/property-house-wa-perth-1010', 'https://www.realestate.com.au/sold/property-house-wa-perth-1010', 'Contact agent', NULL, 'House', '2026-06-04', '2026-10-11T12:00:00.000Z', NULL);
UPDATE raw.sale_observation SET car_spaces_source='0' WHERE observation_key=repeat('6',64);

-- Establish the previous canonical projection and a mutable-fingerprint duplicate.
CALL core.curate_file('00000000-0000-0000-0000-000000000001');
CALL core.curate_file('00000000-0000-0000-0000-000000000004');
INSERT INTO core.sale_event(property_id, listing_id, sold_date, price_aud, property_type, quality_score, sale_fingerprint)
SELECT property_id, listing_id, sold_date, 760000, property_type, quality_score, repeat('0',64)
FROM core.sale_event WHERE listing_id = 1001;
SELECT pg_temp.assert_true((SELECT count(*) FROM core.sale_event WHERE listing_id=1001)=2, 'fixture includes prior duplicate sale projections');
CREATE TEMP TABLE raw_before AS SELECT to_jsonb(r) AS snapshot FROM raw.sale_observation r;

-- APPLY_CURRENT_OBSERVATION_MIGRATION_HERE

SELECT pg_temp.assert_true((SELECT count(*) FROM core.sale_event WHERE listing_id=1001)=1, 'migration removes only duplicate current projections');
CALL core.rebuild_current_sales();
CREATE TEMP TABLE stable_sale AS SELECT sale_event_id, sale_fingerprint FROM core.sale_event WHERE listing_id=1001;
SELECT pg_temp.assert_true((SELECT selected_observation_key FROM core.listing WHERE listing_id=1001)=repeat('6',64), 'newest retained observation selected');
SELECT pg_temp.assert_true((SELECT price_aud=1100000 AND sold_date=DATE '2026-06-08' FROM core.sale_event WHERE listing_id=1001), 'later price and corrected date update the current sale');
SELECT pg_temp.assert_true((SELECT car_spaces=0 FROM core.sale_event WHERE listing_id=1001), 'zero car spaces is retained rather than treated as missing');
SELECT pg_temp.assert_true(core.source_timestamp('2026-02-30T12:00:00.000Z') IS NULL, 'invalid capture datetime cannot crash curation');
SELECT pg_temp.assert_true(core.source_timestamp('2026-10-11') IS NULL, 'capture time without an explicit timezone is not guessed');
SELECT pg_temp.assert_true((SELECT p.postcode='6000' FROM core.listing l JOIN core.property p USING(property_id) WHERE l.listing_id=1001), 'actual Perth locality repairs historical postal postcode 6001');
SELECT pg_temp.assert_true((SELECT p.postcode='6155' FROM core.listing l JOIN core.property p USING(property_id) WHERE l.listing_id=1003), 'actual Canning Vale repairs surrounding-query filename postcode 6164');
SELECT pg_temp.assert_true((SELECT p.postcode IS NULL FROM core.listing l JOIN core.property p USING(property_id) WHERE l.listing_id=1005), 'unmapped actual locality does not borrow query postcode');
SELECT pg_temp.assert_true((SELECT price_aud=825000 FROM core.sale_event WHERE listing_id=1002), 'numeric price derives from the exact disclosed display rather than stale priceValue');
SELECT pg_temp.assert_true(core.disclosed_price('$700,000 - $750,000') IS NULL, 'range midpoint never becomes a disclosed price');
SELECT pg_temp.assert_true((SELECT selected_observation_key FROM core.listing WHERE listing_id=1009)=repeat('c',64), 'equal timestamp/completeness has a stable observation-key tie break');
SELECT pg_temp.assert_true((SELECT selected_observation_key FROM core.listing WHERE listing_id=1010)=repeat('f',64), 'latest observation wins despite lower completeness');
SELECT pg_temp.assert_true((SELECT price_aud IS NULL FROM core.sale_event WHERE listing_id=1010), 'latest undisclosed price remains blank');
SELECT pg_temp.assert_true((SELECT count(*) FROM core.sale_event WHERE listing_id=1004)=0, 'latest unresolved address is not served through an older property identity');
SELECT pg_temp.assert_true((SELECT sold_date IS NULL FROM core.sale_event WHERE listing_id=1006), 'invalid calendar date does not crash curation or enter monthly counts');
SELECT pg_temp.assert_true((SELECT sold_date IS NULL FROM core.sale_event WHERE listing_id=1007), 'future sold date is excluded relative to capture time');
SELECT pg_temp.assert_true((SELECT property_type='Other' FROM core.sale_event WHERE listing_id=1008), 'actual non-House source type remains intact');

-- Loading an older file after the refresh cannot regress its current pointer.
INSERT INTO raw.sale_observation(observation_key, record_hash, file_id, source_row_number, address_text, detail_path,
 price_text, price_value_source, property_type_source, sold_date_iso_source, scraped_at_source)
VALUES (repeat('0',64),repeat('0',64),'00000000-0000-0000-0000-000000000003',1,'1 River Road, Perth','/sold/property-house-wa-perth-1001',
 '$765,000','765000','House','2026-06-01','2026-07-06T12:00:00.000Z');
CALL core.curate_file('00000000-0000-0000-0000-000000000003');
SELECT pg_temp.assert_true((SELECT selected_observation_key FROM core.listing WHERE listing_id=1001)=repeat('6',64), 'late-arriving historical file cannot overwrite newer source truth');
SELECT pg_temp.assert_true((SELECT observation_count FROM core.listing WHERE listing_id=1001)=3, 'observation count spans all retained files');

-- Price disclosure withdrawal updates the same sale identity, preserving every older source row.
INSERT INTO raw.sale_observation(observation_key, record_hash, file_id, source_row_number, address_text, detail_path,
 price_text, property_type_source, sold_date_iso_source, scraped_at_source)
VALUES (repeat('01',32),repeat('01',32),'00000000-0000-0000-0000-000000000005',1,'1 River Road, Perth','/sold/property-house-wa-perth-1001',
 'Contact agent','House','2026-06-08','2026-10-12T12:00:00.000Z');
CALL core.curate_file('00000000-0000-0000-0000-000000000005');
SELECT pg_temp.assert_true((SELECT price_aud IS NULL FROM core.sale_event WHERE listing_id=1001), 'price withdrawal reflects latest source truth');
SELECT pg_temp.assert_true((SELECT count(*) FROM core.sale_event WHERE listing_id=1001)=1, 'price/date correction does not add another sale');
SELECT pg_temp.assert_true((SELECT s.sale_event_id=b.sale_event_id AND s.sale_fingerprint=b.sale_fingerprint FROM core.sale_event s CROSS JOIN stable_sale b WHERE s.listing_id=1001), 'sale identity is stable across current-observation changes');
SELECT pg_temp.assert_true((SELECT observation_count FROM core.listing WHERE listing_id=1001)=4, 'repeat capture contributes one observation, not another sale');
SELECT pg_temp.assert_true(NOT EXISTS (SELECT snapshot FROM raw_before EXCEPT SELECT to_jsonb(r) FROM raw.sale_observation r), 'all July raw evidence remains byte-value identical across every raw column');
SELECT pg_temp.assert_true((SELECT count(*) FROM raw.sale_observation)=17, 'only the two intended later observations were added');
CALL core.curate_file('00000000-0000-0000-0000-000000000005');
SELECT pg_temp.assert_true((SELECT observation_count FROM core.listing WHERE listing_id=1001)=4, 'curating the same file is idempotent');
REFRESH MATERIALIZED VIEW mart.suburb_dimension;
REFRESH MATERIALIZED VIEW mart.suburb_monthly_sales;
SELECT pg_temp.assert_true((SELECT sum(sale_count) FROM mart.suburb_monthly_sales)=5, 'House mart excludes Other, unknown postcode, invalid/future dates and unresolved property');

ROLLBACK;
