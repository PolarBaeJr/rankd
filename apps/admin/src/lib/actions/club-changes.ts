'use server';

import { revalidatePath } from 'next/cache';
import { ExpectedError } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { logAdminAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { accessLevelFor, permissionsOf, permits } from '../permissions';
import { createAnnouncement } from './announcements';
import {
  CLUB_CHANGE_LINE_MAX,
  formatDraft,
  postRefusal,
  type ClubChangeDraft,
} from '../club-change-format';

// CLUB CHANGES (00286): the lines officer edits leave behind, and posting them.
//
// EVERY PARAMETER HERE IS A CLIENT-CONTROLLED POST FIELD. Ids are checked
// against the uuid shape, text is trimmed and capped, and the text of a posted
// line is never taken from the client: postClubChanges reads the drafts by id
// and formats them on the server, so what is posted is the server's sentence
// or the admin's stored rewording, nothing else.
//
// ONE CAPABILITY FOR ALL OF IT, changelog.post.write. Adding, rewording and
// deleting a pending line all decide what members will be told, which is what
// posting decides; capability-gates.ts says so in its `merged`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 120;
const INTRO_MAX = 1000;
const ANNOUNCEMENT_BODY_LIMIT = 5000;
const DRAFT_COLUMNS =
  'id, source, subject, field, from_value, to_value, text_override, override_to_value, first_actor_id, last_actor_id, revision, created_at, changed_at';

function checkedId(id: unknown): string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new ExpectedError('That line no longer exists.');
  return id;
}

function checkedLine(text: unknown): string {
  const line = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  if (line.length === 0) throw new ExpectedError('Write the line first.');
  if (line.length > CLUB_CHANGE_LINE_MAX) {
    throw new ExpectedError(`A line can be at most ${CLUB_CHANGE_LINE_MAX} characters.`);
  }
  return line;
}

function optionalText(text: unknown, max: number, what: string): string | null {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length > max) throw new ExpectedError(`The ${what} can be at most ${max} characters.`);
  return value.length > 0 ? value : null;
}

/** What a stale or malformed post means, in the admin's words. */
function postFailure(message: string): Error {
  if (message.includes('stale_missing') || message.includes('stale_changed')) {
    return new ExpectedError(
      'Someone changed, posted or deleted one of these lines since the page loaded. Reload the page and try again.',
    );
  }
  if (message.includes('bad_lines')) {
    return new ExpectedError('One of the lines is empty or too long. Reword it and try again.');
  }
  return new Error(`Could not post the club changes: ${message}`);
}

function announcementBody(intro: string | null, lines: string[]): string {
  const list = lines.map((line) => `- ${line}`).join('\n');
  return intro ? `${intro}\n\n${list}` : list;
}

type Client = ReturnType<typeof createAdminClient>;

/** Every reason an announcement cannot go out, checked before anything is written. */
async function announceRefusal(
  adminClient: Client,
  actor: Awaited<ReturnType<typeof requireCapability>>,
  body: string,
): Promise<string | null> {
  const level = accessLevelFor(actor);
  if (!permits(level, permissionsOf(level, actor), 'announcements.create.write')) {
    return 'You cannot post announcements, so this cannot go out as one.';
  }
  if (body.length > ANNOUNCEMENT_BODY_LIMIT) {
    return `As an announcement this would be longer than ${ANNOUNCEMENT_BODY_LIMIT} characters. Post fewer lines at once.`;
  }
  const { data: season } = await adminClient.from('seasons').select('id').eq('active_flag', true).maybeSingle();
  if (!season) return 'No season is running, so an announcement cannot be posted. Untick the announcement box.';
  return null;
}

async function announce(
  adminClient: Client,
  entryId: string,
  title: string | null,
  body: string,
): Promise<void> {
  const announcement = await createAnnouncement({
    title: title ?? 'Club changes',
    body,
    type: 'info',
    target_audience: 'all',
    pinned: false,
    send_push: false,
    status: 'published',
    all_seasons: false,
  });
  const { error } = await adminClient
    .from('club_change_entries')
    .update({ announcement_id: announcement.id })
    .eq('id', entryId);
  if (error) throw new Error(`The announcement was posted but not linked to the entry: ${error.message}`);
}

export async function addClubChangeLine(text: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireCapability('changelog.post.write');
    const line = checkedLine(text);
    const adminClient = createAdminClient();
    const { error } = await adminClient.from('club_change_drafts').insert({
      source: 'manual',
      text_override: line,
      first_actor_id: actor.id,
      last_actor_id: actor.id,
    });
    if (error) throw new Error(`Could not add the line: ${error.message}`);
    revalidatePath('/club-changes');
  });
}

/**
 * Reword a line, or with empty text put an automatic line back to its own
 * sentence. Records the value the admin was looking at, so a later edit to
 * the same setting shows the rewording as out of date.
 */
export async function rewordClubChangeLine(id: string, text: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireCapability('changelog.post.write');
    const draftId = checkedId(id);
    const adminClient = createAdminClient();

    const { data: found } = await adminClient
      .from('club_change_drafts')
      .select('source, to_value, revision')
      .eq('id', draftId)
      .maybeSingle();
    if (!found) throw new ExpectedError('That line was posted or deleted since the page loaded.');
    const current = found as { source: string; to_value: unknown; revision: number };

    const blank = typeof text !== 'string' || text.trim() === '';
    if (blank && current.source === 'manual') {
      throw new ExpectedError('A line you added needs some text. Delete it instead.');
    }
    const line = blank ? null : checkedLine(text);

    const { data: written, error } = await adminClient
      .from('club_change_drafts')
      .update({
        text_override: line,
        override_to_value: line === null ? null : current.to_value,
        last_actor_id: actor.id,
        revision: current.revision + 1,
        changed_at: new Date().toISOString(),
      })
      .eq('id', draftId)
      .eq('revision', current.revision)
      .select('id');
    if (error) throw new Error(`Could not reword the line: ${error.message}`);
    if (!written || written.length === 0) {
      throw new ExpectedError('That line changed since the page loaded. Reload the page and try again.');
    }
    revalidatePath('/club-changes');
  });
}

export async function deleteClubChangeLine(id: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireCapability('changelog.post.write');
    const draftId = checkedId(id);
    const adminClient = createAdminClient();

    const { data: deleted, error } = await adminClient
      .from('club_change_drafts')
      .delete()
      .eq('id', draftId)
      .select(DRAFT_COLUMNS);
    if (error) throw new Error(`Could not delete the line: ${error.message}`);
    const row = (deleted as ClubChangeDraft[] | null)?.[0];
    if (!row) throw new ExpectedError('That line was already posted or deleted.');

    await logAdminAudit(adminClient, {
      actor_id: actor.id,
      action_type: 'club_change_draft_deleted',
      target_type: 'club_change_draft',
      target_id: row.id,
      old_value: {
        source: row.source,
        subject: row.subject,
        field: row.field,
        from_value: row.from_value,
        to_value: row.to_value,
        text: formatDraft(row).text,
      },
      reason: 'A pending club change line was deleted without being posted',
    });
    revalidatePath('/club-changes');
  });
}

export type PostClubChangesInput = {
  /** Each line to post, with the revision the page showed. */
  items: { id: string; revision: number }[];
  title?: string;
  intro?: string;
  /** Also post it as a club announcement, which the bot relays to Discord. */
  announce: boolean;
};

export type PostClubChangesResult = {
  entryId: string;
  announced: boolean;
  /** The entry is posted, but the announcement failed; the page offers a retry. */
  announceFailed: boolean;
};

export async function postClubChanges(input: PostClubChangesInput): Promise<ActionResult<PostClubChangesResult>> {
  return runAction(async () => {
    const actor = await requireCapability('changelog.post.write');
    const items = Array.isArray(input?.items) ? input.items : [];
    if (items.length === 0) throw new ExpectedError('Choose at least one line to post.');
    if (items.length > 100) throw new ExpectedError('Post at most 100 lines at once.');
    const seen = new Map<string, number>();
    for (const item of items) {
      const id = checkedId(item?.id);
      if (!Number.isInteger(item?.revision)) throw new ExpectedError('That line no longer exists.');
      if (seen.has(id)) throw new ExpectedError('The same line was chosen twice.');
      seen.set(id, item.revision);
    }
    const title = optionalText(input?.title, TITLE_MAX, 'title');
    const intro = optionalText(input?.intro, INTRO_MAX, 'intro');
    const wantsAnnouncement = input?.announce === true;

    const adminClient = createAdminClient();
    const { data: rows, error: readError } = await adminClient
      .from('club_change_drafts')
      .select(DRAFT_COLUMNS)
      .order('created_at');
    if (readError) throw new Error(`Could not read the pending lines: ${readError.message}`);
    const drafts = (rows ?? []) as ClubChangeDraft[];
    const byId = new Map(drafts.map((row) => [row.id, row]));

    const postIds: string[] = [];
    const revisions: number[] = [];
    const lines: string[] = [];
    for (const [id, revision] of seen) {
      const row = byId.get(id);
      if (!row || row.revision !== revision) throw postFailure('stale_changed');
      const formatted = formatDraft(row);
      if (formatted.noOp) continue;
      const refusal = postRefusal(formatted, row.text_override !== null);
      if (refusal) throw new ExpectedError(`${formatted.text}: ${refusal}`);
      postIds.push(id);
      revisions.push(revision);
      lines.push(formatted.text);
    }
    if (postIds.length === 0) throw new ExpectedError('None of these lines changes anything. Nothing was posted.');

    // A first save that only wrote the defaults is not a change. Those lines are
    // never shown, and they go with the next post rather than piling up.
    const posting = new Set(postIds);
    const discards = drafts.filter((row) => !posting.has(row.id) && formatDraft(row).noOp);

    const body = announcementBody(intro, lines);
    if (wantsAnnouncement) {
      const refusal = await announceRefusal(adminClient, actor, body);
      if (refusal) throw new ExpectedError(refusal);
    }

    const { data: entryId, error } = await adminClient.rpc('post_club_changes', {
      p_actor: actor.id,
      p_draft_ids: postIds,
      p_revisions: revisions,
      p_lines: lines,
      p_discard_ids: discards.map((row) => row.id),
      p_discard_revisions: discards.map((row) => row.revision),
      p_title: title,
      p_intro: intro,
    });
    if (error) throw postFailure(error.message);

    let announced = false;
    let announceFailed = false;
    if (wantsAnnouncement) {
      try {
        await announce(adminClient, entryId as string, title, body);
        announced = true;
      } catch (err) {
        console.error('[club-changes] the entry is posted but its announcement failed', err);
        announceFailed = true;
      }
    }

    revalidatePath('/club-changes');
    return { entryId: entryId as string, announced, announceFailed };
  });
}

/** Send a posted entry out as an announcement, when that did not happen at posting. */
export async function announceClubChangeEntry(entryId: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireCapability('changelog.post.write');
    const id = checkedId(entryId);
    const adminClient = createAdminClient();
    const { data: found } = await adminClient
      .from('club_change_entries')
      .select('id, title, intro, lines, announcement_id')
      .eq('id', id)
      .maybeSingle();
    if (!found) throw new ExpectedError('That entry no longer exists.');
    const entry = found as { id: string; title: string | null; intro: string | null; lines: unknown; announcement_id: string | null };
    if (entry.announcement_id) throw new ExpectedError('This entry has already been announced.');
    const lines = Array.isArray(entry.lines) ? entry.lines.filter((l): l is string => typeof l === 'string') : [];

    const body = announcementBody(entry.intro, lines);
    const refusal = await announceRefusal(adminClient, actor, body);
    if (refusal) throw new ExpectedError(refusal);
    await announce(adminClient, entry.id, entry.title, body);
    revalidatePath('/club-changes');
  });
}
