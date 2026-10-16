import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getServerSupabaseUrl } from '@badminton/shared';

// THE NATIVE APP'S SEAT AT THE WEBSITE'S OWN SERVER ACTIONS.
//
// The Android app writes through the same functions the website's buttons call
// (createChallenge, acceptChallenge, checkInWithToken, ...), so every write it
// makes inherits the same gates and side effects: requirePlayer, the feature
// switch, the waiver, the notifications, the emails. It has no cookie, only the
// member's Supabase access token, so a /api/app/* route resolves that bearer
// into an actor and runs the action inside appActorStore. While the store is
// active, createServerSupabaseClient hands back the actor's client and
// loadViewer takes the actor's user, instead of reading cookies.
//
// Node runtime only (node:async_hooks). Never import this from the middleware,
// which runs on the edge.

export interface AppActor {
  user: User;
  supabase: SupabaseClient;
}

export const appActorStore = new AsyncLocalStorage<AppActor>();

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * The member behind `Authorization: Bearer <jwt>`, or null when the header is
 * missing, malformed, or GoTrue refuses the token. The client carries the
 * bearer on every request, so RLS sees the member exactly as it would through
 * the website's cookie client.
 */
export async function resolveAppActor(request: Request): Promise<AppActor | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = BEARER.exec(header.trim());
  if (!match) return null;
  const jwt = match[1];

  const supabase = createClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return null;
    return { user: data.user, supabase };
  } catch {
    return null;
  }
}
