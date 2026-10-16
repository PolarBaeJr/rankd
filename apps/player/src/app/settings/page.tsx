'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Input, Textarea, Switch, Select, PageHeader, Dialog } from '@badminton/ui';
import { updateProfile, updateNotificationPreferences, deleteMyAccount, getMyCompetitionCategory, getMyMediaConsent, setMyMediaConsent } from '@/lib/actions';
import { NOTIFICATION_CATEGORIES, normalizeNotificationPreferences, normalizeEmailPreferences, emailPreferenceKey, joinName, getReminderLeadMinutes, REMINDER_LEAD_MIN_MINUTES, REMINDER_LEAD_MAX_MINUTES, hasConsoleAccess, getAccountStanding, normalizeHandle, handleError, formatMemberCode, clubDate, HANDLE_MAX_LENGTH, HANDLE_TAKEN_MESSAGE, COMPETITION_CATEGORY_CHOICES, toCompetitionCategory, type CompetitionCategory, type NotificationCategory } from '@badminton/shared';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { signOutEverywhere, signOutThisDevice } from '@badminton/shared/src/utils/sign-out';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { AvatarUpload } from '@/components/AvatarUpload';
import { CalendarFeed } from './calendar-feed';
import { DataExport } from './data-export';
import { PasskeyManager } from '@/components/passkey-manager';
import { PasswordManager } from '@/components/password-manager';
import { SignOutOtherDevices } from '@/components/sign-out-other-devices';
import {
  User,
  Calendar,
  Moon,
  Sun,
  Monitor,
  Bell,
  BellOff,
  KeyRound,
  Lock,
  Shield,
  LogOut,
  Info,
  Check,
  Save,
  Palette,
  Loader2,
  Receipt,
  ChevronRight,
  MessageSquareWarning,
  Trash2,
  Camera,
} from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

const themeOptions: { value: Theme; icon: React.ElementType; label: string }[] = [
  { value: 'light',  icon: Sun,     label: 'Light' },
  { value: 'dark',   icon: Moon,    label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <Icon size={16} className="text-[var(--mute)]" />
        <h3 className="settings-section-title" style={{ margin: 0 }}>{title}</h3>
      </div>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [handle, setHandle] = useState('');
  // Only the server can answer "is it taken" — the unique index decides it, and
  // it decides it at the moment of the write. Held separately from the shape
  // rules below so typing clears it: the answer is about a value that is no
  // longer in the box.
  const [handleTaken, setHandleTaken] = useState(false);
  const [memberCode, setMemberCode] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setThemeState] = useState<Theme>('dark');
  // 00111 — which tournament draw this member competes in, headed "Gender"
  // since 00129. '' is undeclared, which is where every member starts and where
  // they may stay: it is the stored NULL, not a sentinel this form invents.
  const [competitionCategory, setCompetitionCategory] = useState<CompetitionCategory | ''>('');
  // THE VALUE AS THE SERVER LAST CONFIRMED IT, which is what decides the lock —
  // held apart from the box above precisely because the box changes as somebody
  // types and the lock must not. Non-null means "already declared", and after
  // 00129 that means the member cannot change it: not to the other value, and
  // not back to "prefer not to say" either.
  //
  // No second fetch and no second predicate: getMyCompetitionCategory already
  // returns exactly this, and "locked" is defined as its being non-null. A
  // separate is-locked flag could disagree with the database trigger; this
  // cannot.
  const [declaredCategory, setDeclaredCategory] = useState<CompetitionCategory | null>(null);
  const [showOnLeaderboard, setShowOnLeaderboard] = useState(true);
  // 00255. Saved on its own, never by Save profile, and read through a server
  // action because members hold no SELECT grant on either column.
  const [mediaConsent, setMediaConsent] = useState(false);
  const [mediaConsentChangedAt, setMediaConsentChangedAt] = useState<string | null>(null);
  // A failed read must not say "Not turned on" to somebody who has consented.
  const [mediaConsentLoadFailed, setMediaConsentLoadFailed] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<Record<NotificationCategory, boolean>>(
    () => normalizeNotificationPreferences({}),
  );
  // Email is tracked separately from push: they are different enough that one
  // switch for both is wrong — push is a phone buzzing mid-match, email is
  // something you read later.
  const [emailPrefs, setEmailPrefs] = useState<Record<NotificationCategory, boolean>>(
    () => normalizeEmailPreferences({}),
  );
  // Free-form: a number plus a unit, stored as minutes.
  const [leadValue, setLeadValue] = useState('2');
  const [leadUnit, setLeadUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [playerId, setPlayerId] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // TWO different questions, deliberately kept apart:
  //   isExec         — is this person on the club exec? Drives the note saying
  //                    where their OTHER bio is edited. Until 00130 this field
  //                    WAS their exec page bio (00042); it no longer is, and the
  //                    note is what stops an officer wondering where it went.
  //                    A varsity trainer is NOT an exec and their bio is private.
  //   canOpenConsole — may this person open the admin console at all? Trainers
  //                    can, so this is strictly wider than isExec.
  const [isExec, setIsExec] = useState(false);
  const [canOpenConsole, setCanOpenConsole] = useState(false);
  // Fees and the calendar feed are member features the server rejects unless
  // the account is in good standing (requirePlayer throws "Account pending
  // approval" / "Account suspended"), so showing them just produced a dead
  // panel. getAccountStanding is the same three checks requirePlayer makes —
  // the hand-rolled status test this replaced missed is_banned entirely.
  const [isApproved, setIsApproved] = useState(true);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      // getSession, not getUser: this id is only a FILTER. Every read below is
      // authorized by the database (RLS and players_self's auth.uid()) or by the
      // server action, never by this value, so a GoTrue round trip to re-verify
      // it bought nothing but one more wait before the form could fill in. The
      // session is read from the cookie locally.
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;
      // ALL FOUR AT ONCE. They are independent, and awaiting them in turn made
      // this page four browser round trips deep before a single field appeared.
      const [{ data }, { data: identity }, mine, media] = await Promise.all([
        // players_self is filtered to auth.uid() server-side, so it returns only
        // this user's row — including the phone and notification preferences
        // that 00032 withholds from the plain players grant.
        supabase.from('players_self').select('*').maybeSingle(),
        // NOT from players_self. Postgres expands `SELECT *` when a view is
        // CREATEd and freezes the column list into it, so the view still returns
        // exactly the columns players had in 00032 — handle and member_code are
        // not among them, and re-creating it would also undo 00060's deliberate
        // exclusion of inactivity_notice_sent_at. Read the two from the base
        // table instead: players_select opens the caller's own row to them, and
        // 00092's column grant is what makes them public anyway.
        supabase
          .from('players')
          .select('handle, member_code')
          .eq('user_id', user.id)
          .maybeSingle(),
        // NOT read here at all. competition_category (00111) has no SELECT grant
        // for `authenticated` — on purpose, because players_select admits any
        // member to any approved member's row, so a grant would hand everybody's
        // category to everybody. The member's own value comes back through a
        // server action that reads it with the service-role key for the caller
        // and nobody else. Adding the column to the select above would not leak
        // anything by itself; it would simply return nothing, and the grant that
        // "fixed" it would be the leak.
        getMyCompetitionCategory(),
        getMyMediaConsent(),
      ]);
      if (data) {
        setPlayerId(data.id);
        setAvatarUrl(data.avatar_url);
        setFirstName(data.first_name);
        setLastName(data.last_name || '');
        setHandle(identity?.handle || '');
        setMemberCode(identity?.member_code ?? null);
        setCompetitionCategory(mine.ok ? (mine.data ?? '') : '');
        // FAILS OPEN, and it has to: a failed read must not present a member
        // who has never declared anything with a permanent "locked" panel they
        // can do nothing about. The cost of failing open is a refusal from the
        // trigger on save, which arrives as its own sentence (see updateProfile
        // — the lock's SQLSTATE is mapped to an ExpectedError). The database is
        // the lock; this is the label on it.
        setDeclaredCategory(mine.ok ? (mine.data ?? null) : null);
        setPhone(data.phone || '');
        setBio(data.bio || '');
        setShowOnLeaderboard(!data.hide_from_leaderboard);
        if (media.ok) {
          setMediaConsent(media.data.consent);
          setMediaConsentChangedAt(media.data.changedAt);
        } else {
          setMediaConsentLoadFailed(true);
        }
        setNotifPrefs(normalizeNotificationPreferences(data.notification_preferences));
        setEmailPrefs(normalizeEmailPreferences(data.notification_preferences));
        const mins = getReminderLeadMinutes(data.notification_preferences);
        // Show it back in the largest unit that divides evenly, so "120" reads
        // as "2 hours" rather than a raw minute count.
        if (mins % 1440 === 0) { setLeadValue(String(mins / 1440)); setLeadUnit('days'); }
        else if (mins % 60 === 0) { setLeadValue(String(mins / 60)); setLeadUnit('hours'); }
        else { setLeadValue(String(mins)); setLeadUnit('minutes'); }
        // `is_exec` ALONE, not `|| role === 'admin'`. It was the wider test
        // while the note only claimed "your bio is public", where an admin who
        // is not on the exec team read a sentence that was merely untrue for
        // them. 00130's note LINKS to /exec, and that page hands an editor to
        // exactly the officers get_executives() returns — `is_exec AND
        // active_flag` — so the wider test would send a non-exec admin to a
        // page with no card of theirs on it and nothing to edit. Three places
        // now agree on one predicate: the function's filter, updateExecBio's
        // gate, and this note.
        setIsExec(!!data.is_exec);
        // The SAME predicate the top bar uses (layout.tsx) and the same one the
        // console itself enforces — never a second hand-rolled boolean. This
        // page used to test `is_exec || role === 'admin'`, which predates the
        // varsity trainer role, so trainers saw the console link in the top bar
        // and nothing here. players_self is `SELECT *`, so the standing columns
        // hasConsoleAccess needs (is_banned, status, active_flag) are present.
        setCanOpenConsole(hasConsoleAccess(data));
        // getAccountStanding, not a hand-rolled status test: the old one missed
        // is_banned, so a banned member kept every control on this page.
        setIsApproved(getAccountStanding(data).ok);
        setLoaded(true);
      }
    }
    load();
    const saved = (localStorage.getItem('theme') as Theme) || 'dark';
    setThemeState(saved);
    // Migrate existing localStorage-only users to the cookie so SSR picks it up.
    if (!/(?:^|; )theme=/.test(document.cookie)) {
      document.cookie = `theme=${saved}; path=/; max-age=31536000; samesite=lax`;
    }
    setPushSupported(isPushSupported());
    isPushEnabled().then(setPushEnabled);
  }, []);

  function handleThemeChange(newTheme: Theme) {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    // Also persist to a cookie so the server can set data-theme on first paint
    // (no flash). 1-year expiry, lax so it rides normal navigations.
    document.cookie = `theme=${newTheme}; path=/; max-age=31536000; samesite=lax`;
    const resolved = newTheme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : newTheme;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  // The same rules the server action applies, run against the same normalized
  // value — so the field says what is wrong while it is being typed instead of
  // after a round trip. The server still checks; this is only the earlier of the
  // two answers.
  const handleShapeError = handleError(normalizeHandle(handle));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (handleShapeError) {
      toast(handleShapeError, 'error');
      return;
    }
    setLoading(true);
    setHandleTaken(false);
    try {
      const res = await updateProfile({
        first_name: firstName,
        last_name: lastName || undefined,
        // Always sent, unlike the fields above: '' is how a member CLEARS their
        // handle, and `|| undefined` would make that the one edit the form
        // cannot save.
        handle,
        phone: phone || undefined,
        bio: bio || undefined,
        // OMITTED ONCE DECLARED (00129), not sent-as-unchanged. The trigger
        // would accept the same value back — it compares with IS DISTINCT FROM
        // precisely so an ordinary profile save is not a refusal — but sending
        // a field this form is not offering to change is how a stale tab turns
        // into a mystery error. While it is still unlocked, '' is sent as null:
        // "prefer not to say" is a real answer and the one every member starts
        // on, so it has to be an edit the form can save.
        competition_category: declaredCategory !== null
          ? undefined
          : (competitionCategory === '' ? null : competitionCategory),
        hide_from_leaderboard: !showOnLeaderboard,
      });
      if (!res.ok) {
        if (res.error === HANDLE_TAKEN_MESSAGE) setHandleTaken(true);
        toast(res.error, 'error');
        setLoading(false);
        return;
      }
      // The save that declared a Gender is the one that locks it. Recorded here
      // rather than by re-reading, so the control switches to its locked state
      // in the same beat as the toast — a member who saves and still sees an
      // open dropdown will reasonably assume they can change it again.
      if (declaredCategory === null && competitionCategory !== '') {
        setDeclaredCategory(competitionCategory);
      }
      setSaved(true);
      toast('Profile updated', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handlePushToggle(enabled: boolean) {
    setPushLoading(true);
    try {
      if (enabled) {
        const ok = await subscribeToPush(playerId);
        if (ok) {
          setPushEnabled(true);
          toast('Push notifications enabled', 'success');
        } else {
          toast('Could not enable push notifications', 'error');
        }
      } else {
        await unsubscribeFromPush(playerId);
        setPushEnabled(false);
        toast('Push notifications disabled', 'info');
      }
    } catch {
      toast('Failed to update push settings', 'error');
    }
    setPushLoading(false);
  }

  const leadMinutes =
    (Number(leadValue) || 0) * (leadUnit === 'days' ? 1440 : leadUnit === 'hours' ? 60 : 1);
  const leadInvalid =
    !leadValue || leadMinutes < REMINDER_LEAD_MIN_MINUTES || leadMinutes > REMINDER_LEAD_MAX_MINUTES;

  async function saveReminderLead(minutes: number) {
    if (leadInvalid) return;
    const res = await updateNotificationPreferences({ ...notifPrefs, session_reminder_lead_minutes: minutes });
    if (!res.ok) toast(res.error, 'error');
  }

  async function handleEmailPrefToggle(category: NotificationCategory, value: boolean) {
    const previous = emailPrefs;
    const next = { ...emailPrefs, [category]: value };
    setEmailPrefs(next); // optimistic
    // Sent under the `email_` prefix the server whitelists. The action merges
    // onto the stored blob, so this cannot clobber the push toggles.
    const res = await updateNotificationPreferences(
      Object.fromEntries(
        Object.entries(next).map(([k, v]) => [emailPreferenceKey(k as NotificationCategory), v]),
      ),
    );
    if (!res.ok) {
      setEmailPrefs(previous); // revert
      toast(res.error, 'error');
    }
  }

  async function handleMediaConsentToggle(value: boolean) {
    const previous = { consent: mediaConsent, changedAt: mediaConsentChangedAt };
    setMediaConsent(value); // optimistic
    const res = await setMyMediaConsent({ media_consent: value });
    if (!res.ok) {
      setMediaConsent(previous.consent); // revert
      setMediaConsentChangedAt(previous.changedAt);
      toast(res.error, 'error');
      return;
    }
    setMediaConsent(res.data.consent);
    setMediaConsentChangedAt(res.data.changedAt);
    setMediaConsentLoadFailed(false);
    toast(
      res.data.consent ? 'Photo and video consent turned on' : 'Photo and video consent turned off',
      res.data.consent ? 'success' : 'info',
    );
  }

  async function handleNotifPrefToggle(category: NotificationCategory, value: boolean) {
    const previous = notifPrefs;
    const next = { ...notifPrefs, [category]: value };
    setNotifPrefs(next); // optimistic
    const res = await updateNotificationPreferences(next);
    if (!res.ok) {
      setNotifPrefs(previous); // revert
      toast(res.error, 'error');
    }
  }

  async function handleSignOut() {
    await signOutThisDevice(createClient().auth);
    router.push('/login');
  }

  async function handleDeleteAccount() {
    setDeleteLoading(true);
    try {
      const res = await deleteMyAccount(deleteConfirm);
      if (!res.ok) {
        toast(res.error, 'error');
        setDeleteLoading(false);
        return;
      }
      // Best-effort sign out, then a hard redirect — router state is stale
      // after the account is scheduled for deletion.
      await signOutEverywhere(createClient().auth);
      window.location.href = '/';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete account', 'error');
      setDeleteLoading(false);
    }
  }

  return (
    <div data-screen-label="Settings" style={{ maxWidth: 1120, margin: '0 auto' }}>
      <PageHeader
        title="Settings"
      />

      {!loaded ? (
        <div className="feed-col">
          <div className="skeleton" style={{ height: 220, borderRadius: 'var(--r-lg)' }} />
          <div className="skeleton" style={{ height: 120, borderRadius: 'var(--r-lg)' }} />
        </div>
      ) : (
        <div className="feed-col">
          <Section icon={User} title="Profile">
            {playerId && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
                <AvatarUpload
                  playerId={playerId}
                  playerName={joinName(firstName, lastName)}
                  currentUrl={avatarUrl}
                  onUploaded={setAvatarUrl}
                />
              </div>
            )}
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Input label="First name"          value={firstName}   onChange={(e) => setFirstName(e.target.value)} required />
              <Input label="Last name"           value={lastName}    onChange={(e) => setLastName(e.target.value)} placeholder="Optional" />
              {/* The handle REPLACES the old free-text "display name /
                  nickname": one chosen name per member, unique, and the thing
                  the club is searched by. The column is still there and still
                  populated — every handle was derived from it (00092) — but
                  nothing writes or shows it any more.

                  Lowercased as it is typed rather than on save, so the box
                  always shows what will actually be stored — and so "Kiera is
                  taken" never appears next to a field reading `Kiera` that the
                  member believes is a different name. */}
              <div>
                <Input
                  label="Handle"
                  value={handle}
                  onChange={(e) => { setHandle(e.target.value.toLowerCase()); setHandleTaken(false); }}
                  placeholder="Optional"
                  maxLength={HANDLE_MAX_LENGTH}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  error={handleTaken ? HANDLE_TAKEN_MESSAGE : handleShapeError ?? undefined}
                />
                <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Shown to other members as @{normalizeHandle(handle) ?? 'yourname'}. Letters,
                  numbers and underscores; 3–{HANDLE_MAX_LENGTH} characters.
                </p>
              </div>
              {/* Assigned by the club, never typed — so it is stated here rather
                  than offered as a field. A member who has not been approved yet
                  has none, and sees nothing. */}
              {memberCode !== null && (
                <div className="settings-row">
                  <div>
                    <div className="settings-row-label">Member code</div>
                    <div className="settings-row-hint">Assigned when you joined the club. It never changes.</div>
                  </div>
                  <div className="settings-row-control">
                    <span className="mono tag">{formatMemberCode(memberCode)}</span>
                  </div>
                </div>
              )}
              <Input label="Phone"               value={phone}       onChange={(e) => setPhone(e.target.value.replace(/[^\d\s+\-()]/g, ''))} placeholder="Optional" inputMode="tel" />
              <Textarea label="Bio"              value={bio}         onChange={(e) => setBio(e.target.value)} placeholder="A few words about yourself" />
              {/* Execs only, and it now says the OPPOSITE of what it said from
                  00042 until 00130. This field was the exec page bio; it is not
                  any more (players.exec_bio is), and it is published nowhere.
                  Pointing at where the other one lives matters more than ever
                  here — an officer who wrote their public blurb in this box
                  needs to be told, on this screen, that editing it here no
                  longer changes the club page. */}
              {isExec && (
                <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
                  Your personal bio. It&apos;s shown on your ladder profile to other
                  members, and nowhere public. Your bio on the club&apos;s{' '}
                  <Link href="/exec" style={{ color: 'inherit', textDecoration: 'underline' }}>exec page</Link> is a
                  separate one, edited there.
                </p>
              )}
              {/* 00111, relabelled and locked by 00129. This is the member's
                  own value on their own page. It is not on the roster, not on
                  the ladder and not on their public profile; the one other
                  screen that shows it is the member Edit dialog in the console,
                  because an exec cannot change a value they are not shown.

                  TWO STATES, AND THE SECOND IS NOT A DISABLED DROPDOWN. Once
                  the member has declared one the database refuses every later
                  change from them, so a greyed-out <Select> would be a control
                  that looks like it might work — it would still open on a
                  phone, and it would still say "Prefer not to say" as though it
                  were reachable. The declared state is a statement of the value
                  plus who to ask, in the same shape as Member code above, which
                  is the other field on this page nobody edits themselves. */}
              {declaredCategory !== null ? (
                <div className="settings-row">
                  <div>
                    <div className="settings-row-label">Gender</div>
                    <div className="settings-row-hint">
                      Set once, so this is now changed by an exec rather than
                      here — ask one if it is wrong. It decides which gendered
                      draws you can enter at club tournaments; Open events are
                      open to everyone whatever it says, and only you and the
                      tournament desk see it.
                    </div>
                  </div>
                  {/* NOT the `.tag` the Member code row uses, and that is the
                      one deliberate departure from copying it. `.tag` is
                      uppercase mono, which is right for a seven-character code
                      and reads as shouting for a person's answer about
                      themselves. Same slot, same weight, plain text. */}
                  <div className="settings-row-control">
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink)' }}>
                      {COMPETITION_CATEGORY_CHOICES.find((c) => c.value === declaredCategory)?.label}
                    </span>
                  </div>
                </div>
              ) : (
                <div>
                  <Select
                    label="Gender"
                    value={competitionCategory}
                    onChange={(e) => setCompetitionCategory(
                      toCompetitionCategory(e.target.value) ?? '',
                    )}
                    options={COMPETITION_CATEGORY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                  />
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    Decides which gendered draws you can enter at club
                    tournaments. Only you and the tournament desk see it, and
                    Open events are open to everyone whatever you choose. Once
                    you set it, an exec changes it rather than you.
                  </p>
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="btn btn-primary btn-lg"
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
                {loading ? 'Saving…' : saved ? 'Saved' : 'Save profile'}
              </button>
            </form>
          </Section>

          <Section icon={Receipt} title="Membership & dues">
            <Link
              href="/membership"
              className="settings-row settings-row-nav"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="settings-row-label">View what I owe</div>
                <div className="settings-row-hint">Your membership, club and event fees, and how to pay them.</div>
              </div>
              <div className="settings-row-control">
                <ChevronRight size={16} className="text-[var(--mute)]" />
              </div>
            </Link>
          </Section>

          {isApproved && (
            <Section icon={Calendar} title="Calendar">
              <CalendarFeed />
            </Section>
          )}

          <Section icon={Palette} title="Appearance">
            <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>Choose your preferred theme.</p>
            <div className="grid grid-3" style={{ gap: 10 }}>
              {themeOptions.map(({ value, icon: Icon, label }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleThemeChange(value)}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      padding: '16px 12px',
                      borderRadius: 0,
                      border: '1px solid ' + (active ? 'var(--red)' : 'var(--line)'),
                      background: active ? 'var(--red-wash)' : 'var(--surface)',
                      color: active ? 'var(--red)' : 'var(--ink-2)',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all .15s',
                    }}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                    {active && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -6,
                          right: -6,
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          background: 'var(--red)',
                          color: '#fff',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        <Check size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Push and email are the SAME five categories, chosen separately and
              laid out identically. Push used to be one blanket switch —
              "challenges, results, and announcements" — which meant the only way
              to stop one kind of buzz was to stop all of them, while email had
              had per-category control for a while. Two channels, one list. */}
          <div data-tour="settings-notifications">
          <Section icon={Bell} title="Notifications">
            <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 14 }}>
              Everything here starts off. Turn on whatever you want to hear about —
              the in-app inbox keeps a copy either way, so nothing is lost.
            </p>

            <div className="card-head" style={{ marginBottom: 10 }}>
              <h3 className="card-title" style={{ fontSize: 15 }}>Push</h3>
            </div>
            {pushSupported ? (
              <>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  {pushEnabled ? <Bell size={16} className="text-[var(--red)]" style={{ marginTop: 14 }} /> : <BellOff size={16} className="text-[var(--mute)]" style={{ marginTop: 14 }} />}
                  <div style={{ flex: 1 }}>
                    <Switch
                      checked={pushEnabled}
                      onChange={handlePushToggle}
                      label="Allow push on this device"
                      description="Needed before any push can reach this browser."
                      disabled={pushLoading}
                    />
                  </div>
                </div>
                <div className="sep" />
                {/* Same list, same order, same labels as the email block below.
                    Always live, never disabled: the switch above is about THIS
                    browser's subscription, while these five are stored on the
                    account and apply to every device. Greying them out because
                    the laptop you happen to be on is not subscribed would hide
                    an account-wide setting behind a per-device one. */}
                {NOTIFICATION_CATEGORIES.map((c, i) => (
                  <div key={c.key}>
                    {i > 0 && <div className="sep" />}
                    <Switch
                      checked={notifPrefs[c.key]}
                      onChange={(v) => handleNotifPrefToggle(c.key, v)}
                      label={c.label}
                      description={c.description}
                    />
                  </div>
                ))}
                {!pushEnabled && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    These apply to every device you allow push on — this browser is not one of them yet.
                  </p>
                )}

                {/* Also account-wide, so it is not hidden behind this device's
                    subscription either. */}
                <div className="sep" />
                <div style={{ marginTop: 4 }}>
                      <label className="eyebrow block mb-2">Remind me before a session</label>
                      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                        <Input
                          aria-label="Amount"
                          type="text"
                          inputMode="numeric"
                          value={leadValue}
                          onChange={(e) => setLeadValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          onBlur={() => saveReminderLead(leadMinutes)}
                          style={{ maxWidth: 96 }}
                        />
                        <Select
                          aria-label="Unit"
                          value={leadUnit}
                          onChange={(e) => {
                            const u = e.target.value as 'minutes' | 'hours' | 'days';
                            setLeadUnit(u);
                            const m = (Number(leadValue) || 0) * (u === 'days' ? 1440 : u === 'hours' ? 60 : 1);
                            if (m >= REMINDER_LEAD_MIN_MINUTES && m <= REMINDER_LEAD_MAX_MINUTES) saveReminderLead(m);
                          }}
                          options={[
                            { value: 'minutes', label: 'minutes before' },
                            { value: 'hours', label: 'hours before' },
                            { value: 'days', label: 'days before' },
                          ]}
                        />
                      </div>
                      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        {leadInvalid
                          ? 'Pick anything from 5 minutes to 7 days.'
                          : "Only for sessions you said you're going to, and only if they have a start time."}
                      </p>
                </div>
              </>
            ) : (
              <div className="row" style={{ gap: 10, padding: 12, background: 'var(--surface-2)' }}>
                <BellOff size={14} className="text-[var(--mute)]" />
                <span className="muted" style={{ fontSize: 13 }}>Push notifications not supported in this browser.</span>
              </div>
            )}

            {/* Outside the push check on purpose: email works whether or not
                this browser supports push, and burying these behind that check
                would leave someone with no way to stop the mail. */}
            <div className="sep" />
            <div className="card-head" style={{ marginBottom: 10 }}>
              <h3 className="card-title" style={{ fontSize: 15 }}>Email</h3>
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
              Sign-in codes are always sent — you need them to get into your account.
            </p>
            {NOTIFICATION_CATEGORIES.map((c, i) => (
              <div key={`email-${c.key}`}>
                {i > 0 && <div className="sep" />}
                <Switch
                  checked={emailPrefs[c.key]}
                  onChange={(v) => handleEmailPrefToggle(c.key, v)}
                  label={c.label}
                  description={c.description}
                />
              </div>
            ))}
          </Section>
          </div>

          <Section icon={Shield} title="Privacy">
            <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>Saved when you tap <strong>Save profile</strong>.</p>
            {/* "SHOW ACTIVITY STATUS" WAS HERE, AND IT GOVERNED NOTHING.
                Audit §2.5. It read and wrote players.show_activity_status, and
                a tree-wide grep found no other reader — not one screen, not one
                query. `last_active_at` is not granted to `authenticated`
                (00032), so no member can see another's last-active time
                whatever the switch says, and there is no members' surface that
                shows it for the switch to govern.

                It was worse than inert. A member who turned it off had been
                told they were now private about their activity, while the thing
                it SOUNDS like it governs — when was this person last around —
                was fully readable through session_attendance and session_rsvp
                (both USING (true) until 00153). A control that manufactures
                confidence it cannot deliver is worse than no control.

                Removed rather than wired up, because wiring it up means first
                building a surface that discloses activity, which nobody asked
                for. The COLUMN is left alone: it costs nothing, whatever
                members already set is still there, and if an activity surface
                is ever built this is the switch it should honour — put the
                control back then, next to the thing it governs. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Switch
                checked={showOnLeaderboard}
                onChange={setShowOnLeaderboard}
                label="Show on leaderboard"
                description="Your rank will be visible to others."
              />
            </div>
            {/* OUTSIDE THE isApproved GUARD, DELIBERATELY, unlike the Calendar
                section above it. isApproved is getAccountStanding(), the same
                three checks requirePlayer() makes, so gating this row on it
                would hide the export from exactly the members most likely to
                want it: someone pending approval, someone suspended, someone
                banned wanting to read the reason the club wrote about them,
                someone who has asked to be deleted and would like a copy
                first. Standing withholds the CONTROLS, not the information,
                which is the same distinction the calendar feed route's header
                draws, and the route agrees with this on purpose: it
                authenticates and does not call requirePlayer().

                In the Privacy section and not the Danger zone, because an
                export is not destructive. */}
            <div className="sep" />
            <DataExport />
          </Section>

          {/* Not behind isApproved: withdrawing consent must always be possible,
              whatever the account's standing. */}
          <Section icon={Camera} title="Photos and video">
            <Switch
              checked={mediaConsent}
              onChange={handleMediaConsentToggle}
              label="Photos and video of me"
              description="Let the club use photos or video of you from club activities on its website and social media. This is off unless you turn it on, and it never affects your membership."
            />
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {mediaConsentLoadFailed
                ? 'Your photo and video choice could not be loaded. Reload to check it.'
                : mediaConsent && mediaConsentChangedAt
                  ? `Allowed since ${clubDate(mediaConsentChangedAt)}.`
                  : mediaConsentChangedAt
                    ? `Turned off ${clubDate(mediaConsentChangedAt)}.`
                    : 'Not turned on.'}
            </p>
          </Section>

          <Section icon={KeyRound} title="Passkeys">
            <PasskeyManager />
          </Section>

          <Section icon={Lock} title="Password">
            <PasswordManager />
          </Section>

          <Section icon={MessageSquareWarning} title="Help & Feedback">
            {/* A replay. The member tour host sees ?tour=member on the feed and
                opens the tour whether or not it has been seen, and a replay
                never records anything. */}
            <Link
              href="/feed?tour=member"
              className="settings-row settings-row-nav"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="settings-row-label">Take the app tour</div>
                <div className="settings-row-hint">A one-minute look at where everything is.</div>
              </div>
              <div className="settings-row-control">
                <ChevronRight size={16} className="text-[var(--mute)]" />
              </div>
            </Link>
            <Link
              href="/feedback"
              className="settings-row settings-row-nav"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="settings-row-label">Report a bug or send feedback</div>
                <div className="settings-row-hint">Tell us what broke or what you&apos;d like to see. You can attach a screenshot.</div>
              </div>
              <div className="settings-row-control">
                <ChevronRight size={16} className="text-[var(--mute)]" />
              </div>
            </Link>
          </Section>

          <Section icon={Info} title="About">
            <div className="settings-row">
              <div className="settings-row-label">Version</div>
              <div className="settings-row-control">
                <span className="mono tag">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
              </div>
            </div>
            <Link
              href="/whats-new"
              className="settings-row settings-row-nav"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div>
                <div className="settings-row-label">What&apos;s new</div>
                <div className="settings-row-hint">What changed in each version of the app.</div>
              </div>
              <div className="settings-row-control">
                <ChevronRight size={16} className="text-[var(--mute)]" />
              </div>
            </Link>
          </Section>

          <Section icon={LogOut} title="Account">
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Sign out</div>
                <div className="settings-row-hint">End your session on this device.</div>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="btn btn-ghost"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </div>
            <SignOutOtherDevices />
          </Section>

          <div className="danger-zone">
            <h3 className="danger-title">Danger zone</h3>
            {canOpenConsole && (
              <div className="settings-row">
                <div>
                  <div className="settings-row-label">EXEC PANEL</div>
                  <div className="settings-row-hint">Open the club administration panel.</div>
                </div>
                <div className="settings-row-control">
                  {/* See top-bar.tsx: same-origin, plain <a>, and no
                      target="_blank" — a new tab would eject the exec from the
                      installed PWA. */}
                  <a
                    href="/admin"
                    className="btn btn-danger-ghost"
                  >
                    <Shield size={14} />
                    OPEN EXEC PANEL
                  </a>
                </div>
              </div>
            )}
            <div className="settings-row">
              <div>
                <div className="settings-row-label">Delete account</div>
                <div className="settings-row-hint">
                  Permanently deletes your login and removes your personal information
                  after a 30-day grace period. Your match and rating history stays under
                  an anonymous name.
                </div>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  onClick={() => setShowDeleteDialog(true)}
                  className="btn btn-danger-ghost"
                >
                  <Trash2 size={14} />
                  Delete account
                </button>
              </div>
            </div>
          </div>

          <Dialog
            open={showDeleteDialog}
            onClose={() => { setShowDeleteDialog(false); setDeleteConfirm(''); }}
            title="Delete account"
          >
            <div className="space-y-4">
              <p className="text-sm text-[var(--text-secondary)]">
                Your account is deactivated and hidden immediately. Sign back in any time
                within 30 days to restore it. After 30 days your login is permanently
                removed and your personal information is deleted — your match and rating
                history remains under an anonymous name.
              </p>
              <Input
                label="Type DELETE to confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
              />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setShowDeleteDialog(false); setDeleteConfirm(''); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={deleteConfirm !== 'DELETE' || deleteLoading}
                  onClick={handleDeleteAccount}
                >
                  {deleteLoading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  Delete account
                </button>
              </div>
            </div>
          </Dialog>
        </div>
      )}
    </div>
  );
}
