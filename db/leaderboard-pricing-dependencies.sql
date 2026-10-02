-- Shared with the edge getRowPricing contract: positive UTC+8 weekend rules
-- started at 2026-08-23 00:00 Beijing time. Group BEFORE discarding the hour.
CREATE OR REPLACE FUNCTION public.leaderboard_pricing_tier(p_model text, p_hour_start timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO pg_catalog, public
AS $func$
  SELECT CASE
    WHEN lower(p_model) NOT LIKE ALL (ARRAY[
      '%deepseek-v4-flash%', '%deepseek-v4.1-flash%',
      '%deepseek-flash%', '%deepseek-v4-pro%'
    ]) THEN 'peak'
    WHEN p_hour_start >= '2026-08-22T16:00:00Z'::timestamptz
      AND extract(isodow FROM p_hour_start AT TIME ZONE 'Asia/Shanghai') IN (6, 7)
      THEN 'off_peak'
    WHEN (extract(hour FROM p_hour_start AT TIME ZONE 'UTC') >= 1
      AND extract(hour FROM p_hour_start AT TIME ZONE 'UTC') < 4)
      OR (extract(hour FROM p_hour_start AT TIME ZONE 'UTC') >= 6
      AND extract(hour FROM p_hour_start AT TIME ZONE 'UTC') < 10)
      THEN 'peak'
    ELSE 'off_peak'
  END
$func$;
REVOKE ALL ON FUNCTION public.leaderboard_pricing_tier(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_pricing_tier(text, timestamptz) TO project_admin;

-- Atomic per-period throttle shared by scheduled refresh functions.
-- Keep this dependency in migrations so clean installations can replay it.
CREATE TABLE IF NOT EXISTS public.tokentracker_refresh_claims (
  period text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL
);
ALTER TABLE public.tokentracker_refresh_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_refresh_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_refresh_claims TO project_admin;
CREATE OR REPLACE FUNCTION public.leaderboard_refresh_try_claim(p_period text, p_min_interval_s integer)
RETURNS boolean LANGUAGE sql VOLATILE
SET search_path TO pg_catalog, public
AS $func$
  WITH claimed AS (
    INSERT INTO public.tokentracker_refresh_claims AS existing (period, last_attempt_at)
    VALUES (p_period, clock_timestamp())
    ON CONFLICT (period) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at
      WHERE existing.last_attempt_at <= EXCLUDED.last_attempt_at
        - make_interval(secs => GREATEST(0, p_min_interval_s))
    RETURNING true AS won
  ) SELECT EXISTS (SELECT 1 FROM claimed)
$func$;
REVOKE ALL ON FUNCTION public.leaderboard_refresh_try_claim(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_refresh_try_claim(text, integer) TO project_admin;

ALTER TABLE public.tokentracker_leaderboard_rollup_daily_v2
  ADD COLUMN IF NOT EXISTS pricing_tier text NOT NULL DEFAULT 'peak';
ALTER TABLE public.tokentracker_leaderboard_rollup_daily_v2
  DROP CONSTRAINT IF EXISTS tokentracker_leaderboard_rollup_daily_v2_pkey;
ALTER TABLE public.tokentracker_leaderboard_rollup_daily_v2
  ADD PRIMARY KEY (user_id, source, model, day, pricing_tier);

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_replace_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
SET TimeZone TO 'UTC'
AS $func$
DECLARE
  v_day timestamptz;
BEGIN
  v_day := date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  WHILE v_day < p_to LOOP
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
    WHERE day = (v_day AT TIME ZONE 'UTC')::date;

    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2 (
      user_id, source, model, day, pricing_tier,
      total_tokens, input_tokens, output_tokens,
      cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
    )
    SELECT
      d.user_id, d.source, d.model,
      (d.hour_start AT TIME ZONE 'UTC')::date AS day,
      public.leaderboard_pricing_tier(d.model, d.hour_start),
      SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
      SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens), SUM(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v2(v_day, v_day + interval '1 day') d
    GROUP BY d.user_id, d.source, d.model, (d.hour_start AT TIME ZONE 'UTC')::date,
      public.leaderboard_pricing_tier(d.model, d.hour_start);

    v_day := v_day + interval '1 day';
  END LOOP;

END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_daily_replace_v2(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_daily_replace_v2(timestamptz, timestamptz)
  TO project_admin;


-- Daily totals cannot be split into tiers without the original hourly rows.
-- Let the existing bounded cyclic repair rebuild them, starting at the oldest
-- affected day; total-v2 transition triggers propagate each repaired day.
UPDATE public.tokentracker_leaderboard_rollup_meta_v2
SET repair_from = LEAST(repair_from, (
  SELECT min(day) FROM public.tokentracker_leaderboard_rollup_daily_v2
  WHERE lower(model) LIKE ANY (ARRAY['%deepseek-v4-flash%', '%deepseek-v4.1-flash%', '%deepseek-flash%', '%deepseek-v4-pro%'])
)) WHERE id = 1;
