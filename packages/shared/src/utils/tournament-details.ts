// A tournament's own daily times and venue (00304).
//
// They used to be three club-wide Discord settings, so every tournament started
// at the same hour in the same gym. They live on the tournament now, set in the
// console and from /tourney details, and these helpers are shared by both so
// the two doors refuse the same things in the same words.
//
// PostgREST hands a `time` column back as HH:MM:SS, while every form and the
// Discord command speak HH:MM. clockHHMM is the one place that difference is
// absorbed: a reader that skipped it would see "09:00:00", fail an HH:MM check,
// and quietly fall back to a default.

/** The column's CHECK (00304), the same cap a session and a club event carry. */
export const TOURNAMENT_LOCATION_MAX = 200;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/;

/** A stored or typed time as zero-padded HH:MM, or null when blank or malformed. */
export function clockHHMM(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  const match = CLOCK.exec(trimmed);
  return match ? `${match[1]}:${match[2]}` : null;
}

export interface TournamentDetails {
  starts_time: string | null;
  ends_time: string | null;
  location: string | null;
}

/**
 * Normalise what a form or a command sent: blank is null, a time is HH:MM, a
 * location is trimmed. Returns the refusal as a sentence when something is
 * wrong, so the console and Discord can both show it as it is.
 */
export function parseTournamentDetails(input: {
  starts_time?: string | null;
  ends_time?: string | null;
  location?: string | null;
}): { ok: true; details: TournamentDetails } | { ok: false; error: string } {
  const startText = (input.starts_time ?? '').trim();
  const endText = (input.ends_time ?? '').trim();
  const starts = startText ? clockHHMM(startText) : null;
  const ends = endText ? clockHHMM(endText) : null;
  if ((startText && !starts) || (endText && !ends)) {
    return { ok: false, error: 'Times have to be 24-hour HH:MM, like 09:00.' };
  }
  // Zero-padded HH:MM strings compare correctly as text.
  if (starts && ends && ends <= starts) {
    return { ok: false, error: 'The end time has to be after the start time.' };
  }
  const location = (input.location ?? '').trim() || null;
  if (location && location.length > TOURNAMENT_LOCATION_MAX) {
    return { ok: false, error: `Keep the location to ${TOURNAMENT_LOCATION_MAX} characters.` };
  }
  return { ok: true, details: { starts_time: starts, ends_time: ends, location } };
}

/**
 * The times as a reader sees them next to the dates: "09:00 to 18:00", or the
 * one end that is set. Null when neither is, so a page can leave the line out.
 */
export function describeTournamentTimes(
  startsTime: string | null | undefined,
  endsTime: string | null | undefined,
): string | null {
  const starts = clockHHMM(startsTime);
  const ends = clockHHMM(endsTime);
  if (starts && ends) return `${starts} to ${ends}`;
  if (starts) return `from ${starts}`;
  if (ends) return `until ${ends}`;
  return null;
}
