-- Forward repair for installations that already ran the September migrations.
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

-- Update the single-scan account aggregation promoted in September, retaining
-- device/session deduplication while sharing the corrected pricing tiers.

CREATE OR REPLACE FUNCTION public.account_usage_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
  WITH tzr AS (
    SELECT CASE
      WHEN p_tz IS NOT NULL AND p_tz <> ''
       AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
      THEN p_tz ELSE NULL
    END AS tz
  ), base AS MATERIALIZED (
    SELECT
      h.device_id, h.hour_start, h.source, h.model,
      h.total_tokens::bigint AS total_tokens,
      h.input_tokens::bigint AS input_tokens,
      h.output_tokens::bigint AS output_tokens,
      h.cached_input_tokens::bigint AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint AS reasoning_output_tokens,
      h.conversations::bigint AS conversations,
      h.updated_at
    FROM public.tokentracker_hourly h
    WHERE h.user_id = p_user_id
      AND h.hour_start >= p_from AND h.hour_start < p_to
      AND (
        h.source = 'cursor'
        OR (
          h.source NOT IN ('cursor', 'trae-cn')
          AND h.device_id = ANY(p_device_ids)
        )
      )
  ), hourly AS (
    SELECT mac.hour_start, mac.source, mac.model,
      mac.total_tokens, mac.input_tokens, mac.output_tokens,
      mac.cached_input_tokens, mac.cache_creation_input_tokens,
      mac.reasoning_output_tokens, mac.conversations
    FROM (
      SELECT DISTINCT ON (
        COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model
      )
        h.hour_start, h.source, h.model,
        h.total_tokens, h.input_tokens, h.output_tokens,
        h.cached_input_tokens, h.cache_creation_input_tokens,
        h.reasoning_output_tokens, h.conversations
      FROM base h
      LEFT JOIN public.tokentracker_device_machine dm ON dm.device_id = h.device_id
      WHERE h.source NOT IN ('cursor', 'trae-cn')
        AND h.device_id = ANY(p_device_ids)
      ORDER BY COALESCE(dm.machine_cluster_id, h.device_id::text),
        h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) mac

    UNION ALL

    SELECT d.hour_start, d.source, d.model,
      d.total_tokens, d.input_tokens, d.output_tokens,
      d.cached_input_tokens, d.cache_creation_input_tokens,
      d.reasoning_output_tokens, d.conversations
    FROM (
      SELECT DISTINCT ON (h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens, h.input_tokens, h.output_tokens,
        h.cached_input_tokens, h.cache_creation_input_tokens,
        h.reasoning_output_tokens, h.conversations
      FROM base h
      WHERE h.source = 'cursor'
      ORDER BY h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) d

    UNION ALL

    SELECT s.bucket_start, s.source, s.model,
      SUM(s.total_tokens)::bigint, SUM(s.input_tokens)::bigint,
      SUM(s.output_tokens)::bigint, SUM(s.cached_input_tokens)::bigint,
      SUM(s.cache_creation_input_tokens)::bigint,
      SUM(s.reasoning_output_tokens)::bigint, COUNT(*)::bigint
    FROM public.tokentracker_account_session_states s
    WHERE s.user_id = p_user_id
      AND s.bucket_start >= p_from AND s.bucket_start < p_to
      AND s.source = 'trae-cn'
    GROUP BY s.bucket_start, s.source, s.model
  ), located AS (
    SELECT
      CASE p_trunc
        WHEN 'hour' THEN to_char(date_trunc('hour', local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day' THEN to_char(date_trunc('day', local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      source, model,
      public.leaderboard_pricing_tier(model, hour_start) AS pricing_tier,
      total_tokens, input_tokens, output_tokens, cached_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, conversations
    FROM hourly CROSS JOIN tzr
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN tzr.tz IS NOT NULL THEN hour_start AT TIME ZONE tzr.tz
        WHEN p_offset_min IS NOT NULL
          THEN (hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min)
        ELSE hour_start AT TIME ZONE 'UTC'
      END AS local_ts
    ) local_time
  ), grouped AS (
    SELECT bucket, source, model, pricing_tier,
      SUM(total_tokens)::bigint AS total_tokens,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint AS reasoning_output_tokens,
      SUM(conversations)::bigint AS conversations
    FROM located
    GROUP BY bucket, source, model, pricing_tier
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(grouped.*) ORDER BY bucket, source, model, pricing_tier),
    '[]'::jsonb
  ) FROM grouped
$func$;

REVOKE ALL ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped(
  uuid, uuid[], timestamptz, timestamptz, text, text, integer
) TO project_admin;

CREATE OR REPLACE FUNCTION public.user_badges_refresh()
RETURNS bigint
LANGUAGE plpgsql
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '120s'
AS $func$
DECLARE
  v_through timestamptz;
  v_upserted bigint;
BEGIN
  -- Concurrency/throttle guard — reuse the leaderboard claim primitive with a
  -- dedicated key. Anything other than true means another attempt claimed the
  -- window recently: skip (the refresh is idempotent; next tick catches up).
  IF public.leaderboard_refresh_try_claim('badges', 300) IS DISTINCT FROM true THEN
    RETURN 0;
  END IF;

  SELECT m.through INTO v_through
  FROM tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1;
  v_through := COALESCE(v_through, '-infinity'::timestamptz);

  WITH
  -- (user, source, model, day): rollup base + live tail. The watermark sits on
  -- a UTC midnight, so no hourly bucket spans the cut — base + tail is exactly
  -- the deduped full history.
  usm AS (
    SELECT x.user_id, x.source, x.model, x.day,
           SUM(x.total_tokens)  AS tokens,
           SUM(x.output_tokens) AS output_tokens
    FROM (
      SELECT r.user_id, r.source, r.model, r.day, r.total_tokens, r.output_tokens
      FROM tokentracker_leaderboard_rollup_daily_v2 r
      WHERE r.day < (v_through AT TIME ZONE 'UTC')::date
      UNION ALL
      SELECT t.user_id, t.source, t.model,
             (t.hour_start AT TIME ZONE 'UTC')::date AS day, t.total_tokens, t.output_tokens
      FROM leaderboard_hourly_dedup_v2(v_through, now()) t
    ) x
    GROUP BY x.user_id, x.source, x.model, x.day
  ),
  -- Active day := any tokens that UTC day.
  daily AS (
    SELECT user_id, day, SUM(tokens) AS tokens, SUM(output_tokens) AS output_tokens
    FROM usm
    GROUP BY user_id, day
    HAVING SUM(tokens) > 0
  ),
  base AS (
    SELECT user_id,
           SUM(tokens)                    AS total_tokens,
           SUM(output_tokens)             AS output_tokens,
           COUNT(*)                       AS active_days,
           -- Weekend := Saturday/Sunday of the UTC day bucket. Local weekends
           -- shift by a few hours per timezone; at day grain that only blurs
           -- the edges, and no timezone context exists cloud-side.
           COUNT(*) FILTER (WHERE EXTRACT(isodow FROM day) IN (6, 7)) AS weekend_days,
           MIN(day)                       AS first_day,
           (current_date - MIN(day))      AS veteran_days,
           MAX(tokens)                    AS max_day_tokens
    FROM daily
    GROUP BY user_id
  ),
  best_day AS (
    SELECT DISTINCT ON (user_id) user_id, day AS best_day
    FROM daily
    ORDER BY user_id, tokens DESC, day ASC
  ),
  -- Longest streak: gaps-and-islands (day minus row_number is constant within
  -- a consecutive run).
  islands AS (
    SELECT user_id, grp, COUNT(*) AS len, MIN(day) AS run_start, MAX(day) AS run_end
    FROM (
      SELECT user_id, day,
             day - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY day))::int AS grp
      FROM daily
    ) g
    GROUP BY user_id, grp
  ),
  streaks AS (
    SELECT DISTINCT ON (user_id) user_id, len AS longest_streak, run_start, run_end
    FROM islands
    ORDER BY user_id, len DESC, run_end DESC
  ),
  -- Max week-over-week growth over ADJACENT ISO weeks (prev_wk = wk - 7 is
  -- load-bearing: LAG alone returns the previous ACTIVE week, which may be
  -- months earlier). Prior week must clear a 10M floor to count. A partial
  -- current week can only understate the ratio — no false positives.
  weekly AS (
    SELECT user_id, date_trunc('week', day)::date AS wk, SUM(tokens) AS wtok
    FROM daily
    GROUP BY user_id, date_trunc('week', day)::date
  ),
  momentum AS (
    SELECT DISTINCT ON (user_id) user_id,
           (wtok::numeric / prev_wtok::numeric) AS max_wow,
           wk AS wow_week
    FROM (
      SELECT user_id, wk, wtok,
             LAG(wk)   OVER (PARTITION BY user_id ORDER BY wk) AS prev_wk,
             LAG(wtok) OVER (PARTITION BY user_id ORDER BY wk) AS prev_wtok
      FROM weekly
    ) w
    WHERE prev_wk = wk - 7 AND prev_wtok >= 10000000
    ORDER BY user_id, (wtok::numeric / prev_wtok::numeric) DESC
  ),
  variety AS (
    SELECT user_id,
           COUNT(DISTINCT model)  AS models,
           COUNT(DISTINCT source) AS sources
    FROM usm
    WHERE tokens > 0
    GROUP BY user_id
  ),
  -- trendsetter: models this user first touched within 7 days of the model's
  -- GLOBAL debut. Two guards: a >=5 distinct-user floor (private/BYO model
  -- strings would otherwise self-debut and auto-qualify their only user) and
  -- a 30-day dataset burn-in (at data start every model "debuts" at once).
  model_debut AS (
    SELECT model, MIN(day) AS debut
    FROM usm
    GROUP BY model
    HAVING COUNT(DISTINCT user_id) >= 5
       AND MIN(day) >= (SELECT MIN(day) + 30 FROM usm)
  ),
  trend AS (
    SELECT uf.user_id, COUNT(*) AS early_models
    FROM (
      SELECT user_id, model, MIN(day) AS first_day
      FROM usm GROUP BY user_id, model
    ) uf
    JOIN model_debut d USING (model)
    WHERE uf.first_day <= d.debut + 7
    GROUP BY uf.user_id
  ),
  fav AS (
    SELECT DISTINCT ON (user_id) user_id, model AS favorite_model
    FROM (
      SELECT user_id, model, SUM(tokens) AS t
      FROM usm GROUP BY user_id, model
    ) m
    ORDER BY user_id, t DESC
  ),
  -- Current rank from the newest total-period snapshot window (sampled; the
  -- monotonic upsert turns samples into best-ever).
  cur_rank AS (
    SELECT s.user_id, MIN(s.rank) AS rank
    FROM tokentracker_leaderboard_snapshots s
    WHERE s.period = 'total'
      AND s.to_day = (SELECT MAX(to_day) FROM tokentracker_leaderboard_snapshots
                      WHERE period = 'total')
    GROUP BY s.user_id
  ),
  facts AS (
    SELECT b.user_id,
           b.total_tokens, b.output_tokens, b.max_day_tokens, bd.best_day,
           b.active_days, b.weekend_days, b.first_day, b.veteran_days,
           s.longest_streak, s.run_start, s.run_end,
           mo.max_wow, mo.wow_week,
           v.models, v.sources, f.favorite_model,
           t.early_models,
           r.rank AS current_rank
    FROM base b
    LEFT JOIN best_day bd USING (user_id)
    LEFT JOIN streaks  s  USING (user_id)
    LEFT JOIN momentum mo USING (user_id)
    LEFT JOIN variety  v  USING (user_id)
    LEFT JOIN fav      f  USING (user_id)
    LEFT JOIN trend    t  USING (user_id)
    LEFT JOIN cur_rank r  USING (user_id)
  )
  INSERT INTO tokentracker_user_badges AS ub
    (user_id, badge_id, tier, metric_value, meta,
     bronze_at, silver_at, gold_at, diamond_at, updated_at)
  SELECT f.user_id, c.badge_id, ev.tier, m.val, m.meta,
         CASE WHEN ev.tier >= 1 THEN now() END,
         CASE WHEN ev.tier >= 2 THEN now() END,
         CASE WHEN ev.tier >= 3 THEN now() END,
         CASE WHEN ev.tier >= 4 THEN now() END,
         now()
  FROM facts f
  CROSS JOIN LATERAL (VALUES
    ('token_titan',     f.total_tokens::numeric,   '{}'::jsonb),
    ('big_day',         f.max_day_tokens::numeric, jsonb_build_object('date', f.best_day)),
    ('wordsmith',       f.output_tokens::numeric,  '{}'::jsonb),
    ('marathoner',      f.active_days::numeric,    '{}'::jsonb),
    ('streak',          f.longest_streak::numeric, jsonb_build_object('run_start', f.run_start, 'run_end', f.run_end)),
    ('weekend_warrior', f.weekend_days::numeric,   '{}'::jsonb),
    ('momentum',        f.max_wow,                 jsonb_build_object('week', f.wow_week)),
    ('polyglot',        f.models::numeric,         jsonb_build_object('favorite_model', f.favorite_model)),
    ('trendsetter',     f.early_models::numeric,   '{}'::jsonb),
    ('multitool',       f.sources::numeric,        '{}'::jsonb),
    ('podium',          f.current_rank::numeric,   '{}'::jsonb),
    ('veteran',         f.veteran_days::numeric,   jsonb_build_object('first_day', f.first_day))
  ) AS m(badge_id, val, meta)
  JOIN tokentracker_badge_catalog c ON c.badge_id = m.badge_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN m.val IS NULL THEN 0
      WHEN c.lower_is_better THEN CASE
        WHEN m.val <= c.diamond THEN 4
        WHEN m.val <= c.gold    THEN 3
        WHEN m.val <= c.silver  THEN 2
        WHEN m.val <= c.bronze  THEN 1
        ELSE 0 END
      ELSE CASE
        WHEN m.val >= c.diamond THEN 4
        WHEN m.val >= c.gold    THEN 3
        WHEN m.val >= c.silver  THEN 2
        WHEN m.val >= c.bronze  THEN 1
        ELSE 0 END
      END AS tier
  ) ev
  -- momentum/podium have no value until a qualifying week / a rank exists;
  -- skip those rows (the dashboard renders missing rows as locked at zero).
  WHERE m.val IS NOT NULL
  ON CONFLICT (user_id, badge_id) DO UPDATE SET
    -- MONOTONIC: tier only ever ratchets up.
    tier = GREATEST(ub.tier, EXCLUDED.tier),
    -- podium keeps the best-ever (lowest) rank; every other metric is a
    -- whole-history aggregate and simply takes the latest computation.
    metric_value = CASE
      WHEN (SELECT lower_is_better FROM tokentracker_badge_catalog cc
            WHERE cc.badge_id = ub.badge_id)
        THEN LEAST(ub.metric_value, EXCLUDED.metric_value)
      ELSE EXCLUDED.metric_value END,
    meta = ub.meta || EXCLUDED.meta,
    -- First-achieved timestamps: set once, never overwritten.
    bronze_at  = COALESCE(ub.bronze_at,  EXCLUDED.bronze_at),
    silver_at  = COALESCE(ub.silver_at,  EXCLUDED.silver_at),
    gold_at    = COALESCE(ub.gold_at,    EXCLUDED.gold_at),
    diamond_at = COALESCE(ub.diamond_at, EXCLUDED.diamond_at),
    updated_at = now();

  GET DIAGNOSTICS v_upserted = ROW_COUNT;
  RETURN v_upserted;
END
$func$;

REVOKE EXECUTE ON FUNCTION public.user_badges_refresh() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_badges_refresh() TO project_admin;
