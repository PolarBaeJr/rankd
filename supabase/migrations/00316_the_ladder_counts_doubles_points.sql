-- ============================================================
-- 00316: THE LADDER COUNTS DOUBLES POINTS
--
-- The Tournament Points ladder summed tournament_participants.points and
-- nothing else. A doubles event writes its finish points onto the TEAM, on
-- tournament_pairs.points (finalize.ts writes to the pairs table for a doubles
-- event, and a formed pair has no participant rows since 00102). So every
-- point a member earned in doubles was stored and never reached the ladder,
-- and after a doubles-only event the Tournament Points tab was empty.
--
-- WHAT CHANGES.
--   * get_leaderboard(): tournament_points is now the member's singles
--     participant points PLUS the points of every team they were on, credited
--     in full to BOTH player1_id and player2_id. A team's points are each
--     partner's finish, not a pot to split: a doubles champion is a champion.
--     The same status filter applies to both arms: a withdrawn or disqualified
--     entry earns nothing.
--   * External teams (00269) carry NULL player ids and are left out by the
--     IS NOT NULL on each pair arm. Guests and every other non-ladder member
--     stay out the way they always did: the outer query only keeps a row that
--     joins players and ratings and passes the three visibility predicates,
--     and that part of the body is 00092's, unchanged.
--
-- BEHIND A RELEASE FLAG. The pair arms only count while
-- release_flag_on('ladder_doubles_points') is true, so the ladder can go back
-- to singles-only points without a deploy:
--   platform_settings key 'release_flags', value {"ladder_doubles_points": false}
-- turns it off. A flag is ON unless its field is literally JSON false, so a
-- missing row or a missing field leaves the new behaviour on. 00318 creates
-- the same helper with an identical body; both are CREATE OR REPLACE and
-- converge whichever runs second. The hand-run undo is
-- supabase/rollbacks/00316_down.sql, which restores 00092's body.
--
-- Same signature, so CREATE OR REPLACE and no DROP. Restated in full rather
-- than patched, because CREATE OR REPLACE FUNCTION drops any attribute it does
-- not name and this one is SECURITY DEFINER with a pinned search_path.
--
-- No BEGIN or top-level transaction end: db-migrate.sh wraps a file without
-- one in --single-transaction.
-- ============================================================

-- ---- The release flag reader --------------------------------
-- SECURITY DEFINER because platform_settings is not anon-readable and the
-- ladder renders signed out. It returns one boolean per flag name and nothing
-- else from the table.
CREATE OR REPLACE FUNCTION public.release_flag_on(p_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.platform_settings ps
    WHERE ps.key = 'release_flags'
      AND ps.value -> p_id = 'false'::jsonb
  );
$function$;

REVOKE ALL ON FUNCTION public.release_flag_on(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_flag_on(text) TO anon, authenticated, service_role;

-- ---- The ladder ---------------------------------------------
CREATE OR REPLACE FUNCTION public.get_leaderboard()
 RETURNS TABLE(
   id uuid, name text, handle text, status player_status, avatar_url text,
   singles_elo integer, doubles_elo integer,
   singles_wins integer, singles_losses integer,
   doubles_wins integer, doubles_losses integer,
   singles_provisional boolean, doubles_provisional boolean,
   current_singles_streak integer, current_doubles_streak integer,
   tournament_points integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p.id, p.full_name AS name, p.handle, p.status, p.avatar_url,
    r.singles_elo, r.doubles_elo,
    r.singles_wins, r.singles_losses, r.doubles_wins, r.doubles_losses,
    r.singles_provisional, r.doubles_provisional,
    r.current_singles_streak, r.current_doubles_streak,
    COALESCE(tp.pts, 0)::int AS tournament_points
  FROM players p
  JOIN ratings r ON r.player_id = p.id
  LEFT JOIN (
    SELECT earned.player_id, SUM(earned.points)::int AS pts
    FROM (
      SELECT tpa.player_id, tpa.points
      FROM tournament_participants tpa
      WHERE tpa.status NOT IN ('withdrawn', 'disqualified') AND tpa.points > 0
      UNION ALL
      SELECT tpr.player1_id, tpr.points
      FROM tournament_pairs tpr
      WHERE tpr.status NOT IN ('withdrawn', 'disqualified') AND tpr.points > 0
        AND tpr.player1_id IS NOT NULL
        AND (SELECT public.release_flag_on('ladder_doubles_points'))
      UNION ALL
      SELECT tpr.player2_id, tpr.points
      FROM tournament_pairs tpr
      WHERE tpr.status NOT IN ('withdrawn', 'disqualified') AND tpr.points > 0
        AND tpr.player2_id IS NOT NULL
        AND (SELECT public.release_flag_on('ladder_doubles_points'))
    ) earned
    GROUP BY earned.player_id
  ) tp ON tp.player_id = p.id
  WHERE p.active_flag = TRUE
    AND p.hide_from_leaderboard = FALSE
    AND p.status NOT IN ('pending_approval', 'suspended');
$function$;

-- REVOKE THEN GRANT, the 00225 pattern. The grant this leaves is the one the
-- function already holds: anon is granted back on purpose, because the ladder
-- and the landing page render signed out (00126 and 00131 both raise if anon
-- loses it).
REVOKE ALL ON FUNCTION public.get_leaderboard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
