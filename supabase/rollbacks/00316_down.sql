-- ============================================================
-- 00316 DOWN: the ladder goes back to singles-only points
--
-- NOT A MIGRATION. Nothing runs this file automatically; it sits outside
-- supabase/migrations on purpose. Run it by hand only to undo 00316 when the
-- release flag is not enough (the quicker off switch is
-- platform_settings key 'release_flags', {"ladder_doubles_points": false}).
--
-- It restates get_leaderboard() exactly as 00092 left it, with 00092's grant.
-- CREATE OR REPLACE rather than 00092's DROP + CREATE: the signature is the
-- same, so there is no need to drop and briefly lose the grant.
--
-- public.release_flag_on() is deliberately LEFT IN PLACE: 00318 creates the
-- same helper and other code may read it.
-- ============================================================

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
    SELECT tpa.player_id, SUM(tpa.points)::int AS pts
    FROM tournament_participants tpa
    WHERE tpa.status NOT IN ('withdrawn', 'disqualified') AND tpa.points > 0
    GROUP BY tpa.player_id
  ) tp ON tp.player_id = p.id
  WHERE p.active_flag = TRUE
    AND p.hide_from_leaderboard = FALSE
    AND p.status NOT IN ('pending_approval', 'suspended');
$function$;

GRANT EXECUTE ON FUNCTION public.get_leaderboard() TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
