// EACH PERSON IN A DOUBLES TEAM CHECKS IN ON THEIR OWN (00309). A team is
// checked in once both people are here; until then the desk sees who has
// arrived and who the team is waiting on. State is per slot, not per player,
// because an external team (00269) has names and no player ids.

export type PairSlot = 1 | 2;

/** The columns of tournament_pairs the check-in desk reads. */
export interface PairCheckInRow {
  id: string;
  status: string;
  checked_in_at?: string | null;
  player1_id: string | null;
  player2_id: string | null;
  external1_name?: string | null;
  external2_name?: string | null;
  // Absent before 00309, and read as not set.
  player1_checked_in_at?: string | null;
  player2_checked_in_at?: string | null;
}

export interface PairCheckInPerson {
  pairId: string;
  slot: PairSlot;
  /** null on an external team. */
  playerId: string | null;
  name: string;
  partnerName: string;
  here: boolean;
  checkedInAt: string | null;
  pairStatus: string;
}

const slotStamp = (pair: PairCheckInRow, slot: PairSlot) =>
  (slot === 1 ? pair.player1_checked_in_at : pair.player2_checked_in_at) ?? null;

/** Is this slot's person here: marked, or their team is checked in. */
export function pairMemberHere(pair: PairCheckInRow, slot: PairSlot): boolean {
  return slotStamp(pair, slot) !== null || pair.status === 'checked_in';
}

/**
 * One row per person of every waiting or checked-in team, in the pairs' order.
 * `nameOf` gives a member's name from the player embed; an external team's
 * people fall back to their typed names.
 */
export function pairCheckInPeople<P extends PairCheckInRow>(
  pairs: readonly P[],
  nameOf: (pair: P, slot: PairSlot) => string | null | undefined,
): PairCheckInPerson[] {
  const people: PairCheckInPerson[] = [];
  for (const pair of pairs) {
    if (pair.status !== 'registered' && pair.status !== 'checked_in') continue;
    const name = (slot: PairSlot) =>
      nameOf(pair, slot) || (slot === 1 ? pair.external1_name : pair.external2_name) || '?';
    for (const slot of [1, 2] as const) {
      const here = pairMemberHere(pair, slot);
      people.push({
        pairId: pair.id,
        slot,
        playerId: (slot === 1 ? pair.player1_id : pair.player2_id) ?? null,
        name: name(slot),
        partnerName: name(slot === 1 ? 2 : 1),
        here,
        checkedInAt: slotStamp(pair, slot) ?? (here ? pair.checked_in_at ?? null : null),
        pairStatus: pair.status,
      });
    }
  }
  return people;
}

/** The desk's header: people here of people expected, teams in of teams. */
export function pairCheckInCounts(people: readonly PairCheckInPerson[]): {
  peopleHere: number;
  people: number;
  teamsIn: number;
  teams: number;
} {
  const teams = new Map<string, string>();
  for (const p of people) teams.set(p.pairId, p.pairStatus);
  return {
    peopleHere: people.filter((p) => p.here).length,
    people: people.length,
    teamsIn: [...teams.values()].filter((s) => s === 'checked_in').length,
    teams: teams.size,
  };
}
