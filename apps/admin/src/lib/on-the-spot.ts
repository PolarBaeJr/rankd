// Add on the spot: the desk adds whoever is standing there. The rules are
// here so the action and the dialog read them the same way.

/** Checked in on creation once the event is checking in, drawn or live: they are at the desk. */
export function onTheSpotChecksIn(eventStatus: string | null | undefined): boolean {
  return eventStatus != null && eventStatus !== 'registration' && eventStatus !== 'completed';
}

/**
 * Which fee "Charge the event fee" means. A linked club event charges its own
 * fee when the tournament entry syncs a sign-up across (00292), so ticked it
 * is left to stand and unticked it is waived as a walk-in (00317); the
 * tournament fee is never added on top. An unlinked tournament charges the
 * tournament entry fee, or nothing.
 */
export type OnTheSpotFeePath = 'club' | 'club_waived' | 'tournament' | 'none';

export function onTheSpotFeePath(linked: boolean, chargeFee: boolean): OnTheSpotFeePath {
  if (linked) return chargeFee ? 'club' : 'club_waived';
  return chargeFee ? 'tournament' : 'none';
}

/**
 * Players in a doubles event with no team yet, who still have to be paired
 * before a group can take them. A single in a singles event is a full entry.
 */
export function singlesNeedingPartner<P extends { player_id: string; status: string }>(
  participants: readonly P[],
  pairs: ReadonlyArray<{ player1_id: string | null; player2_id: string | null; status: string }>,
): P[] {
  const paired = new Set<string>();
  for (const pair of pairs) {
    if (pair.status === 'withdrawn' || pair.status === 'disqualified') continue;
    if (pair.player1_id) paired.add(pair.player1_id);
    if (pair.player2_id) paired.add(pair.player2_id);
  }
  return participants.filter((p) => (p.status === 'registered' || p.status === 'checked_in') && !paired.has(p.player_id));
}

/** What the desk is told once someone is added. */
export function onTheSpotMessage(res: { name: string; checkedIn: boolean; waiverUnsigned: boolean; needsPartner: boolean }): string {
  const parts = [`${res.name} added${res.checkedIn ? ' and checked in' : ''}.`];
  if (res.waiverUnsigned) parts.push('Waiver not signed: they can sign it on their phone, then check them in.');
  if (res.needsPartner) parts.push('They need a partner before a group can take them.');
  return parts.join(' ');
}
