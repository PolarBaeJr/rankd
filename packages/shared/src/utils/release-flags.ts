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
// 00276, 00309), the ladder fix (00316) asks ladder_doubles_points, and the
// minute job that applies a group's time cap (00331) asks group_time_cap. 00317
// is not switched in the database: two service-role helpers that only
// add_on_the_spot calls, so that switch covers them. A switch here that no
// function asks is console-only. Each of these migrations has a down script in
// supabase/rollbacks, never run automatically.
//
// THE PLAYER APP READS THE ROW TOO, since the event standard (00324 to 00326):
// apps/player/src/lib/release-flags.ts, the same rule, for the attendance
// policy, the entry restriction and the confirmation. Those eight switches are
// app-only: no function asks them.
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
    since: '1.2.0',
  },
  {
    id: 'auto_call_skips_absent',
    label: 'Auto-call skips absent teams',
    description: 'Auto-call and the NEXT badge pass over a no-show, and a team still only registered once others have checked in.',
    off: 'Off: the next match in the order is called whoever is in it.',
    since: '1.2.0',
  },
  {
    id: 'check_in_after_draw',
    label: 'Check-in after the draw',
    description: 'Check-in and its undo stay open while the event is drawn and playing, and the stage 1 draw takes only the checked-in entries once check-in is in use.',
    off: 'Off: the Check-In tab locks at the draw, an undo is taken only during check-in, and the draw takes everyone registered or checked in.',
    since: '1.2.0',
  },
  {
    id: 'late_placement_picker',
    label: 'Late entry group picker',
    description: 'A late entry is placed through a dialog that picks its group and court.',
    off: 'Off: one button places a late entry in the group the console picks, on that group\'s courts.',
    since: '1.2.0',
  },
  {
    id: 'did_not_come',
    label: 'Did not come',
    description: 'Did not come marks a no-show and voids the entry\'s unplayed matches, from the group table and from the Check-In tab once play starts.',
    off: 'Off: no Did not come button, and the Check-In tab\'s X marks a plain no-show.',
    since: '1.2.0',
  },
  {
    id: 'void_unplayed',
    label: 'Void unplayed matches',
    description: 'Void unplayed, per stage and per group, voids the matches not yet played.',
    off: 'Off: no bulk void; each match is voided on its own.',
    since: '1.2.0',
  },
  {
    id: 'auto_close_tournament',
    label: 'Last event closes the tournament',
    description: 'Finalising the last open event completes the tournament, and the tournament-level close is Close without results while events are open.',
    off: 'Off: finalising never closes the tournament; Mark Completed and Finalise Events and Complete are back.',
    since: '1.2.0',
  },
  {
    id: 'placings_skip_never_played',
    label: 'Never drawn, never placed',
    description: 'An entry that was never drawn gets no place and no ladder points.',
    off: 'Off: an entry never drawn is placed at the bottom by seed and gets the points for that place, as before.',
    since: '1.2.0',
  },
  {
    id: 'add_on_the_spot',
    label: 'Add on the spot',
    description: 'The desk adds a member or a guest on the spot, checked in, with an optional event fee.',
    off: 'Off: no Add on the spot; entries are added from the Participants tab as before.',
    since: '1.2.0',
  },
  {
    id: 'quiet_refresh',
    label: 'Quiet live refresh',
    description: 'The event page and My courts check for a change every few seconds and re-read only when there is one, and never while someone is typing, has a dialog or menu open, or is saving.',
    off: 'Off: the event page and My courts re-read every 15 seconds, and on every live update, whatever is on screen.',
    since: '1.2.0',
  },
  {
    id: 'near_duplicate_order',
    label: 'Hold near-duplicate SFU Rec orders',
    description: 'A read SFU Rec receipt whose order number is one digit off one already used is held for an exec instead of confirming itself.',
    off: 'Off: only the exact same order number is caught; one a digit off confirms itself.',
    since: '1.1.8',
  },
  // Asked by the database only: 00316 (the ladder fix) reads it through
  // release_flag_on, on its own branch.
  {
    id: 'ladder_doubles_points',
    label: 'Ladder counts doubles points',
    description: 'The ladder counts a member\'s doubles points as well as their singles points.',
    off: 'Off: the ladder counts singles points only, as before.',
    since: '1.2.0',
  },
  // The event standard (00324 to 00326). App-only: no function asks these.
  {
    id: 'attendance_policy_ack',
    label: 'Attendance policy at sign-up',
    description: 'Entering an event or joining its waitlist shows the attendance policy and asks the member to accept it.',
    off: 'Off: no policy text and no acceptance asked at sign-up, and Discord takes entries again.',
    since: '1.2.0',
  },
  {
    id: 'attendance_warnings',
    label: 'Attendance warnings',
    description: 'A no-show or leaving without telling the desk writes a warning on the member, shown on their player page.',
    off: 'Off: no warning is written, and the Left without telling us button is hidden.',
    since: '1.2.0',
  },
  {
    id: 'entry_restriction',
    label: 'Entry restrictions',
    description: 'An exec can restrict a member from entering events, and the member\'s own entry and waitlist join are refused while it lasts.',
    off: 'Off: nothing is refused at entry, and a new restriction cannot be made.',
    since: '1.2.0',
  },
  {
    id: 'checkin_cutoff_default',
    label: 'Check-in closes before the start',
    description: 'A new event\'s check-in closes 15 minutes before the tournament starts, and the windows editor offers that time.',
    off: 'Off: a new event gets no check-in close of its own, as before.',
    since: '1.2.0',
  },
  {
    id: 'entry_confirmation',
    label: 'Confirm your place',
    description: 'Members entered in an event that asks for it are emailed, pushed and shown a banner to confirm their place before the day, and an entry nobody confirmed goes to the waitlist.',
    off: 'Off: nothing is sent or released, Confirm is refused, and the banners are hidden.',
    since: '1.2.0',
  },
  {
    id: 'fill_empty_places',
    label: 'Fill empty places at check-in',
    description: 'When check-in closes the desk releases the no-shows, then fills their places from the reserves, then from the execs.',
    off: 'Off: no release of no-shows, no reserve check-in and no exec fill on the Check-In tab.',
    since: '1.2.0',
  },
  {
    id: 'event_standard_defaults',
    label: 'Standard event defaults',
    description: 'A new event starts as pools then placement, with the waitlist on and confirmation asked.',
    off: 'Off: a new event starts as single elimination, with the waitlist off and no confirmation, as before.',
    since: '1.2.0',
  },
  {
    id: 'day_lead',
    label: 'Day lead',
    description: 'A tournament names the one exec who makes the calls on the day, shown on its page.',
    off: 'Off: the day lead is hidden and cannot be saved.',
    since: '1.2.0',
  },
  {
    id: 'substitutions',
    label: 'Substitutions',
    description: 'The desk or the day lead can put somebody in for one member of a team, or for a whole entry, before or during an event. Played matches keep who played them.',
    off: 'Off: no Sub action, substitutions refused.',
    since: '1.2.0',
  },
  // Event day, wave 2 (00329 onward).
  {
    id: 'decided_off_court',
    label: 'Decided off court',
    description: 'The desk or a court helper records a match the two sides settled without playing: the winner advances, no scores are kept and nobody\'s rating moves.',
    off: 'Off: no Decided off court option; a result needs a score.',
    since: '1.2.0',
  },
  {
    id: 'injury_retirement',
    label: 'Retired',
    description: 'A match a side stopped part way through is recorded with the games so far and who retired, rated as a walkover, and the side that retired can leave the event injured in the same step.',
    off: 'Off: no Retired option; a retirement is a walkover or a void, as before.',
    since: '1.2.0',
  },
  {
    id: 'late_arrival_reinstate',
    label: 'Late arrival after release',
    description: 'A member whose place was released at check-in close and who then arrives is reinstated while the place is free, or put back on the reserves when it is not. Their no-show warning is rescinded only when reinstated.',
    off: 'Off: no Reinstate or Back to the reserves; a latecomer comes back only through Add on the spot.',
    since: '1.2.0',
  },
  {
    id: 'group_time_cap',
    label: 'Group time cap',
    description: 'The desk sets a time on a groups stage, a pool or one group; from then no new match of it starts, the ones on court finish, and its table stands. Read by the minute job in the database as well.',
    off: 'Off: no cap control; the automatic sweep does nothing and no group is locked.',
    since: '1.2.0',
  },
  {
    id: 'merge_thin_groups',
    label: 'Merge thin groups',
    description: 'A group left with one or two teams before it plays is offered a merge into another group of its pool, as one round robin of everyone still in both.',
    off: 'Off: no merge suggestion; the merge action refuses.',
    since: '1.2.0',
  },
  {
    id: 'results_post',
    label: 'Top 4 announced',
    description: 'Finalizing an event posts one short announcement of its top 4, which also goes to Discord, and sends the Marketing holders the same lines to copy. A re-finalize edits that announcement.',
    off: 'Off: finalizing posts nothing and sends no Marketing notice.',
    since: '1.2.0',
  },
  {
    id: 'social_posts',
    label: 'Social posts',
    description: 'Meet the teams, New teams and draw slides for Instagram, with a caption to copy, on the event\'s Social posts page. New teams added within 10 minutes share one notice to the Marketing holders.',
    off: 'Off: no Social posts notices; the page and its images are not found.',
    since: '1.2.0',
  },
  {
    id: 'generate_teams',
    label: 'Generate teams',
    description: 'The Teams screen on a doubles event: generate teams from the unpaired pool days before, preview and confirm them, tell both members who they are paired with, add, edit or split a team by hand, and re-pair orphans. A re-run keeps the published teams.',
    off: 'Off: the Teams screen is hidden and its actions refuse; pairing is the existing buttons.',
    since: '1.2.0',
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
