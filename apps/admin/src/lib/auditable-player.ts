// What an audit row is allowed to remember about a person.
//
// FIX-LIST #17. Four admin actions read the whole player row (`select('*')`)
// and then wrote it straight into `audit_logs.old_value`:
// approvePlayer, updatePlayer and removePlayer (actions/players.ts) and
// setPlayerAccessLevel (actions/permissions.ts). `audit_logs` is permanent by
// design — 00139 made it survive the deletion of the player it is about — so
// every one of those rows is a copy of the member's email address, phone
// number, photo URL and bio, sitting in a table that the purge job does not and
// should not empty. 26 rows on production already hold an address.
//
// That is not a hypothetical: the deletion email promises, in these words, that
// "your name, email address, phone number, profile photo and bio are erased for
// good". Anonymising `players` while a full copy of the row survives in
// `audit_logs` does not keep that promise, it just moves where it is kept.
//
// WHY AN ALLOWLIST, AND WHY NOT AT THE CHOKEPOINT. logAdminAudit takes
// `old_value?: unknown` and is called with sessions, announcements, seasons and
// platform settings as well as players. A redactor there would have to guess
// from key names which values are people — and would silently gut an audit row
// for an announcement that happened to carry an organiser's address. So the
// redaction is here, applied by name at the four sites that pass a player row,
// and a value only goes through it because the caller said it was a player.
//
// The list is an ALLOWLIST because the failure modes are not symmetric. A
// denylist that misses a new identity column leaks it silently and forever; an
// allowlist that misses a new moderation column leaves a key out of an audit
// row, which is visible the first time anyone reads one. Neither is free, and
// the test next door removes most of the cost of both: it checks these two
// lists against every column `players` actually has, so a new column fails a
// test until somebody classifies it.

/**
 * Columns an audit row keeps: what the member's standing was, never who they
 * were. Every one of these is something an admin act can change or is the
 * context that makes the change legible.
 */
export const AUDITABLE_COLUMNS = [
  'id',
  'status',
  'role',
  'is_exec',
  'is_trainer',
  'exec_title',
  // 00225. An officer vanishing from the club's public page is exactly the
  // change somebody would want to be able to make quietly, so it is one an
  // admin can find afterwards.
  'exec_hidden',
  'is_banned',
  'banned_at',
  'banned_by',
  'ban_reason',
  'active_flag',
  'eligibility_flag',
  'fee_exempt',
  'membership_type',
  'competition_category',
  'member_code',
  'deletion_requested_at',
  'hide_from_leaderboard',
  'show_activity_status',
  'profile_visibility',
  'onboarding_completed',
  'joined_at',
  'created_at',
  'updated_at',
  'last_active_at',
  // 00320. When they last opened either app. Activity, not identity.
  'last_seen_at',
  'inactive_since',
  'inactivity_notice_sent_at',
  'waiver_reset_at',
  'permission_role',
  'permission_baseline_id',
  'permission_grants',
  'permission_revokes',
  // Standing, not identity: what tier the ladder seeds them at.
  'skill_tier',
  // Whether they have enrolled a passkey. Withholding it was the first instinct
  // — it describes how somebody signs in — but the sibling assertion here is
  // that WITHHELD means exactly what the purge treats as identity, and a
  // credential's existence is not identity. It is account standing, and an
  // admin looking at a locked-out member needs to see it.
  'passkey_setup',
  // 00246. Which guided tours they have seen. Harmless, and not identity.
  'tours_seen',
  // 00255. A member's own photo and video choice. Standing, not identity.
  'media_consent',
  'media_consent_changed_at',
  // The two review flags. Both exist BECAUSE an admin act left something for a
  // human to check — a roster claim that withheld privileges (00132), a merge
  // that discarded rows or found the account playing itself (00163) — so an
  // audit row that omitted them would be omitting the consequence of the very
  // action it records.
  'privilege_claim_review',
  'elo_review',
] as const;

/**
 * Columns an audit row drops, and why each one is here.
 *
 *   first_name, last_name, full_name, display_name, handle
 *                     The name, in the five columns that hold pieces of it.
 *                     `full_name` is GENERATED from the first two, so writing
 *                     one of them into a permanent log preserves it anyway.
 *   email, phone      Named in the promise. These are the 26 production rows.
 *   avatar_url, exec_photo_url
 *                     Photographs of the person.
 *   bio, exec_bio     Words they wrote about themselves.
 *   user_id           The auth identity. The purge nulls it and deletes the
 *                     auth user; keeping the uuid here would leave a join back
 *                     to `auth.audit_log_entries`, which still carries the real
 *                     email (that half is migration 00155, not this file).
 *   notification_preferences
 *                     Not identity, but personal settings no admin act changes
 *                     — there is nothing for an audit row to say about it.
 */
export const WITHHELD_COLUMNS = [
  'first_name',
  'last_name',
  'full_name',
  'display_name',
  'handle',
  'email',
  'phone',
  'avatar_url',
  'exec_photo_url',
  'bio',
  'exec_bio',
  'user_id',
  'notification_preferences',
] as const;

const KEEP = new Set<string>(AUDITABLE_COLUMNS);

/**
 * The version of a player row that may be written to `audit_logs`.
 *
 * Keys absent from the input stay absent from the output — an audit row should
 * not claim a column was read and found empty when it was never selected.
 */
export function auditablePlayer<T extends Record<string, unknown>>(
  player: T | null | undefined,
): Partial<T> | null {
  if (!player) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(player)) {
    if (KEEP.has(key)) out[key] = player[key];
  }
  return out as Partial<T>;
}
