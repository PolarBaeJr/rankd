import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 00182 inverted the default on public.players: a member may write the columns
 * the grant names and nothing else. That only stays true if somebody notices
 * when a column is added.
 *
 * Nothing in the running app reads this list, so a stale one would never show
 * up as a failure anywhere else — which is the whole reason for the test. It
 * asserts one thing: EVERY column on players is classified, either as
 * self-service (in the migration's GRANT) or as service-role-only (named
 * below). Add a column and regenerate the types, and this fails until you have
 * decided which side it is on.
 *
 * The migration is the source of truth for the granted set; it is parsed rather
 * than copied so the two cannot drift apart.
 */

const REPO_ROOT = join(__dirname, '../../../..');

/**
 * Columns only the service role, a SECURITY DEFINER function, or the console
 * may move. Several of them DO change because of something a member did — the
 * member just is not the one writing them:
 *
 *   notification_preferences  merge_my_notification_preferences (00180)
 *   skill_tier                apply_skill_tier_seed (00127)
 *   passkey_setup             recordPasskeySetup, service role
 *   deletion_requested_at     deleteMyAccount, service role
 *   active_flag               deleteMyAccount / restoreMyAccount, service role
 *   tours_seen                mark_tour_seen (00246), service role
 *   media_consent             set_my_media_consent (00255), owner-run
 *   media_consent_changed_at  stamp_media_consent_changed_at (00255) trigger
 *   last_seen_at              touch_last_seen (00320), owner-run
 *
 * full_name is generated (00023) and cannot be written by anybody.
 */
const SERVICE_ROLE_ONLY = [
  'active_flag',
  'ban_reason',
  'banned_at',
  'banned_by',
  'created_at',
  'deletion_requested_at',
  'eligibility_flag',
  'elo_review',
  'email',
  // 00225. Note it sits apart from exec_bio, which IS self-service and is
  // granted: the officer writes their own blurb on /exec, but whether that
  // card appears at all is the club's call, not theirs.
  'exec_hidden',
  'exec_photo_url',
  'exec_title',
  'fee_exempt',
  'full_name',
  'id',
  'inactive_since',
  'inactivity_notice_sent_at',
  'is_banned',
  'is_exec',
  'is_trainer',
  'joined_at',
  // 00320. Written only by touch_last_seen() as the owner, for the caller.
  'last_seen_at',
  // 00255. Written only by set_my_media_consent() as the owner, with the
  // timestamp stamped by a trigger, and no member SELECT grant either.
  'media_consent',
  'media_consent_changed_at',
  'member_code',
  'membership_type',
  'notification_preferences',
  'passkey_setup',
  'permission_baseline_id',
  'permission_grants',
  'permission_revokes',
  'permission_role',
  'privilege_claim_review',
  'profile_visibility',
  'role',
  'show_activity_status',
  'skill_tier',
  'status',
  // 00246. Stamped by mark_tour_seen(), called by the service role when a
  // member or exec finishes or skips a guided tour.
  'tours_seen',
  'updated_at',
  'user_id',
  'waiver_reset_at',
] as const;

function grantedColumns(): string[] {
  const sql = readFileSync(
    join(REPO_ROOT, 'supabase/migrations/00182_players_self_service_columns.sql'),
    'utf8',
  );
  const match = sql.match(/GRANT UPDATE \(([^)]*)\) ON public\.players TO authenticated;/);
  if (!match) throw new Error('00182 no longer contains a GRANT UPDATE (...) ON public.players');
  return match[1]!
    .split(',')
    .map((c) => c.replace(/--.*$/gm, '').trim())
    .filter(Boolean)
    .sort();
}

function playersColumns(): string[] {
  const types = readFileSync(
    join(REPO_ROOT, 'packages/shared/src/types/database.gen.ts'),
    'utf8',
  );
  const start = types.indexOf('      players: {');
  if (start < 0) throw new Error('database.gen.ts has no players table');
  const updateStart = types.indexOf('        Update: {', start);
  const updateEnd = types.indexOf('        Relationships:', updateStart);
  const body = types.slice(updateStart, updateEnd);
  return [...body.matchAll(/^ {10}(\w+)\??:/gm)].map((m) => m[1]!).sort();
}

describe('players self-service grant (00182, audit F-011)', () => {
  it('every column is classified as self-service or service-role-only', () => {
    const classified = new Set([...grantedColumns(), ...SERVICE_ROLE_ONLY]);
    const unclassified = playersColumns().filter((c) => !classified.has(c));
    expect(
      unclassified,
      'New players column(s) with no decision about whether a member may write them. '
        + 'Add each to SERVICE_ROLE_ONLY here, or to the GRANT UPDATE list in a new migration '
        + 'and then here — never leave it unclassified.',
    ).toEqual([]);
  });

  it('nothing is on both sides of the line', () => {
    const service = new Set<string>(SERVICE_ROLE_ONLY);
    expect(grantedColumns().filter((c) => service.has(c))).toEqual([]);
  });

  it('the granted set is exactly what the player app writes with a member session', () => {
    // Kept as a literal on purpose: if this list changes, the change should be
    // deliberate and reviewed, not absorbed by a parse.
    expect(grantedColumns()).toEqual([
      'avatar_url',
      'bio',
      'competition_category',
      'display_name',
      'exec_bio',
      'first_name',
      'handle',
      'hide_from_leaderboard',
      'last_active_at',
      'last_name',
      'onboarding_completed',
      'phone',
    ]);
  });
});
