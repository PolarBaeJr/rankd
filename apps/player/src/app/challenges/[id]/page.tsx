import { createServerSupabaseClient, getViewer } from '@/lib/supabase-server';
import { describeMatchShape, formatRelativeTime, pickOne } from '@badminton/shared';
import { notFound, redirect } from 'next/navigation';
import { ChallengeDetailActions } from './actions';
import { ArrowLeft, Clock, Zap, Trophy, MessageSquare, Crosshair } from 'lucide-react';
import Link from 'next/link';
import { AvatarChip } from '@badminton/ui';
import { CHALLENGE_STATUS_TAG, PARTICIPANT_CONFIRM_TAG } from '@badminton/shared';
import { viewerMaySeeChallenge } from '@/lib/challenge-visibility';
import { getMatchupPrediction, predictionsVisible } from '@/lib/predictions';
import { MatchupPrediction } from '@/components/matchup-prediction';

export default async function ChallengeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { player } = await getViewer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(id, full_name, avatar_url, ratings(*)))')
    .eq('id', id)
    .single();

  // NOT JUST "does this row exist". `challenges_select` is USING (TRUE) and the
  // row carries `note`, the free text one member writes at another — so reading
  // by id alone handed any signed-in member anybody's challenge, and the list
  // page next door has always scoped itself with .eq('player_id', player.id).
  // See lib/challenge-visibility.ts for why the creator is a separate disjunct
  // and for the RLS half that closes the bulk PostgREST read (00156).
  if (!challenge || !viewerMaySeeChallenge(challenge, player.id)) notFound();

  // NAMED COLUMNS, NOT `*`. This is a member's own session reading the club's
  // match ledger, and it needs four fields off it: the status badge, the
  // scoreline, the id it hands to the actions, and who submitted it (which
  // decides whether this viewer is offered "confirm" or "dispute").
  // `select('*')` was asking for the lot — the season and tournament ids, the
  // Elo weights, the walkover bookkeeping, and until 00117 `admin_note`, the
  // exec's own words about a void.
  //
  // IT ALSO REMOVES A LANDMINE FOR ANY FUTURE COLUMN RESTRICTION. A revoked
  // column grant does not blank a field, it fails the WHOLE PostgREST request
  // with 403 — and supabase-js RESOLVES rather than rejects, so the `?? null`
  // below would have rendered the refusal as "this challenge has no match" on a
  // page that is otherwise fine. 00115 is the write-up of that failure mode
  // costing five player screens; a `select('*')` is the shape that walks into
  // it. The children are enumerated for the same reason.
  // ONE STRING LITERAL, NOT A CONCATENATION, and that is a type-level
  // requirement rather than a style choice. supabase-js parses the select
  // string as a LITERAL type to derive the row shape; `'a, b' + 'c'` widens to
  // `string`, the parse fails, and every field access below becomes
  // `Property 'result_status' does not exist on type 'GenericStringError'`.
  const { data: match } = await supabase
    .from('matches')
    .select('id, result_status, score_summary, submitted_by, match_participants(id, rating_delta, player:players(full_name)), match_games(id, game_number, side_a_score, side_b_score)')
    .eq('challenge_id', id)
    .maybeSingle();

  type Participant = {
    id: string;
    player_id: string;
    team_side: string;
    confirmation_status: string;
    role: string;
    player: { id: string; full_name: string; avatar_url?: string | null; ratings?: unknown } | { id: string; full_name: string; avatar_url?: string | null; ratings?: unknown }[] | null;
  };

  const participants = (challenge.challenge_participants ?? []) as Participant[];
  const myParticipant = participants.find((cp) => cp.player_id === player.id);
  const sideA = participants.filter((cp) => cp.team_side === 'a');
  const sideB = participants.filter((cp) => cp.team_side === 'b');

  // A win prediction for the matchup, shown only to a member playing in it
  // (get_matchup_prediction enforces the same in SQL), and only until a result
  // is recorded: once there is a score the prediction has nothing left to say.
  const prediction =
    myParticipant &&
    !match &&
    (challenge.type === 'singles' || challenge.type === 'doubles') &&
    (await predictionsVisible(player))
      ? await getMatchupPrediction(
          challenge.type,
          sideA.map((cp) => cp.player_id),
          sideB.map((cp) => cp.player_id),
        )
      : null;

  return (
    <div data-screen-label="Challenge Detail" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header" style={{ marginBottom: 18 }}>
        <Link
          href="/challenges"
          className="row press"
          style={{ gap: 8, fontSize: 13, color: 'var(--mute)' }}
        >
          <ArrowLeft size={16} />
          Back to challenges
        </Link>
      </div>

      <div className="card-base" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          className="card-head"
          style={{
            padding: '20px 22px 16px',
            borderBottom: '1px solid var(--line)',
            marginBottom: 0,
          }}
        >
          <div>
            <div className="page-eyebrow" style={{ marginBottom: 4 }}>
              <span className="bar" /> CHALLENGE
            </div>
            <h1
              style={{
                fontFamily: 'var(--display)',
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: '-.02em',
                margin: 0,
              }}
            >
              {challenge.type === 'singles' ? 'Singles match' : 'Doubles match'}
            </h1>
          </div>
          <span className={CHALLENGE_STATUS_TAG[challenge.status] ?? 'tag'}>
            {challenge.status.replace(/_/g, ' ')}
          </span>
        </div>

        <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="grid grid-2">
            {[
              { icon: Crosshair, label: 'Type',    value: challenge.type as string },
              { icon: Trophy,    label: 'Format',  value: describeMatchShape({ match_format: challenge.format, games_per_match: challenge.games_per_match, points_per_game: challenge.points_per_game }) },
              { icon: Zap,       label: 'Rated',   value: challenge.rated_flag ? 'Rated' : 'Casual' },
              { icon: Clock,     label: 'Created', value: formatRelativeTime(challenge.created_at) },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  padding: 14,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                }}
              >
                <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                  <item.icon size={12} className="text-[var(--mute)]" />
                  <span className="stat-label">{item.label}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', textTransform: 'capitalize' }}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {challenge.note && (
            <div
              className="row"
              style={{
                padding: 14,
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--surface-2)',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <MessageSquare size={16} className="text-[var(--mute)]" style={{ marginTop: 2, flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--ink-2)' }}>{challenge.note}</p>
            </div>
          )}

          <div className="grid grid-2">
            {[
              { label: 'Team A', players: sideA },
              { label: 'Team B', players: sideB },
            ].map((team) => (
              <div
                key={team.label}
                style={{
                  padding: 14,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--surface)',
                }}
              >
                <div className="stat-label" style={{ marginBottom: 10 }}>{team.label.toUpperCase()}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {team.players.length === 0 ? (
                    <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>No players yet.</div>
                  ) : (
                    team.players.map((cp) => {
                      const p = pickOne(cp.player);
                      return (
                        <div key={cp.id} className="row" style={{ gap: 10 }}>
                          <AvatarChip name={p?.full_name ?? '?'} id={p?.id ?? cp.id} src={p?.avatar_url} size="sm" />
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 500, minWidth: 0 }} className="truncate">
                            {p?.full_name ?? 'Unknown'}
                          </span>
                          <span className={PARTICIPANT_CONFIRM_TAG[cp.confirmation_status] ?? 'tag'}>
                            {cp.confirmation_status}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>

          {prediction && (
            <MatchupPrediction
              probability={prediction.probability}
              sideLabel="Team A"
              model={prediction.model}
              madeAt={prediction.madeAt}
            />
          )}

          {match && (
            <div
              style={{
                padding: 18,
                border: '1px solid var(--line)',
                borderRadius: 12,
                background: 'var(--surface)',
              }}
            >
              <div className="card-head" style={{ marginBottom: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <Trophy size={14} className="text-[var(--gold)]" />
                  <span className="stat-label">Match result</span>
                </div>
                <span className={'tag ' + (match.result_status === 'confirmed' ? 'tag-win' : match.result_status === 'disputed' ? 'tag-red' : 'tag-gold')}>
                  {match.result_status}
                </span>
              </div>
              <div className="mono" style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 700, letterSpacing: '-.02em' }}>
                {match.score_summary || 'Pending'}
              </div>
              {match.match_games && match.match_games.length > 0 && (
                <div className="mono muted" style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {match.match_games.map((g: Record<string, unknown>) => (
                    <span key={g.id as string}>
                      G{g.game_number as number} {g.side_a_score as number}–{g.side_b_score as number}
                    </span>
                  ))}
                </div>
              )}
              {match.match_participants && match.match_participants.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {match.match_participants.map((mp: Record<string, unknown>) => {
                    const p = mp.player as { full_name?: string } | { full_name?: string }[] | null;
                    const person = pickOne(p);
                    const delta = mp.rating_delta as number | null;
                    return (
                      <div key={mp.id as string} className="row" style={{ gap: 10 }}>
                        <span style={{ flex: 1, fontSize: 13 }}>{person?.full_name ?? 'Unknown'}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: typeof delta !== 'number' ? 'var(--mute)' : delta >= 0 ? 'var(--win)' : 'var(--loss)',
                          }}
                        >
                          {typeof delta === 'number' ? `${delta >= 0 ? '+' : ''}${delta}` : 'pending'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <ChallengeDetailActions
          challengeId={id}
          challengeStatus={challenge.status}
          matchId={match?.id}
          matchStatus={match?.result_status}
          myParticipantStatus={myParticipant?.confirmation_status}
          isCreator={challenge.created_by === player.id}
          format={challenge.format}
          gamesPerMatch={challenge.games_per_match}
          pointsPerGame={challenge.points_per_game}
          participants={challenge.challenge_participants}
          playerId={player.id}
          isSubmitter={match?.submitted_by === player.id}
        />
      </div>
    </div>
  );
}
