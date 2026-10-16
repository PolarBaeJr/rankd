import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { isExpectedFailure, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordMember, resolveDiscordPlayer, type PlayRefusal } from '@/lib/discord-member';
import { checkFeeSubmission, fileFeeSubmission, type ReceiptFeeType } from '@/lib/fee-submission-core';
import { downloadDiscordReceipt, parseFeeChoice, type ReceiptFileFailure } from '@/lib/discord-receipt-file';
import { latestSubmission, seasonFeeFor, type OwnFeeRow } from '@/lib/member-fees';
import { canUploadReceipt, money } from '@/lib/fees';
import { getMembershipPayments } from '@/lib/club-socials';

export const dynamic = 'force-dynamic';

// Discord /receipt, and the picker behind its `fee` option.
//
// THE CALLER IS THE ACTOR, and the caller is the Discord id the bot read off
// the interaction, resolved through player_discord_links (discord-member.ts).
// An unlinked caller is refused with 'not_linked'; nothing here ever matches a
// Discord account to a member by name or email.
//
// THE SAME RULES AS THE MEMBERSHIP PAGE, through the same code. The gates are
// the ones the web action runs (standing, lapsed, the fees switch, and no
// waiver), and the receipt is filed by fileFeeSubmission, which the web action
// calls too: one pending receipt per fee, sfu_rec only on dues, the reference
// patterns, the e-transfer address. The one difference: the method is never
// guessed here (the website reads it off the screenshot in the browser), so a
// dues receipt from Discord is stored with no method and the exec picks.
//
// DISCORD OFFERS DUES AND CLUB EVENTS ONLY. Tournament entries are paid
// through the tournament's own flow on the website; the picker never lists
// one and the write refuses one, since an autocomplete value can be typed.
//
// THE SCREENSHOT is downloaded here from Discord's CDN (discord-receipt-file.ts)
// and stored in fee-proofs under the member's own auth folder, which is where
// the website puts it and where the account purge looks for it.
//
// A REFUSAL IS A 200 WITH A CODE, as the challenge routes do it. 'rule' carries
// the app's own sentence; 'file' carries which file check failed.

type Refusal = PlayRefusal | 'no_login' | 'invalid' | 'rule' | 'file';

function refuse(refusal: Refusal, extra: { message?: string; file?: ReceiptFileFailure } = {}) {
  return NextResponse.json({ ok: false, refusal, ...extra });
}

const SNOWFLAKE = /^\d{5,25}$/;
const DISCORD_FEE_TYPES: readonly ReceiptFeeType[] = ['dues', 'event'];

// Per member, per hour, counting downloads only. Each is up to 8 MB fetched and
// stored, and the one-pending-receipt rule already stops a second row for the
// same fee, so this only bounds the volume. Keyed on the Discord id, never the IP: every
// request comes from the one bot process. In memory and per replica, like the
// feedback route's; see docs/ops/rate-limits.md.
const RECEIPTS_PER_HOUR = 6;

const MAX_CHOICES = 25;

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '');
  const discordUserId = str('discordUserId');
  const fee = str('fee');
  const reference = str('reference');
  const attachmentUrl = str('attachmentUrl');

  if (!SNOWFLAKE.test(discordUserId)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordPlayer(supabase, discordUserId, { feature: 'fees', waiver: false });
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(caller.refusal);
  }
  const player = caller.player;

  // The fee-proofs folder is the AUTH user's, as on the website: the bucket's
  // policy and the account purge both key on it. A member with no login has
  // no folder, and could not send one from the website either.
  const authUserId = typeof player.user_id === 'string' ? player.user_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(authUserId)) return refuse('no_login');

  const choice = parseFeeChoice(fee);
  if (!choice) return refuse('invalid', { message: 'Pick the fee from the list.' });

  const input = { ...choice, reference, detectedMethod: null };

  // Every rule that needs no file, BEFORE the download: a refusal here costs
  // nothing and stores nothing.
  try {
    await checkFeeSubmission(supabase, player, input, { feeTypes: DISCORD_FEE_TYPES });
  } catch (err) {
    if (isExpectedFailure(err)) return refuse('rule', { message: (err as Error).message });
    throw err;
  }

  // Counted here, just before the download it exists to bound, so a typo or a
  // refusal above does not spend a member's allowance.
  const limited = rateLimit(`discord:receipt:${discordUserId}`, RECEIPTS_PER_HOUR, 3600_000);
  if (!limited.success) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const file = await downloadDiscordReceipt(attachmentUrl);
  if (!file.ok) return refuse('file', { file: file.failure });

  const path = `${authUserId}/${randomUUID()}.${file.extension}`;
  const { error: uploadError } = await supabase.storage
    .from('fee-proofs')
    .upload(path, file.bytes, { contentType: file.contentType, upsert: false });
  if (uploadError) {
    console.error('[discord] receipt upload failed:', uploadError.message);
    return NextResponse.json({ error: 'upload_failed' }, { status: 503 });
  }

  try {
    await fileFeeSubmission(supabase, player, { ...input, screenshotPath: path }, { feeTypes: DISCORD_FEE_TYPES });
  } catch (err) {
    const { error: removeError } = await supabase.storage.from('fee-proofs').remove([path]);
    if (removeError) console.error('[discord] could not remove an orphaned receipt upload:', removeError.message);
    if (isExpectedFailure(err)) return refuse('rule', { message: (err as Error).message });
    console.error('[discord] receipt insert failed:', err);
    return NextResponse.json({ error: 'insert_failed' }, { status: 503 });
  }

  try {
    revalidatePath('/membership');
    revalidatePath('/feed');
  } catch (err) {
    Sentry.captureException(err, { extra: { step: 'discord-receipt-revalidate' } });
  }

  // Nothing about the receipt comes back: no amount, no reference, no path.
  return NextResponse.json({ ok: true });
}

type ActiveSeason = { id: string; name: string; competitive_fee_cents: number; recreational_fee_cents: number };

/**
 * The caller's own fees a receipt can be sent for, for the /receipt picker:
 * this season's dues and club event fees, unpaid, priced, with no receipt
 * already waiting, exactly as the Membership page offers its form
 * (canUploadReceipt). A refusal answers an empty list: the picker has nowhere
 * to show one.
 */
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const discordUserId = request.headers.get('x-discord-user-id') ?? '';
  if (!SNOWFLAKE.test(discordUserId)) return NextResponse.json({ fees: [] });

  // The link alone, as the challenge picker does: this writes nothing and runs
  // inside a one-second budget. The command it feeds runs the full gate.
  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordMember(supabase, discordUserId);
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return NextResponse.json({ fees: [] });
  }
  const player = caller.player as typeof caller.player & { is_exec?: boolean | null; fee_exempt?: boolean | null };

  // Paid rows are read too and skipped below: a paid dues row is what says
  // this season's dues need no receipt. The season is read the way the filing
  // reads it (active_flag), so the picker and the write agree on "running".
  const [feesRead, seasonRead, payments] = await Promise.all([
    supabase
      .from('club_fees')
      .select('id, fee_type, season_id, club_event_id, amount_cents, paid_at, fee_submissions(id, status, reference, reject_reason, submitted_at)')
      .eq('player_id', player.id)
      .in('fee_type', ['dues', 'event'])
      .order('created_at', { ascending: false }),
    supabase
      .from('seasons')
      .select('id, name, competitive_fee_cents, recreational_fee_cents')
      .eq('active_flag', true)
      .maybeSingle(),
    getMembershipPayments(),
  ]);
  if (feesRead.error || seasonRead.error) {
    console.error('[discord] receipt picker read failed:', feesRead.error?.message ?? seasonRead.error?.message);
    return NextResponse.json({ error: 'fees_unavailable' }, { status: 503 });
  }

  type Row = Pick<OwnFeeRow, 'id' | 'fee_type' | 'season_id' | 'club_event_id' | 'amount_cents' | 'paid_at' | 'fee_submissions'>;
  const rows = (feesRead.data ?? []) as unknown as Row[];
  const season = (seasonRead.data ?? null) as ActiveSeason | null;
  const etransferConfigured = Boolean(payments.etransferEmail);
  const exempt = Boolean(player.is_exec || player.fee_exempt);
  const fees: { id: string; label: string }[] = [];

  // This season's dues, with or without a row yet, never for an exec or an
  // exempt member, and not once the row is paid (or waived). Past seasons'
  // dues are settled with an exec, as on the page.
  if (season && !exempt) {
    const row = rows.find((r) => r.fee_type === 'dues' && r.season_id === season.id);
    // An unpriced dues row is priced by status, as the page shows it and as
    // filing the receipt prices it.
    const owedCents = row?.amount_cents ?? seasonFeeFor(player.status, season);
    const waiting = latestSubmission(row)?.status === 'submitted';
    if (!row?.paid_at && canUploadReceipt({ kind: 'season', owedCents, waiting, etransferConfigured })) {
      fees.push({
        id: row ? `fee:${row.id}` : `dues:${season.id}`,
        label: `${season.name} membership - ${money(owedCents)}`,
      });
    }
  }

  const events = rows.filter((row) => {
    if (row.fee_type !== 'event' || row.paid_at || !row.club_event_id) return false;
    const waiting = latestSubmission(row)?.status === 'submitted';
    return canUploadReceipt({ kind: 'event', owedCents: row.amount_cents, waiting, etransferConfigured });
  });

  // One read for the names, as the Membership page does it. A name that
  // cannot be read falls back to a generic label rather than hiding the fee.
  const titles = new Map<string, string>();
  if (events.length > 0) {
    const { data, error } = await supabase
      .from('club_events')
      .select('id, title')
      .in('id', [...new Set(events.map((row) => row.club_event_id as string))]);
    if (error) console.error('[discord] receipt picker event names failed:', error.message);
    for (const event of (data ?? []) as { id: string; title: string | null }[]) {
      if (event.title) titles.set(event.id, event.title);
    }
  }
  for (const row of events) {
    fees.push({
      id: `fee:${row.id}`,
      label: `${titles.get(row.club_event_id as string) ?? 'Club event'} - ${money(row.amount_cents)}`,
    });
  }

  return NextResponse.json({ fees: fees.slice(0, MAX_CHOICES) });
}
