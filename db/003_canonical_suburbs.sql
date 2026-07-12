DROP MATERIALIZED VIEW IF EXISTS mart.suburb_monthly_sales;
DROP MATERIALIZED VIEW IF EXISTS mart.suburb_dimension;

CREATE MATERIALIZED VIEW mart.suburb_dimension AS
WITH observed AS (
  SELECT
    trim(both '-' from regexp_replace(lower(trim(p.suburb)), '[^a-z0-9]+', '-', 'g')) AS suburb_key,
    p.suburb,
    p.postcode,
    count(*)::bigint AS sale_count,
    max(s.sold_date) AS last_sale_date
  FROM core.sale_event s
  JOIN core.property p USING(property_id)
  WHERE s.sold_date >= DATE '1990-01-01'
    AND nullif(trim(p.suburb), '') IS NOT NULL
  GROUP BY 1, p.suburb, p.postcode
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY suburb_key
    ORDER BY sale_count DESC, last_sale_date DESC NULLS LAST, postcode NULLS LAST
  ) AS postcode_rank
  FROM observed
), totals AS (
  SELECT
    suburb_key,
    sum(sale_count)::bigint AS sale_count,
    string_agg(DISTINCT postcode, ',' ORDER BY postcode) FILTER (WHERE postcode IS NOT NULL) AS observed_postcodes
  FROM observed
  GROUP BY suburb_key
)
SELECT
  r.suburb_key,
  r.suburb,
  r.postcode AS canonical_postcode,
  t.observed_postcodes,
  t.sale_count,
  round(r.sale_count::numeric / nullif(t.sale_count, 0), 4) AS postcode_confidence
FROM ranked r
JOIN totals t USING(suburb_key)
WHERE r.postcode_rank = 1
WITH NO DATA;

CREATE UNIQUE INDEX suburb_dimension_key ON mart.suburb_dimension(suburb_key);

CREATE MATERIALIZED VIEW mart.suburb_monthly_sales AS
SELECT
  d.suburb_key,
  d.suburb,
  d.canonical_postcode AS postcode,
  date_trunc('month', s.sold_date)::date AS sale_month,
  count(*)::bigint AS sale_count,
  percentile_cont(.5) WITHIN GROUP(ORDER BY s.price_aud)
    FILTER(WHERE s.price_aud IS NOT NULL)::bigint AS median_price_aud,
  avg(s.price_aud)::bigint AS average_price_aud,
  min(s.price_aud) AS minimum_price_aud,
  max(s.price_aud) AS maximum_price_aud
FROM core.sale_event s
JOIN core.property p USING(property_id)
JOIN mart.suburb_dimension d
  ON d.suburb_key = trim(both '-' from regexp_replace(lower(trim(p.suburb)), '[^a-z0-9]+', '-', 'g'))
WHERE s.sold_date >= DATE '1990-01-01'
GROUP BY d.suburb_key, d.suburb, d.canonical_postcode, date_trunc('month', s.sold_date)::date
WITH NO DATA;

CREATE UNIQUE INDEX suburb_monthly_sales_key ON mart.suburb_monthly_sales(suburb_key, sale_month);

REFRESH MATERIALIZED VIEW mart.suburb_dimension;
REFRESH MATERIALIZED VIEW mart.suburb_monthly_sales;
