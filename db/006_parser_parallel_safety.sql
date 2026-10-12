-- Neon 17.11 raised "cannot start commands during a parallel operation" during the
-- source_listing_id exception-cleanup path in parallel curation CTAS. Conservatively
-- keep all five exception-handling parsers out of parallel plans without changing validation.
-- Existing installs of 005 need this metadata correction before any curation/rebuild.
ALTER FUNCTION core.source_listing_id(text, text) PARALLEL UNSAFE;
ALTER FUNCTION core.source_timestamp(text) PARALLEL UNSAFE;
ALTER FUNCTION core.source_date(text) PARALLEL UNSAFE;
ALTER FUNCTION core.source_integer(text, bigint) PARALLEL UNSAFE;
ALTER FUNCTION core.disclosed_price(text) PARALLEL UNSAFE;
