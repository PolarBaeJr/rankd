import { NextResponse } from 'next/server';
import {
  featureAccessFor,
  featureGate,
  featureOffMessage,
  getAccountStanding,
} from '@badminton/shared';
import { appActorStore, resolveAppActor } from '@/lib/app-actor';
import { getCurrentPlayer } from '@/lib/supabase-server';
import { getFeatureFlags } from '@/lib/feature-gate';
import { getChallengeRules } from '@/lib/challenge-settings';
import { challengeQuota, ACTIVE_CHALLENGE_STATUSES } from '@/lib/challenge-rules';
import { listChallengeableOpponents } from '@/lib/challengeable-opponents';

// What the native app's Challenges screens need that the member's own
// PostgREST reads cannot give it, computed exactly as the website's pages do:
//
//  - standing: getAccountStanding over the full players row, which carries
//    columns (is_banned, ban_reason) the member cannot read themselves.
//  - feature: the club switch, as the /challenges layout's FeatureGate decides.
//  - rules and quota: the /challenges page's own reads.
//  - opponents: /challenges/new's server-side list, which is the only place
//    is_banned and hidden ratings are filtered. Handed out only where the web
//    would render the form at all: good standing, feature on.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const actor = await resolveAppActor(request);
  if (!actor) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: NO_STORE });

  return appActorStore.run(actor, async () => {
    const player = await getCurrentPlayer();
    if (!player) return NextResponse.json({ error: 'No member profile' }, { status: 403, headers: NO_STORE });

    const standing = getAccountStanding(player);
    const flags = await getFeatureFlags();
    const featureOn = featureGate(flags.challenges, featureAccessFor(player).includes('challenges')) !== 'redirect';

    const [rules, activeIssued] = await Promise.all([
      getChallengeRules(actor.supabase),
      // The /challenges page's own quota count: same predicate as
      // validate_challenge_creation, counted at the database.
      actor.supabase
        .from('challenges')
        .select('id', { count: 'exact', head: true })
        .eq('created_by', player.id)
        .in('status', [...ACTIVE_CHALLENGE_STATUSES]),
    ]);
    const quota = challengeQuota(activeIssued.count ?? 0, rules.maxActive);

    const opponents = standing.ok && featureOn ? await listChallengeableOpponents(player.id) : [];

    return NextResponse.json(
      {
        playerId: player.id,
        standing: { ok: standing.ok, detail: standing.detail },
        feature: featureOn ? 'on' : 'off',
        featureMessage: featureOn ? null : featureOffMessage('challenges'),
        rules,
        quota,
        opponents,
      },
      { headers: NO_STORE },
    );
  });
}
