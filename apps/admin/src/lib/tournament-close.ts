// When a tournament closes by itself: finalising its last open event finishes
// it, so the desk never has to press a second button that reads the same.

/** Events not yet completed, the ones "Close without results" would settle. */
export function openEventCount(eventStatuses: readonly string[]): number {
  return eventStatuses.filter((s) => s !== 'completed').length;
}

/**
 * Read after a finalise: the tournament is still active, it has events, and
 * every one of them is now completed, so the event just finalised was its last
 * open one. A draft or already closed tournament is left alone.
 */
export function closesWithFinalEvent(tournamentStatus: string | null | undefined, eventStatuses: readonly string[]): boolean {
  return tournamentStatus === 'active' && eventStatuses.length > 0 && openEventCount(eventStatuses) === 0;
}
