'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, Checkbox, Select } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_FORMAT_HINTS,
  TOURNAMENT_EVENT_FORMAT_LABELS,
  TOURNAMENT_EVENT_TYPE_LABELS,
} from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { linkClubEventTournament, type LinkTournamentInput } from '@/lib/actions/club-events';

// A club event that needs a draw, scores or check-in runs them on a linked
// tournament event (00292). Before the link: pick the event type and format and
// make it. After: a link to the tournament pages, which run everything.

const FORMATS: LinkTournamentInput['format'][] = ['single_elimination', 'round_robin', 'pool_to_bracket'];
const TYPES = Object.keys(TOURNAMENT_EVENT_TYPE_LABELS) as LinkTournamentInput['event_type'][];

const heading = (
  <h2
    className="pb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
    style={{ fontFamily: 'var(--display)' }}
  >
    Tournament
  </h2>
);

export function ClubEventTournamentCard({
  eventId,
  linked,
  canLink,
  nonMembers,
}: {
  eventId: string;
  linked: { tournamentId: string; eventId: string; status: string } | null;
  canLink: boolean;
  nonMembers: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [eventType, setEventType] = useState<LinkTournamentInput['event_type']>('open_doubles');
  const [format, setFormat] = useState<LinkTournamentInput['format']>('single_elimination');
  const [rated, setRated] = useState(false);
  const [busy, setBusy] = useState(false);

  if (linked) {
    return (
      <Card className="p-5">
        {heading}
        <div className="flex flex-col gap-3 text-sm text-[var(--ink-2)]">
          <p className="m-0">
            This event runs on a tournament event: the draw, pairing, check-in and scores are there.
            Sign-ups here and entries there are kept the same both ways, and the fee is charged
            once, here.
            {linked.status === 'draft' && ' Members see the tournament once you activate it.'}
          </p>
          <p className="m-0 text-[var(--text-muted)]">
            Non-members from the Google Form are entered too, as guests: recreational, no login, no
            dues, sent nothing by the app, and kept off the leaderboard and challenges. They are on
            the Guests tab of Players. A guest becomes a normal member if they sign in with that
            email.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/tournaments/${linked.tournamentId}/events/${linked.eventId}`}>
              <Button>Open the draw</Button>
            </Link>
            <Link href={`/tournaments/${linked.tournamentId}`}>
              <Button variant="secondary">Tournament settings</Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  if (!canLink) return null;

  async function handleLink() {
    setBusy(true);
    try {
      const result = await linkClubEventTournament(eventId, { event_type: eventType, format, rated });
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast('Tournament made. Everyone signed up is entered.', 'success');
      router.push(`/tournaments/${result.data.tournamentId}/events/${result.data.eventId}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      {heading}
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-[var(--ink-2)]">
          Need a bracket, scores or check-in? Run this event as a tournament. Everyone signed up is
          entered, from then on sign-ups and entries stay the same both ways, and every tournament
          feature works on it.
          {nonMembers > 0 &&
            ` The ${nonMembers} non-member${nonMembers === 1 ? '' : 's'} from the Google Form ${nonMembers === 1 ? 'is' : 'are'} entered as ${nonMembers === 1 ? 'a guest' : 'guests'}: no login, no dues, and sent nothing.`}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Event type"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as LinkTournamentInput['event_type'])}
            options={TYPES.map((t) => ({ value: t, label: TOURNAMENT_EVENT_TYPE_LABELS[t] }))}
          />
          <div>
            <Select
              label="Format"
              value={format}
              onChange={(e) => setFormat(e.target.value as LinkTournamentInput['format'])}
              options={FORMATS.map((f) => ({ value: f, label: TOURNAMENT_EVENT_FORMAT_LABELS[f] }))}
            />
            <p className="mt-1 text-xs text-[var(--text-muted)]">{TOURNAMENT_EVENT_FORMAT_HINTS[format]}</p>
          </div>
        </div>
        <Checkbox
          checked={rated}
          onChange={setRated}
          label="Results count toward ratings"
          showLabel
        />
        <div>
          <Button onClick={handleLink} loading={busy}>
            Run as a tournament
          </Button>
        </div>
      </div>
    </Card>
  );
}
