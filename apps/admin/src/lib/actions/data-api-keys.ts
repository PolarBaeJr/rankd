'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import {
  DATA_API_KEY_PREFIX,
  DATA_API_SCOPES,
  hashDataApiKey,
  type DataApiScope,
} from '@badminton/shared/src/utils/data-api-key';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';

// MINTING AND REVOKING THE DATA API'S KEYS.
//
// THE PLAINTEXT KEY EXISTS FOR THE LENGTH OF ONE FUNCTION CALL. It is generated
// here, hashed here, and returned to the caller; what reaches the database is a
// sha256 digest and a six-character display prefix. Nothing writes it to a log,
// to Sentry, to an audit row or to an error message, and the three places that
// could do so by accident are called out where they occur. 00241's table
// comment makes the same statement from the database's side: the key exists
// nowhere in it.
//
// WHY THE KEY IS GENERATED IN NODE AND NOT IN POSTGRES. The obvious SQL version
// is an RPC that mints and hashes server-side and returns the plaintext. That
// plaintext then travels back through PostgREST as a response body and, far
// worse, any SQL-side generation that took the plaintext as an argument would
// put it in a bound parameter, where `log_statement`, a slow-query report or a
// PostgREST log line can capture it. A key in a log is a key that has left the
// club. Hashing in Node means the only thing that ever crosses the wire to the
// database is the digest.
//
// EVERY EXPORTED PARAMETER BELOW IS A CLIENT-CONTROLLED POST FIELD. That is not
// a warning about the UI, it is the shape of a server action: a hand-rolled
// POST reaches these signatures directly. So no function here takes an actor
// id, a consumer id, a player_ref, a key, a hash or a prefix. The actor is
// resolved server-side by requireCapability, the consumer is resolved by name,
// and the key material is made here.

// SCOPES ARE VALIDATED HERE AS WELL AS BY THE SQL CHECK, on purpose. The CHECK
// `data_api_keys_scope_vocabulary` (00264) is the backstop that makes a bad row
// impossible; normaliseScopes is what makes a bad request a readable refusal
// instead of a constraint violation surfacing as "Something went wrong". Both
// read the one list in @badminton/shared, which a test asserts against the
// CHECK.

export interface MintDataApiKeyInput {
  consumerName: string;
  label?: string | null;
  scopes: string[];
  expiresAt?: string | null;
}

export interface MintedDataApiKey {
  id: string;
  prefix: string;
  /** Shown once and never recoverable. Not persisted anywhere. */
  key: string;
}

export interface RevokeDataApiKeyInput {
  keyId: string;
  reason?: string | null;
}

export interface UpdateDataApiKeyScopesInput {
  keyId: string;
  scopes: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mint a key for a consumer, creating the consumer row if this is the first key
 * for that name.
 *
 * CONSUMER CREATION IS FOLDED IN RATHER THAN BEING ITS OWN ACTION. A fourth
 * capability would move the vocabulary count, both SQL CHECK constraints and
 * ENFORCEMENT_POINTS, which is a large blast radius for an admin convenience
 * that nobody would ever use on its own: a consumer with no key reads nothing.
 */
export async function mintDataApiKey(
  input: MintDataApiKeyInput,
): Promise<ActionResult<MintedDataApiKey>> {
  return runAction(() => mintImpl(input));
}

async function mintImpl(input: MintDataApiKeyInput): Promise<MintedDataApiKey> {
  const actor = await requireCapability('accounts.apikey.mint.write');
  const adminClient = createAdminClient();

  const consumerName = (input.consumerName ?? '').trim();
  if (consumerName.length < 1 || consumerName.length > 80) {
    throw new ExpectedError('A key needs a consumer name of between 1 and 80 characters.');
  }

  const scopes = normaliseScopes(input.scopes);
  const label = (input.label ?? '').trim() || null;
  const expiresAt = normaliseExpiry(input.expiresAt);

  const consumerId = await resolveConsumer(adminClient, consumerName, actor.id as string);

  // 32 bytes, so the digest below is a digest of 256 bits of entropy rather
  // than of something guessable. base64url because the key travels in an
  // Authorization header and must survive a URL and a shell without quoting.
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${DATA_API_KEY_PREFIX}${secret}`;
  const keyHash = hashDataApiKey(plaintext);
  // Enough to tell three keys apart in the panel and nowhere near enough to
  // reconstruct one. The plaintext is gone after this call, so without it an
  // admin cannot tell which key they are about to revoke.
  const keyPrefix = `${DATA_API_KEY_PREFIX}${secret.slice(0, 6)}`;

  const { data, error } = await adminClient
    .from('data_api_keys')
    .insert({
      consumer_id: consumerId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      label,
      scopes,
      expires_at: expiresAt,
      minted_by: actor.id,
    })
    .select('id')
    .maybeSingle();
  // The message is the database's, and the database has never seen the
  // plaintext, so there is nothing here that could carry it into Sentry.
  if (error) throw new Error(`The key was not written: ${error.message}`);
  const id = (data as { id: string } | null)?.id;
  // PostgREST reports "matched no rows" as a success with an empty body, so a
  // missing error proves nothing was refused rather than proving a row exists.
  if (!id) throw new Error('The key was not written.');

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'data_api_key_minted',
      target_type: 'data_api_key',
      target_id: id,
      // CONSUMER, LABEL, SCOPES, EXPIRY AND PREFIX ONLY. Not the plaintext and
      // not the hash: audit_logs is read back on /audit by every holder of
      // audit.page, and a credential in a row designed to be browsed is a
      // credential handed to everybody who can browse it.
      new_value: {
        consumer: consumerName,
        label,
        scopes,
        expires_at: expiresAt,
        key_prefix: keyPrefix,
      },
      reason: `${consumerName} was issued a data API key (${scopes.join(', ')})`,
    },
    { keyId: id },
  );

  revalidatePath('/platform');

  // The one and only time the plaintext leaves this function. The caller holds
  // it in client state and loses it on reload, which is the intended property.
  return { id, prefix: keyPrefix, key: plaintext };
}

/**
 * Turn a key off. The row stays: it is the record of who could read the club's
 * data and until when.
 */
export async function revokeDataApiKey(input: RevokeDataApiKeyInput): Promise<ActionResult<void>> {
  return runAction(() => revokeImpl(input));
}

async function revokeImpl(input: RevokeDataApiKeyInput): Promise<void> {
  const actor = await requireCapability('accounts.apikey.revoke.write');
  const adminClient = createAdminClient();

  const keyId = (input.keyId ?? '').trim();
  if (!keyId) throw new ExpectedError('No key was named.');
  const reason = (input.reason ?? '').trim() || null;

  const { data, error } = await adminClient
    .from('data_api_keys')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: actor.id,
      revoke_reason: reason,
    })
    .eq('id', keyId)
    // THE SECOND PREDICATE IS THE WHOLE IDEMPOTENCE. Without it a second revoke
    // overwrites revoked_at and revoked_by, which rewrites the club's record of
    // when the access actually stopped and who stopped it, in favour of whoever
    // clicked last.
    .is('revoked_at', null)
    .select('id, key_prefix, consumer_id, scopes');
  if (error) throw new Error(`The key was not revoked: ${error.message}`);

  const row = (data ?? [])[0] as
    | { id: string; key_prefix: string; consumer_id: string; scopes: string[] }
    | undefined;
  // Zero rows is not an error at the database, so it has to be read as one
  // here. It means the key is already revoked or was never there, and a toast
  // saying "revoked" over either of those is a false receipt.
  if (!row) {
    throw new ExpectedError('That key is already revoked, or no longer exists.');
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'data_api_key_revoked',
      target_type: 'data_api_key',
      target_id: row.id,
      old_value: { key_prefix: row.key_prefix, scopes: row.scopes, revoked_at: null },
      new_value: { key_prefix: row.key_prefix, revoked: true },
      reason: reason
        ? `${row.key_prefix} revoked: ${reason}`
        : `${row.key_prefix} revoked`,
    },
    { keyId: row.id },
  );

  revalidatePath('/platform');
}

/**
 * Rewrite the scopes of a live key, so a consumer is upgraded without being
 * handed a new secret. The service re-reads scopes within its 30-second cache.
 *
 * GATED BY THE MINT CAPABILITY, not a new one: changing what a key can read is
 * the same power as minting a key that can read it.
 */
export async function updateDataApiKeyScopes(
  input: UpdateDataApiKeyScopesInput,
): Promise<ActionResult<{ scopes: DataApiScope[] }>> {
  return runAction(() => updateScopesImpl(input));
}

async function updateScopesImpl(input: UpdateDataApiKeyScopesInput): Promise<{ scopes: DataApiScope[] }> {
  const actor = await requireCapability('accounts.apikey.mint.write');
  const adminClient = createAdminClient();

  const keyId = (input.keyId ?? '').trim();
  if (!UUID_PATTERN.test(keyId)) throw new ExpectedError('No key was named.');
  const scopes = normaliseScopes(input.scopes);

  const { data: current, error: readError } = await adminClient
    .from('data_api_keys')
    .select('id, key_prefix, scopes, revoked_at, expires_at')
    .eq('id', keyId)
    .maybeSingle();
  if (readError) throw new Error(`The key could not be read: ${readError.message}`);
  const before = current as
    | { id: string; key_prefix: string; scopes: string[]; revoked_at: string | null; expires_at: string | null }
    | null;
  if (!before || before.revoked_at) {
    throw new ExpectedError('That key is revoked, or no longer exists. Mint a new one instead.');
  }
  if (before.expires_at && new Date(before.expires_at).getTime() <= Date.now()) {
    throw new ExpectedError('That key has expired. Mint a new one instead.');
  }

  const { data, error } = await adminClient
    .from('data_api_keys')
    .update({ scopes })
    .eq('id', keyId)
    // A revoke that lands between the read above and this write must win: a
    // revoked key never has its scopes rewritten.
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error(`The scopes were not changed: ${error.message}`);
  if ((data ?? []).length !== 1) {
    throw new ExpectedError('That key was revoked while you were editing it.');
  }

  await logAdminAudit(
    adminClient,
    {
      actor_id: actor.id as string,
      action_type: 'data_api_key_scopes_changed',
      target_type: 'data_api_key',
      target_id: before.id,
      old_value: { key_prefix: before.key_prefix, scopes: before.scopes },
      new_value: { key_prefix: before.key_prefix, scopes },
      reason: `${before.key_prefix} scopes set to ${scopes.join(', ')}`,
    },
    { keyId: before.id },
  );

  revalidatePath('/platform');
  return { scopes };
}

// ---------------------------------------------------------------------------
// Helpers. Not exported: an exported function in a 'use server' module is a
// POST endpoint, and neither of these is one.
// ---------------------------------------------------------------------------

function normaliseScopes(scopes: string[]): DataApiScope[] {
  const wanted = Array.isArray(scopes) ? scopes : [];
  const bad = wanted.filter((scope) => !DATA_API_SCOPES.includes(scope as DataApiScope));
  if (bad.length > 0) {
    throw new ExpectedError(`Not a data API scope: ${bad.join(', ')}`);
  }
  // De-duplicated and put in the contract's order, so two keys granted the same
  // scopes store the same array and read the same way on the screen.
  const unique = DATA_API_SCOPES.filter((scope) => wanted.includes(scope));
  if (unique.length === 0) {
    throw new ExpectedError('A key with no scopes can read nothing. Choose at least one.');
  }
  return [...unique];
}

function normaliseExpiry(expiresAt: string | null | undefined): string | null {
  const raw = (expiresAt ?? '').trim();
  if (!raw) return null;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    throw new ExpectedError('That expiry date could not be read.');
  }
  // Mirrors data_api_keys_expiry_after_creation. Refused here so an admin sees
  // the sentence rather than a constraint name.
  if (when.getTime() <= Date.now()) {
    throw new ExpectedError('An expiry date in the past would mint a key that never works.');
  }
  return when.toISOString();
}

/**
 * The consumer row for a name, created on first use.
 *
 * MATCHED ON THE EXACT TRIMMED NAME, which is what the UNIQUE index on
 * `data_api_consumers.name` enforces. A near-miss ("Campus AI Club" against
 * "Campus AI club") makes a second consumer with its own salt rather than colliding,
 * and that is the safe direction: two consumers see different pseudonyms, which
 * is the documented behaviour, whereas silently folding a new name into an
 * existing consumer would hand a second party the first one's join keys.
 */
async function resolveConsumer(
  adminClient: ReturnType<typeof createAdminClient>,
  name: string,
  actorId: string,
): Promise<string> {
  const { data: existing } = await adminClient
    .from('data_api_consumers')
    // NEVER `select('*')`: `player_ref_salt` is withheld from this client by a
    // column-level grant in 00241, and a star select would be refused outright
    // rather than returning the other columns.
    .select('id')
    .eq('name', name)
    .maybeSingle();
  const existingId = (existing as { id: string } | null)?.id;
  if (existingId) return existingId;

  const { data, error } = await adminClient
    .from('data_api_consumers')
    .insert({ name, created_by: actorId })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`The consumer was not written: ${error.message}`);
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The consumer was not written.');
  return id;
}
