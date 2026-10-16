import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { VIEWER_HEADER, readViewer } from './verified-viewer';
import { AUTH_COOKIE_OPTIONS } from '@badminton/shared';
import { getServerSupabaseUrl } from '@badminton/shared';
import { appActorStore } from './app-actor';

// NOTE: generated `Database` type is available from '@badminton/shared' but not
// applied to the clients here — typed clients flip many `select('*, foo(*)')`
// embeddings to `never` and would cascade into a per-query rewrite. Opt in
// per-file when narrowing a specific query.

// Service role client — bypasses RLS, use only for trusted server-side operations
export function createServiceRoleClient() {
  return createClient(
    getServerSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function createServerSupabaseClient() {
  // A native app request (/api/app/*): the member's bearer client, and no
  // cookies at all. Checked first, so cookies() is never touched for it.
  const actor = appActorStore.getStore();
  if (actor) return actor.supabase;

  const cookieStore = await cookies();

  return createServerClient(
    getServerSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        // No companion host-only clear here, unlike the middleware and route
        // handlers: next/headers' cookie store is keyed by name and offers no
        // way to append a second Set-Cookie, so writing one would delete the
        // session instead of moving it. Server actions rarely refresh a token
        // (the middleware has already done it for the same request), and any
        // duplicate that does slip through is caught by the middleware's
        // duplicateAuthCookieClears on the next request.
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as any)
            );
          } catch {
            // Server Component
          }
        },
      },
    }
  );
}

// The active season's public info (name + per-status fees), or null if none is
// active. Uses the anon-safe get_active_season() RPC so it works the same in
// authenticated and logged-out contexts.
export async function getActiveSeason(): Promise<{
  id: string;
  name: string;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
} | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('get_active_season');
  return data?.[0] ?? null;
}

export async function getExecutives(): Promise<{
  id: string;
  name: string;
  exec_title: string | null;
  // Deliberately not avatar_url — the exec page has its own photos (00042).
  exec_photo_url: string | null;
  /**
   * THE OFFICER'S PUBLIC BLURB, AND SINCE 00130 IT IS players.exec_bio — NOT
   * players.bio. The function aliases it back to `bio` on the way out, which is
   * why this property did not have to be renamed: keeping the output column
   * meant the migration and the app deploy needed no ordering between them on a
   * live database. players.bio is now the member's personal bio only, edited in
   * Settings, shown on their ladder profile, and published nowhere.
   *
   * It has no SELECT grant for `authenticated` (00130 §4a) — this function is
   * SECURITY DEFINER and is the ONLY way to read it. Do not add it to a
   * `.from('players').select(...)` anywhere: that request would 403 as a whole
   * and arrive here as empty data.
   */
  bio: string | null;
}[]> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('get_executives');
  return data ?? [];
}

// THE ONE `players` QUERY THE WHOLE REQUEST SHARES. Written once because the
// entire point of getViewer() below is that its request and getCurrentPlayer()'s
// are byte-identical; two column lists that drift apart are two round trips
// again, and nothing anywhere would say so.
const PLAYER_SELECT = '*, ratings(*), waiver_acceptances(document, version, accepted_at)';

/** Who the request's session belongs to. The middleware has usually just asked
 *  GoTrue and forwarded the signed answer (lib/verified-viewer.ts); only when
 *  it has not (a public path, which the middleware leaves alone) does this pay
 *  for a getUser() round trip of its own. Just the id, because the id is all
 *  any caller reads off it. */
async function verifiedUserId(): Promise<string | null> {
  const forwarded = await readViewer((await headers()).get(VIEWER_HEADER));
  if (forwarded) return forwarded;
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

async function loadViewer() {
  // The native app's user was verified by resolveAppActor. Its client carries
  // the bearer as a global header and has no session, so an arg-less getUser()
  // on it would find nobody. Checked first: an app request carries no cookie,
  // so the middleware never forwards an id for one.
  const actor = appActorStore.getStore();
  const userId = actor ? actor.user.id : await verifiedUserId();
  if (!userId) return { user: null, player: null };
  const user = { id: userId };

  // Service role for the full row: migration 00032 revokes blanket SELECT on
  // players, and a column grant denies select('*') even on your own row. This
  // is safe because the filter is the user id from the verified session, never
  // anything the caller supplies — it can only ever return the caller's row.
  const { data: player } = await createServiceRoleClient()
    .from('players')
    .select(PLAYER_SELECT)
    .eq('user_id', user.id)
    .maybeSingle();

  return { user, player: player ?? null };
}

/**
 * The caller's own player row, read FRESH every call.
 *
 * Deliberately not cached, and that is not an oversight — see getViewer() below
 * for the cached one. completeOnboarding() calls this a second time immediately
 * after inserting the row, specifically to pick up the id it just created
 * ("Re-fetch for the freshly created row's id", actions/profile.ts). A
 * request-scoped cache would hand that call the pre-insert `null`, and the
 * acceptances, the passkey record and the skill tier would all be skipped in
 * silence. Server actions and route handlers use this one.
 */
export async function getCurrentPlayer() {
  return (await loadViewer()).player;
}

/**
 * THE SAME READ, ONCE PER REQUEST — for Server Components only.
 *
 * The root layout and the page rendering under it both need the viewer, and
 * before this they each fetched it: the layout with its own named column list,
 * the page through getCurrentPlayer()'s `select('*')`. Different URLs, so Next's
 * fetch memoization could not collapse them — prod's Kong log carried both
 * shapes side by side — and every authenticated navigation paid for two
 * `players` reads and two /auth/v1/user round trips where one would do.
 *
 * react cache() is scoped to the request, so whichever of the two runs first
 * fills it and the other hits it. That is safe HERE and nowhere else: rendering
 * never mutates, so there is no write for a cached read to be stale against. A
 * server action does mutate, which is exactly why it keeps getCurrentPlayer().
 * When Next follows an action with a re-render in the same request the action
 * has already finished before anything here is called, so what lands in the
 * cache is the post-mutation row.
 *
 * `user` comes back alongside `player` because they answer different questions.
 * A member with a live session but no players row is authenticated — the layout
 * has always shown them signed-in chrome — and collapsing this to `player !==
 * null` would sign them out halfway through onboarding.
 */
export const getViewer = cache(loadViewer);
