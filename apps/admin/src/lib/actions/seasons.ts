'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, seasonFeeSchema, seasonCreateSchema, ExpectedError, clubToday, type SeasonFeeInput, type SeasonCreateInput } from '@badminton/shared';
import { requireCapability } from './_shared';

// term + year are the real inputs, not a name. seasons.name is DERIVED from them
// by trg_set_season_name (00043) so it can never drift from the pair.
//
// This used to send only a free-text `name`, leaving term and year null — and
// both are NOT NULL with no default, so creating a season failed with a not-null
// violation every time. It went unnoticed because the club has had exactly one
// season, created before 00043 added the columns.
export async function createSeason(data: SeasonCreateInput) {
  const input = parseOrThrow(seasonCreateSchema, data);
  const admin = await requireCapability('seasons.create.write');
  const adminClient = createAdminClient();

  const { data: season, error } = await adminClient.from('seasons').insert({
    term: input.term,
    year: input.year,
    start_date: input.start_date,
    end_date: input.end_date || null,
    active_flag: false,
    // name deliberately omitted — the trigger writes it from term/year. Sending
    // one here would be overwritten anyway, so passing it would only create a
    // second, disagreeing source of truth.
  }).select().single();

  if (error) {
    // seasons_term_year_unique (00043): one season per term per year, because
    // two "Fall 2026" rows would split that season's matches across both.
    if (error.code === '23505') {
      throw new ExpectedError(`${input.term[0]!.toUpperCase()}${input.term.slice(1)} ${input.year} already exists.`);
    }
    throw new Error(error.message);
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_created',
    target_type: 'season',
    target_id: season.id,
    new_value: data,
  });

  revalidatePath('/seasons');
}

// A typed reason, checked here rather than in @badminton/shared's schemas.
//
// The console's rule is that every audited action carries one, and audit_logs
// already has the column — `logAdminAudit` takes `reason`, and voidMatch,
// removePlayer and approvePlayer all fill it. The two writes below did not, so
// the log recorded that a season's fees changed and never why. A trimmed length
// floor is the point: "." satisfies `required` on the client and tells the next
// reader nothing.
const REASON_MIN = 5;

function requireReason(reason: string, what: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) {
    throw new ExpectedError(`${what} needs a reason of at least ${REASON_MIN} characters.`);
  }
  return trimmed;
}

export async function updateSeasonFees(seasonId: string, fees: SeasonFeeInput, reason: string) {
  parseOrThrow(seasonFeeSchema, fees);
  const why = requireReason(reason, 'Changing a season’s fees');
  const admin = await requireCapability('seasons.fees.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient
    .from('seasons')
    .select('competitive_fee_cents, recreational_fee_cents')
    .eq('id', seasonId)
    .single();

  const { error } = await adminClient
    .from('seasons')
    .update({
      competitive_fee_cents: fees.competitive_fee_cents,
      recreational_fee_cents: fees.recreational_fee_cents,
    })
    .eq('id', seasonId);
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_fees_updated',
    target_type: 'season',
    target_id: seasonId,
    old_value: old,
    new_value: fees,
    reason: why,
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
  revalidatePath('/finances');
}

export type SeasonEloPolicy = 'carry' | 'soft' | 'full';

// The most destructive write on the seasons screen, and the one that carried no
// explanation at all. Under the `full` policy activate_season resets every
// player's ELO to the ladder floor and marks them provisional again; under
// `soft` it compresses the whole ladder. Closing a season only stamps a date and
// now takes a reason — this taking none was the wrong way round.
// Both arguments are REQUIRED rather than defaulted: a default reason is a
// reason nobody wrote, and an optional one would let a call site drop it and
// only fail at runtime. The type system names every caller instead.
export async function setActiveSeason(
  seasonId: string,
  eloPolicy: SeasonEloPolicy,
  reason: string,
) {
  const why = requireReason(reason, 'Activating a season');
  const admin = await requireCapability('seasons.activate.write');
  const adminClient = createAdminClient();

  // Atomic: snapshot the outgoing season's ELO, switch active, apply the policy.
  // The policy only changes ratings — match history and W-L records are kept.
  const { error } = await adminClient.rpc('activate_season', {
    p_season_id: seasonId,
    p_elo_policy: eloPolicy,
  });
  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_activated',
    target_type: 'season',
    target_id: seasonId,
    new_value: { elo_policy: eloPolicy },
    reason: why,
  }, { seasonId });

  revalidatePath('/seasons');
  revalidatePath('/fees');
  revalidatePath('/finances');
}

// Closing a season freezes its ladder: every session, tournament, match and fee
// filed afterwards belongs to whatever is activated next. That is worth a
// sentence in the log, and the dialog will not send without one.
export async function endSeason(seasonId: string, reason: string) {
  const why = requireReason(reason, 'Closing a season');
  const admin = await requireCapability('seasons.end.write');
  const adminClient = createAdminClient();

  const { error } = await adminClient.from('seasons').update({
    active_flag: false,
    // The club's calendar date, not the server's UTC one. toISOString() gives
    // the UTC date, and Vancouver is UTC-7/-8 — so an exec ending a season at
    // 6pm on Friday stamped it as ending Saturday. end_date is a DATE the club
    // reads as "the day we finished", and it also bounds season reporting.
    end_date: clubToday(),
  }).eq('id', seasonId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'season_ended',
    target_type: 'season',
    target_id: seasonId,
    reason: why,
  }, { seasonId });

  revalidatePath('/seasons');
}

// Keeps a season out of the PLAYER-facing history: the leaderboard's
// past-season standings and the /my-stats season picker. 00234 has the full
// reasoning; the short version is that the archive in season_final_ratings was
// never written to be published, and Summer 2026 is a retired test season whose
// live ratings were reset while its archive was not.
//
// A PUBLICATION DECISION, NOT AN ACCOUNTING ONE. This never touches
// active_flag, end_date or a fee, and nothing that reports on money filters on
// it. Hiding a season the club actually played does not unspend what was spent
// in it, so the finance surfaces deliberately keep showing it.
//
// seasons.end.write rather than a fourth capability string. The population that
// closes a season off is the population that should decide whether it is
// published, and the permission vocabulary is CHECK-enumerated in the database
// (00232), so a new key would be a migration for a toggle used once a year.
//
// REVERSIBLE, and the console is the only thing that can reverse it: the admin
// season list shows hidden seasons and their state, precisely so that hiding
// one is not a one-way door.
export async function setSeasonHidden(seasonId: string, hidden: boolean, reason: string) {
  const why = requireReason(reason, hidden ? 'Hiding a season' : 'Unhiding a season');
  const admin = await requireCapability('seasons.end.write');
  const adminClient = createAdminClient();

  // Coerced rather than trusted. `hidden` is an exported Server Action
  // parameter, which makes it a client-controlled POST field: a caller can send
  // anything, and a string like "false" is truthy.
  const nextHidden = hidden === true;

  const { error } = await adminClient
    .from('seasons')
    .update({ hidden_flag: nextHidden })
    .eq('id', seasonId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: nextHidden ? 'season_hidden' : 'season_unhidden',
    target_type: 'season',
    target_id: seasonId,
    reason: why,
  }, { seasonId, hidden: nextHidden });

  // Both paths: /seasons renders the toggle, and the player-facing history is
  // a different app entirely, so nothing here can revalidate it. It reads the
  // flag on each request through the service role, so the next page load is
  // already correct.
  revalidatePath('/seasons');
}
