export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import Link from 'next/link';
import { AvatarChip, Badge, Card, PageHeader } from '@badminton/ui';
import { accessLevelFor } from '@/lib/permissions';
import { accessForLevel, EXEC_ROLE_OPTIONS } from '@/lib/console-access';
import { consolePasskeyGrace, graceDaysText } from '@/lib/passkey/grace';
import { memberAppUrl } from '@/lib/player-url';
import { PasskeySection } from './passkey-section';
import { SignOutOtherDevices } from './sign-out-other-devices';

// Personal settings ONLY. Platform configuration used to be an admin-gated
// block on this page; it now lives at /ratings and /accounts, which are
// admin-only sections in their own right. This page stays trainer-level
// (permissions.ts) purely so every console user can enrol their own passkeys —
// which is the reason nothing club-wide belongs here.
export default async function SettingsPage() {
  let player: Awaited<ReturnType<typeof getAuthenticatedConsoleUser>> | null = null;
  try {
    player = await getAuthenticatedConsoleUser();
  } catch {
    // Not authenticated or not exec/admin — show limited settings
  }
  const supabase = createAdminClient();

  const { data: passkeys } = player
    ? await supabase
        .from('passkey_credentials')
        // enrolled_via (00051) travels with the row so this list and the
        // members'-app list show the SAME credentials described the same way,
        // and so the passkey hint below can tell the truth: only
        // admin-enrolled credentials arm the console gate.
        .select('id, nickname, created_at, last_used_at, transports, enrolled_via')
        .eq('player_id', player.id)
        .order('created_at')
    : { data: null };

  // WHETHER GOOGLE IS LINKED, from GoTrue's own identities list. A failed
  // lookup reads "Unknown", never "Not linked": that is a claim about the
  // account, and an error is a claim about the request.
  let google: 'Linked' | 'Not linked' | 'Unknown' = 'Unknown';
  if (player?.user_id) {
    const { data, error } = await supabase.auth.admin.getUserById(player.user_id as string);
    if (!error && data?.user) {
      google = (data.user.identities ?? []).some((i) => i.provider === 'google') ? 'Linked' : 'Not linked';
    }
  }

  const passkeyList = passkeys ?? [];
  const gateArmed = passkeyList.some((pk) => pk.enrolled_via === 'admin');

  // The 14-day window without a console passkey (00262). Null when it could
  // not be read, or has not started; the copy then stays vague rather than
  // promising days nobody counted.
  let grace: ReturnType<typeof consolePasskeyGrace> = null;
  if (player?.user_id && !gateArmed) {
    const { data: row } = await supabase
      .from('console_passkey_grace')
      .select('started_at')
      .eq('user_id', player.user_id as string)
      .maybeSingle();
    grace = row ? consolePasskeyGrace(row.started_at, Date.now()) : null;
  }
  const roleLabel = player
    ? EXEC_ROLE_OPTIONS.find((o) => o.value === accessForLevel(accessLevelFor(player)))?.label
    : undefined;

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-7">
      <PageHeader
        eyebrow="YOUR CONSOLE"
        title="Settings"
        sub="Your console profile, passkeys, sign-in and app version"
        watermark="S"
        className="!mb-0"
      />

      {player ? (
        <>
          <Card className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <AvatarChip
              name={player.full_name as string}
              id={player.id as string}
              src={player.avatar_url as string | null}
              size="xl"
            />
            <div className="flex min-w-0 flex-grow flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[18px] font-semibold text-[var(--ink)]">{player.full_name}</span>
                {roleLabel && <Badge variant="neutral">{roleLabel}</Badge>}
              </div>
              <span className="truncate text-[14px] text-[var(--ink-2)]">{player.email}</span>
              <span className="text-[13px] text-[var(--mute)]">Ask an admin to change your name or access.</span>
            </div>
            {/* next/link applies the base path itself, so no withBase here. */}
            <Link
              href="/dashboard?tour=exec"
              className="inline-flex min-h-[40px] flex-shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-[var(--line)] px-4 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
            >
              Replay console tour
            </Link>
          </Card>

          <div data-tour="passkeys">
          <Card className="overflow-hidden p-0">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] px-6 py-5">
              <div className="flex min-w-0 flex-col gap-1">
                <SectionTitle>Passkeys</SectionTitle>
                <p className="text-[14px] text-[var(--mute)]">
                  Once you enroll one, every login requires a passkey check.
                </p>
              </div>
              <span className="font-mono text-[12px] text-[var(--mute)]">
                {passkeyList.length === 0
                  ? 'None yet'
                  : passkeyList.length === 1
                    ? '1 device'
                    : `${passkeyList.length} devices`}
              </span>
            </div>
            <PasskeySection passkeys={passkeyList} graceDaysLeft={grace && !grace.expired ? grace.daysLeft : null} />
          </Card>
          </div>

          <Card className="overflow-hidden p-0">
            <div className="border-b border-[var(--line)] px-6 py-5">
              <SectionTitle>Sign-in</SectionTitle>
            </div>
            <SignInRow
              label="Email code"
              hint="Always available. A 6-digit code is sent to your email."
              aside={<StateText tone="success">ON</StateText>}
            />
            <SignInRow
              label="Google"
              hint="Sign in with Google from the sign-in page."
              aside={
                <StateText tone={google === 'Linked' ? 'success' : 'mute'}>{google.toUpperCase()}</StateText>
              }
            />
            <SignInRow
              label="Passkey gate"
              hint={
                gateArmed
                  ? 'A passkey enrolled here is checked at every console login.'
                  : grace?.expired
                    ? 'The window has ended. Add a passkey above to keep using the console.'
                    : grace
                      ? `No passkey added here yet. The console opens without one for ${graceDaysText(grace.daysLeft)} more.`
                      : 'No passkey added here yet. The console will ask for one soon.'
              }
              aside={
                <StateText tone={gateArmed ? 'success' : 'warning'}>
                  {gateArmed ? 'ON' : grace && !grace.expired ? `GRACE: ${grace.daysLeft}D` : 'REQUIRED'}
                </StateText>
              }
            />
            <SignInRow
              label="Sign out other devices"
              hint="Ends your console and member-app sessions on every other device. You stay signed in here."
              aside={<SignOutOtherDevices />}
            />
          </Card>
        </>
      ) : (
        <Card>
          <p className="text-[14px] text-[var(--mute)]">Your profile could not be loaded.</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-[var(--line)] px-6 py-4">
        <span className="text-[14px] text-[var(--ink-2)]">Club Ladder console</span>
        <div className="flex items-center gap-3">
          <a
            href={memberAppUrl('/whats-new')}
            className="text-[13px] text-[var(--mute)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
          >
            What&apos;s new
          </a>
          <span className="rounded-full border border-[var(--line)] px-2.5 py-0.5 font-mono text-[12px] text-[var(--mute)]">
            v{process.env.NEXT_PUBLIC_APP_VERSION}
          </span>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-[22px] font-bold uppercase leading-tight tracking-[0.04em] text-[var(--ink)]"
      style={{ fontFamily: 'var(--display)' }}
    >
      {children}
    </h2>
  );
}

function SignInRow({ label, hint, aside }: { label: string; hint: string; aside: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--line)] px-6 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] font-semibold text-[var(--ink)]">{label}</span>
        <span className="text-[13px] text-[var(--mute)]">{hint}</span>
      </div>
      <div className="flex-shrink-0">{aside}</div>
    </div>
  );
}

function StateText({ tone, children }: { tone: 'success' | 'warning' | 'mute'; children: React.ReactNode }) {
  const color =
    tone === 'success'
      ? 'text-[var(--color-success)]'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--mute)]';
  return <span className={`font-mono text-[11px] tracking-[0.1em] ${color}`}>{children}</span>;
}
