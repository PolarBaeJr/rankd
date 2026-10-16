import { isUuid, getAccountStanding } from '@badminton/shared';
import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { getViewer } from '@/lib/supabase-server';
import { getRatingSettings } from '@/lib/rating-settings';
import { listChallengeableOpponents } from '@/lib/challengeable-opponents';
import { getMyPredictions, predictionsVisible } from '@/lib/predictions';
import NewChallengeClient from './new-challenge-client';

// Server wrapper so ?opponent= can be read without useSearchParams(), which in
// a client component would need its own <Suspense> boundary to survive the
// production build (and the `dynamic` route-segment escape hatch is not
// available from a 'use client' file). Same page/client split as /leaderboard.
//
// The link at /leaderboard/[playerId] has always pointed here with ?opponent=,
// and the profile QR encodes the same URL — this is where it finally lands.
// A non-UUID is dropped: the value is only a UI hint, and every real check
// still happens in createChallenge -> validate_challenge_creation.
export default async function NewChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ opponent?: string }>;
}) {
  const { opponent } = await searchParams;

  // The one screen whose only purpose is an action the server would refuse, so
  // here "explain instead of hide" means replacing the form rather than
  // stripping buttons out of it: filling in a whole challenge and being told
  // no at submit is worse than being told now. Deep links from a QR code or a
  // stale notification land here too, which is why it is the page and not just
  // the entry points that has to say it.
  // Read once and used twice — the standing gate below, and the self-exclusion
  // for the opponent list. The client used to fetch its own row for both.
  const { player: me } = await getViewer();
  const standing = getAccountStanding(me);
  if (!standing.ok) {
    return (
      <div data-screen-label="New Challenge">
        <PageHeader title="New Challenge" sub="Pick an opponent, a format, and send it." />
        <div className="card-base" style={{ padding: 24 }}>
          <h3 className="card-title">Challenges are paused</h3>
          <p className="card-sub" style={{ marginTop: 8, maxWidth: '60ch' }}>{standing.detail}</p>
          <div style={{ marginTop: 16 }}>
            <Link href="/leaderboard" className="btn btn-primary">Back to the ladder</Link>
          </div>
        </div>
      </div>
    );
  }

  // The rating knobs are read HERE and handed down, because the form is a
  // client component and the preview it draws has to be computed from the same
  // row apply_match_result rates the match from. There is no server round trip
  // between picking an opponent and seeing the figure, so it cannot be fetched
  // at the moment it is needed — and a browser-side read of platform_settings
  // would be a second, differently-authorised path to the same row.
  const ratingSettings = await getRatingSettings();

  // The opponent list is read HERE for the same class of reason, and one more
  // besides: the browser cannot see players.is_banned at all (00032 revoked the
  // grant), so the filter that keeps a banned member out of the picker is only
  // expressible on the server. See challengeable-opponents.ts.
  const opponents = await listChallengeableOpponents(me?.id);

  // Every Data API prediction naming this member, handed down whole so the
  // form can show one the moment the matchup is picked, with no round trip.
  const predictions = me && (await predictionsVisible(me)) ? await getMyPredictions() : [];

  return (
    <NewChallengeClient
      initialOpponentId={isUuid(opponent) ? opponent : undefined}
      ratingSettings={ratingSettings}
      opponents={opponents}
      myId={me?.id}
      predictions={predictions}
    />
  );
}
