import { createServiceRoleClient } from './supabase-server';

// CLUB CHANGES, ON THE MEMBERS' SIDE (00286). The entries an admin posted from
// the console's Club changes page: rating settings, account rules, member page
// switches, club links and officer roles, in plain language.
//
// Read with the service-role client because the tables grant nothing to
// `authenticated`. Posted entries are public: the What's new page shows them to
// everyone, signed in or not. Drafts are never read here.
// Never throws: a failed read is an empty list, and the release notes still
// render.

export type ClubChangeEntry = {
  id: string;
  title: string | null;
  intro: string | null;
  lines: string[];
  postedAt: string;
};

type EntryRow = { id: string; title: string | null; intro: string | null; lines: unknown; posted_at: string };

/** The most recent posted entries, newest first. */
export async function getClubChangeEntries(limit = 50): Promise<ClubChangeEntry[]> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from('club_change_entries')
      .select('id, title, intro, lines, posted_at')
      .order('posted_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[club-changes] could not read the posted entries:', error.message);
      return [];
    }
    return ((data ?? []) as EntryRow[]).map((row) => ({
      id: row.id,
      title: row.title,
      intro: row.intro,
      lines: Array.isArray(row.lines) ? row.lines.filter((line): line is string => typeof line === 'string') : [],
      postedAt: row.posted_at,
    }));
  } catch (err) {
    console.error('[club-changes] could not read the posted entries:', err);
    return [];
  }
}
