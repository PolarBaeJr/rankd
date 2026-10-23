import { clearTournamentEvent, fetchTournamentActions, recordTournamentEvent } from './api.js';
import { runScheduledEventSync, type ScheduledEventRunResult } from './scheduled-event-sync.js';

// Keeps the server's Events tab in step with the club's tournaments. The loop,
// and the reasoning behind its order of operations, is in
// scheduled-event-sync.ts; this file only translates tournament ids.

export type TournamentRunResult = ScheduledEventRunResult;

export function runTournamentEvents(): Promise<TournamentRunResult> {
  return runScheduledEventSync({
    label: 'tournament events',
    async fetchActions(guildId) {
      const { actions, skipped } = await fetchTournamentActions(guildId);
      return {
        actions: actions.map(({ tournamentId, ...rest }) => ({ ...rest, sourceId: tournamentId })),
        skipped: skipped.map((s) => ({ sourceId: s.tournamentId, reason: s.reason })),
      };
    },
    record(guildId, discordEventId, action) {
      // The app's location, not the fallback Discord was sent, for the reason
      // club-events.ts gives: the app compares against it (00304).
      return recordTournamentEvent({
        tournamentId: action.sourceId,
        guildId,
        discordEventId,
        name: action.name,
        syncedStartsAt: action.syncedStartsAt,
        syncedEndsAt: action.syncedEndsAt,
        location: action.location,
      });
    },
    clear(guildId, sourceId) {
      return clearTournamentEvent(sourceId, guildId);
    },
  });
}
