// RELEASE KILL SWITCHES: a way back to the shipped-before behaviour of a new
// console change, without a deploy, when it breaks on the day.
//
// NOT THE FEATURE SWITCHES (./features.ts). Those are member-facing, each mints
// a `page.access.<id>` capability, and an exec turns one off on purpose. These
// are for the officers running the console: each names one change from a
// release, and off puts back what the console did before it. Nothing here
// mints a capability or touches a vocabulary CHECK.
//
// One platform_settings row, key `release_flags`, holding `<id>` booleans. No
// migration seeds it: the first save inserts it (SEEDABLE_SETTINGS in the
// admin's platform-setting-fields.ts).
//
// ON UNLESS A LITERAL `false`. An absent row, an absent field, a string, a
// null, a non-object and a FAILED READ all read as on, which is the behaviour
// that shipped. Off is a decision somebody made; nothing else turns one off.
//
// ENFORCED IN THE SERVER ACTION, HIDDEN IN THE UI. A stale tab or a direct POST
// still reaches the action, so the action asks the switch itself.
//
// THE DATABASE READS THE SAME ROW. release_flag_on(p_id) (00318) has the same
// rule, and the functions 00315 restated ask it, so check_in_after_draw also
// puts the draw's field and the undo of a check-in back as they were (00272,
// 00276, 00309), and the ladder fix (00316) asks ladder_doubles_points. 00317
// is not switched in the database: two service-role helpers that only
// add_on_the_spot calls, so that switch covers them. A switch here that no
// function asks is console-only. Each of these migrations has a down script in
// supabase/rollbacks, never run automatically.
//
// Deliberately dependency-free, so a client component can import it deeply.

export interface ReleaseFlagDefinition {
  id: string;
  label: string;
  /** What the change does while on. */
  description: string;
  /** What switching it off falls back to, shown beside the switch. */
  off: string;
  /** The release the change shipped in. */
  since: string;
}

export const RELEASE_FLAGS = [
  {
    id: 'desk_helper_void',
    label: 'Void from the court card',
    description: 'A court helper, or the desk, voids the match live on a court from its card, and the court takes its next match.',
    off: 'Off: no Void on the court card or on My courts, and a void no longer calls the next match. The desk voids from the results as before.',
    since: '1.1.8',
  },
  {
    id: 'auto_call_skips_absent',
    label: 'Auto-call skips absent teams',
    description: 'Auto-call and the NEXT badge pass over a no-show, and a team still only registered once others have checked in.',
    off: 'Off: the next match in the order is called whoever is in it.',
    since: '1.1.8',
  },
  {
    id: 'check_in_after_draw',
    label: 'Check-in after the draw',
    description: 'Check-in and its undo stay open while the event is drawn and playing, and the stage 1 draw takes only the checked-in entries once check-in is in use.',
    off: 'Off: the Check-In tab locks at the draw, an undo is taken only during check-in, and the draw takes everyone registered or checked in.',
    since: '1.1.8',
  },
  {
    id: 'late_placement_picker',
    label: 'Late entry group picker',
    description: 'A late entry is placed through a dialog that picks its group and court.',
    off: 'Off: one button places a late entry in the group the console picks, on that group\'s courts.',
    since: '1.1.8',
  },
  {
    id: 'did_not_come',
    label: 'Did not come',
    description: 'Did not come marks a no-show and voids the entry\'s unplayed matches, from the group table and from the Check-In tab once play starts.',
    off: 'Off: no Did not come button, and the Check-In tab\'s X marks a plain no-show.',
    since: '1.1.8',
  },
  {
    id: 'void_unplayed',
    label: 'Void unplayed matches',
    description: 'Void unplayed, per stage and per group, voids the matches not yet played.',
    off: 'Off: no bulk void; each match is voided on its own.',
    since: '1.1.8',
  },
  {
    id: 'auto_close_tournament',
    label: 'Last event closes the tournament',
    description: 'Finalising the last open event completes the tournament, and the tournament-level close is Close without results while events are open.',
    off: 'Off: finalising never closes the tournament; Mark Completed and Finalise Events and Complete are back.',
    since: '1.1.8',
  },
  {
    id: 'placings_skip_never_played',
    label: 'Never drawn, never placed',
    description: 'An entry that was never drawn gets no place and no ladder points.',
    off: 'Off: an entry never drawn is placed at the bottom by seed and gets the points for that place, as before.',
    since: '1.1.8',
  },
  {
    id: 'add_on_the_spot',
    label: 'Add on the spot',
    description: 'The desk adds a member or a guest on the spot, checked in, with an optional event fee.',
    off: 'Off: no Add on the spot; entries are added from the Participants tab as before.',
    since: '1.1.8',
  },
  // Asked by the database only: 00316 (the ladder fix) reads it through
  // release_flag_on, on its own branch.
  {
    id: 'ladder_doubles_points',
    label: 'Ladder counts doubles points',
    description: 'The ladder counts a member\'s doubles points as well as their singles points.',
    off: 'Off: the ladder counts singles points only, as before.',
    since: '1.1.8',
  },
] as const satisfies readonly ReleaseFlagDefinition[];

export type ReleaseFlagId = (typeof RELEASE_FLAGS)[number]['id'];

export type ReleaseFlags = Record<ReleaseFlagId, boolean>;

export const RELEASE_FLAGS_SETTING_KEY = 'release_flags';

export const ALL_RELEASE_FLAGS_ON: ReleaseFlags = Object.fromEntries(
  RELEASE_FLAGS.map((f) => [f.id, true]),
) as ReleaseFlags;

/** The row a first save starts from: every switch on. */
export function defaultReleaseFlagsValue(): Record<string, boolean> {
  return { ...ALL_RELEASE_FLAGS_ON };
}

/** The stored row as a switch per change: off only for a literal `false`. */
export function parseReleaseFlags(value: unknown): ReleaseFlags {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(RELEASE_FLAGS.map((f) => [f.id, row[f.id] !== false])) as ReleaseFlags;
}

export function releaseFlagLabel(id: ReleaseFlagId): string {
  return RELEASE_FLAGS.find((f) => f.id === id)?.label ?? id;
}

/** The sentence a server action refuses with while the switch is off. */
export function releaseFlagOffMessage(id: ReleaseFlagId): string {
  return `${releaseFlagLabel(id)} is switched off for now under Kill switches. Reload the page.`;
}

// Minimal structural shape so any Supabase client in this repo fits.
type FlagsReader = { from: (table: string) => any };

/**
 * Read the switches. Never throws: a failed read logs and returns every switch
 * on, which is the shipped behaviour.
 */
export async function readReleaseFlags(client: FlagsReader): Promise<ReleaseFlags> {
  try {
    const { data, error } = await client
      .from('platform_settings')
      .select('value')
      .eq('key', RELEASE_FLAGS_SETTING_KEY)
      .maybeSingle();
    if (error) {
      console.error('[release-flags] could not read the kill switches, using all on:', error.message);
      return { ...ALL_RELEASE_FLAGS_ON };
    }
    return parseReleaseFlags(data?.value ?? null);
  } catch (err) {
    console.error('[release-flags] could not read the kill switches, using all on:', err);
    return { ...ALL_RELEASE_FLAGS_ON };
  }
}
