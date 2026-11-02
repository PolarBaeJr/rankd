import { consoleAccessLevelFor, permissionsOf, permits } from '@badminton/shared';

type Capability = Parameters<typeof permits>[2];
import type { createServiceRoleClient } from '@/lib/supabase-server';

// Gate 2 for the officer-facing Discord routes, in one place.
//
// THE SERVICE SECRET IS NOT THE GATE. It proves the request came from the bot
// and says nothing about who typed the command: every member's slash command
// arrives with the same bearer token, and `default_member_permissions: '0'` on
// the command is a picker filter rather than authorization. So the CALLER'S
// Discord id is resolved to a club account here and that account is asked for
// `players.discordlink.write`, which is the same capability the console's
// force-link panel requires, through the same resolver, so the two cannot
// drift.
//
// WHY THE SAME CAPABILITY COVERS UNLINKING AND RESYNCING, and why no new
// permission string was invented for either: it is the same table, the same
// row and the inverse write, and capability-gates.ts already stretches this
// capability past "link" to cover READING the link row on exactly that
// reasoning. A new string would need a players_permission_vocabulary_check
// migration, and migrations here are owner-run.
//
// DELIBERATELY NOT WIRED INTO force-link/route.ts. That route carries the same
// body inline and its own header blesses the duplication; it is a live security
// path and moving it onto this helper is a separate change with its own
// review. The consolidation is a follow-up, not part of this one.

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

/**
 * The whole permission triple, plus standing. Selected WHOLE for the reason the
 * select below gives, and named here so the shape and the query stay together.
 */
export interface OfficerPlayer {
  id: string;
  role: string | null;
  is_exec: boolean | null;
  is_trainer: boolean | null;
  is_banned: boolean | null;
  status: string | null;
  active_flag: boolean | null;
  permission_role: string | null;
  permission_grants: string[] | null;
  permission_revokes: string[] | null;
}

/**
 * Why the caller was turned away.
 *
 * `unavailable` is NOT a refusal the officer can act on: it means the read
 * itself failed, and every caller answers it with a named 503 rather than
 * folding it into `not_linked`. See the branch below for why that distinction
 * has teeth.
 */
export type OfficerRefusal = 'not_linked' | 'not_permitted' | 'unavailable';

export type OfficerCheck =
  | { ok: true; player: OfficerPlayer }
  | { ok: false; refusal: OfficerRefusal };

/**
 * Resolve the officer who typed the command, and decide whether they may.
 *
 * `discordUserId` IS THE CALLER, never the account being acted on. Passing the
 * target here would ask the app whether the member being unlinked is allowed to
 * unlink themselves, which is the whole gate inverted.
 */
export async function resolveDiscordOfficer(
  supabase: ServiceClient,
  discordUserId: string,
  // The console capability the action needs. Linking is the default; /setup
  // and /config ask for the settings capability (discord-manager.ts).
  capability: Capability = 'players.discordlink.write'
): Promise<OfficerCheck> {
  // The permission triple is selected WHOLE: permissionsOf() throws on a row
  // that carries permission_role without both delta columns, rather than
  // resolving somebody wider than they are. Narrowing this select is how that
  // throw gets reached.
  const { data: link, error: linkError } = await supabase
    .from('player_discord_links')
    .select(
      'player_id, players!inner(id, role, is_exec, is_trainer, is_banned, status, ' +
        'active_flag, permission_role, permission_grants, permission_revokes)'
    )
    .eq('discord_user_id', discordUserId)
    .maybeSingle();

  if (linkError) {
    // NAMED, never degraded to "no link". A failed PostgREST read arrives as
    // data:null with an error rather than throwing, and reading that as an
    // unlinked caller would tell an exec to run /link, which they already have,
    // and which would then refuse them as already linked.
    console.error('[discord] officer read failed:', linkError.message);
    return { ok: false, refusal: 'unavailable' };
  }

  // createServiceRoleClient is not generic over Database, so the embedded row
  // arrives untyped. Annotated once, here, at the boundary: the same shape the
  // force-link route names for the same join.
  const player = ((link as unknown as { players?: unknown } | null)?.players ??
    null) as OfficerPlayer | null;

  // THE CALLER'S OWN LINK IS THE ONLY CLUB IDENTITY THE BOT HAS. An officer
  // whose own Discord account is not connected has no club account for the
  // capability check to ask about, and no amount of Discord permission changes
  // that. None of these commands can ever be the recovery path for an unlinked
  // officer fixing themselves.
  if (!player) return { ok: false, refusal: 'not_linked' };

  // Standing first, then level: consoleAccessLevelFor is the composition the
  // console itself enforces, so a banned or suspended exec is refused here for
  // the same reason they cannot open the panel.
  const level = consoleAccessLevelFor(player);
  if (!level) return { ok: false, refusal: 'not_permitted' };
  if (!permits(level, permissionsOf(level, player), capability)) {
    return { ok: false, refusal: 'not_permitted' };
  }

  return { ok: true, player };
}
