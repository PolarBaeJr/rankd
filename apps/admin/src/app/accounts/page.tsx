export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import {
  accessLevelFor,
  isInGoodStanding,
  permissionsOf,
  permits,
  pageOf,
  isCapability,
  BUILTIN_PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  type Capability,
} from '@/lib/permissions';
import { accessForLevel, EXEC_ROLE_OPTIONS } from '@/lib/console-access';
import {
  ACCESS_CHANGE_ACTION_TYPES,
  capabilityDelta,
  isAccessChange,
  officerAccessSummary,
  type OfficerInput,
} from '@/lib/officer-access';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import { formatRelativeTime } from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { AvatarChip, Badge, Card, EmptyState, PageHeader, ResponsiveTable, TableCard } from '@badminton/ui';
import Link from 'next/link';
import { PlatformSettingsForm } from '@/components/platform-settings-form';
import { settingsForSection } from '@/lib/platform-setting-sections';
import { withSeededSettings } from '@/lib/platform-setting-fields';
import { FEATURES, FEATURES_SETTING_KEY, parseFeatureFlags } from '@badminton/shared/src/utils/features';
import { DataApiKeysCard } from './DataApiKeysCard';
import { AccountsRail, type AccountsRailSection } from './accounts-rail';

// TWO QUESTIONS, ONE PAGE, AND THEY ARE BOTH CALLED "ACCOUNTS".
//
// The screen the club asked for is about the OFFICERS' accounts — who holds the
// console and who can undo things with it. The page that was already here is
// about MEMBERS' accounts — challenge limits, session caps, what a membership
// may do. Both are on it now, and the settings half is not optional: this route
// is the catch-all in platform-setting-sections.ts (DEFAULT_SECTION =
// 'accounts'), so a platform_settings key added next year with no line in that
// map lands HERE. Replacing the page with an officers screen would have made
// six settings groups, and every future one, unreachable from the console with
// no error anywhere — the silent-nothing-happened failure that file was written
// to prevent.
//
// THREE CAPABILITIES, THREE ANSWERS, and the second and third are checked here
// rather than inherited from the first:
//
//   accounts.page      opens the route. requireCapability, as before.
//   permissions.page   the OFFICER data — names, emails, last sign-ins,
//                      capability counts and the access audit trail. There is
//                      no `accounts.<resource>.read`, and inventing one would
//                      mean editing the vocabulary; this is the capability that
//                      already governs exactly this data, on /permissions.
//   platform.page      the settings form, exactly as /ratings does it.
//
// The gated halves skip their FETCHES rather than hiding rendered output. A
// hidden card whose query still ran ships officer emails into the RSC payload
// for anyone with devtools — the same reasoning as /fees and dashboard/page.tsx.
//
// NONE OF THE THREE IS IN EDITOR_OFFERABLE — the ceiling on what anybody below
// admin may be composed up to — so today only an admin holds any of them and
// both withheld branches are unreachable. (That constant used to be an alias of
// EXEC_BASELINE, which is why this note named the baseline; the baseline has
// since narrowed and the ceiling is its own list.) They are written anyway, for
// the reason /ratings gives for platform.page: the route map decides who may
// OPEN a section, and a page that re-checks what it draws does not have to be
// re-audited when that changes.
//
// `accounts.page` BRIEFLY LEFT THAT LIST AND CAME BACK, which is worth a line
// because the data API's key panel below is the reason it moved. The panel was
// going to be exec work, the page had to be offerable for the key capabilities
// to survive the resolver's pruning, and then minting was made admin-only: a
// key reads the club's data from outside every gate in access-level.ts and
// keeps answering after the minter's console is gone. With nothing on this
// route offerable, the page went back to being withheld too.
export default async function AccountsPage() {
  const viewer = await requireCapability('accounts.page');
  const viewerLevel = accessLevelFor(viewer);
  const viewerPermissions = permissionsOf(accessLevelFor(viewer), viewer);
  const showOfficers = permits(viewerLevel, viewerPermissions, 'permissions.page');
  const showPlatformSettings = permits(viewerLevel, viewerPermissions, 'platform.page');
  // THE FOURTH ANSWER, and it is a FETCH gate rather than a render one. See
  // capability-gates.ts on `accounts.apikey.read`: what it withholds is the
  // rows, so the query below is skipped exactly the way the officer and
  // settings halves skip theirs. The two write capabilities decide only which
  // CONTROLS the card draws; the real gate on both acts is the
  // requireCapability inside actions/data-api-keys.ts, and render-gating a
  // button has never stopped a POST.
  const showDataApiKeys = permits(viewerLevel, viewerPermissions, 'accounts.apikey.read');
  const canMintDataApiKey = permits(viewerLevel, viewerPermissions, 'accounts.apikey.mint.write');
  const canRevokeDataApiKey = permits(viewerLevel, viewerPermissions, 'accounts.apikey.revoke.write');

  const adminClient = createAdminClient();

  // WHO HOLDS A CONSOLE LEVEL. The same filter and the same three permission
  // columns /permissions uses — naming permission_role without both delta
  // columns makes permissionsOf() throw, deliberately, because a narrowed
  // SELECT would quietly turn a stored revoke into nothing.
  //
  // email and exec_title are readable here only because this is the
  // service-role client, which bypasses the column grants 00032 put on
  // `players`. Under the anon grant neither is selectable at all. That is the
  // reason this fetch sits behind permissions.page rather than behind the page
  // key: it is personal data, and the route gate is not the thing protecting it.
  const { data: people } = showOfficers
    ? await adminClient
        .from('players')
        .select(
          'id, user_id, full_name, email, avatar_url, exec_title, role, is_exec, is_trainer, is_banned, status, active_flag, permission_role, permission_grants, permission_revokes',
        )
        .or('role.eq.admin,is_exec.eq.true,is_trainer.eq.true')
        .order('full_name')
    : { data: null };

  // Built through accessLevelFor rather than off the flags, so this page cannot
  // develop its own idea of what makes somebody an officer, and a row that
  // resolves to no level is dropped rather than listed among people who have one.
  const officers = (people ?? [])
    .map((person) => ({ person, level: accessLevelFor(person) }))
    .filter((entry) => entry.level !== null);

  // LAST SIGN-IN, FROM THE ONLY PLACE THAT RECORDS IT.
  //
  // NOT players.last_active_at. That column is `NOT NULL DEFAULT NOW()` and is
  // bumped by a session check-in and by reactivation — nothing else — so on a
  // committee member who has never been to a session it still reads as the day
  // their row was created, and it can never say "never". Rendering it under a
  // heading that says "last sign-in" would be a number that looks like an
  // answer and is not one.
  //
  // GoTrue's own `last_sign_in_at` is the real thing, reachable through the
  // admin auth API — the same call both passkey verify routes already make. One
  // request per officer, in parallel: this list is the club's committee, five
  // or six rows, and there is no bulk lookup by id. A null is a real state here
  // and renders as "Never", which is exactly what last_active_at could not
  // express.
  //
  // THREE OUTCOMES, NOT TWO. A failed lookup must not read as `null`: "Never
  // signed in" is a claim about the officer, and a GoTrue error is a claim
  // about the request. Collapsing them would put the strongest possible
  // statement — this person has never once signed in — on the screen precisely
  // when the app has no idea.
  const signIns = new Map<string, string | null | 'unknown'>();
  await Promise.all(
    officers.map(async ({ person }) => {
      const userId = person.user_id as string | null;
      if (!userId) return;
      const { data, error } = await adminClient.auth.admin.getUserById(userId);
      signIns.set(
        person.id as string,
        error || !data?.user ? 'unknown' : (data.user.last_sign_in_at ?? null),
      );
    }),
  );

  // THE LAST ACCESS CHANGE. Two action types are fetched and narrowed in
  // TypeScript by isAccessChange() — `player_updated` is what setConsoleAccess
  // writes (it composes updatePlayer) and it is also what renaming a member
  // writes, so it cannot be taken wholesale. See officer-access.ts for why the
  // narrowing is not a PostgREST filter on new_value.
  const { data: recentLogs, error: logsError } = showOfficers
    ? await adminClient
        .from('audit_logs')
        .select(
          'id, action_type, actor_id, target_id, reason, old_value, new_value, created_at, actor:players!audit_logs_actor_id_fkey(full_name, avatar_url)',
        )
        .in('action_type', [...ACCESS_CHANGE_ACTION_TYPES])
        .order('created_at', { ascending: false })
        .limit(100)
    : { data: null, error: null };

  // A REFUSED EMBED IS NOT AN EMPTY LOG. If PostgREST cannot resolve the actor
  // relationship — a stale schema cache is the usual way — `data` comes back
  // null with the error unread, and this card would state, in plain English,
  // that the club has never changed anybody's access. That is the loudest
  // possible false claim on a page about who can undo things, so the failure
  // gets reported even though the render below degrades quietly.
  if (logsError) {
    Sentry.captureException(new Error(`Accounts access-log read failed: ${logsError.message}`));
  }

  const lastChange = (recentLogs ?? []).find(isAccessChange) ?? null;

  // The subject's name, resolved the way /audit resolves it: target_id is a
  // bare uuid against a table named only by target_type, and `player` is the
  // only type either of these actions writes.
  const { data: subject } = lastChange?.target_id
    ? await adminClient
        .from('players')
        .select('full_name')
        .eq('id', lastChange.target_id)
        .maybeSingle()
    : { data: null };

  const summary = officerAccessSummary(officers.map(({ person }) => person as OfficerInput));

  const { data: settings } = showPlatformSettings
    ? await adminClient.from('platform_settings').select('*').order('key')
    : { data: null };

  // THE ISSUED KEYS.
  //
  // `key_hash` IS NOT IN THIS SELECT and must never be. Not rendering it is not
  // the same as not fetching it: an unrendered column still travels in the RSC
  // payload, which is the argument this page already makes at :55-57 about
  // gated fetches versus gated renders. The hash is not usable as a credential,
  // but it is a probe against a candidate list and there is no reason for it to
  // leave the database.
  //
  // BOTH EMBEDS NAME THEIR FOREIGN KEY. `data_api_keys` has two columns
  // referencing `players` (minted_by and revoked_by), so an unqualified
  // `players(...)` embed is ambiguous and PostgREST refuses the whole select.
  const { data: apiKeyRows, error: apiKeysError } = showDataApiKeys
    ? await adminClient
        .from('data_api_keys')
        .select(
          'id, key_prefix, label, scopes, created_at, expires_at, revoked_at, consumer:data_api_consumers!data_api_keys_consumer_id_fkey(name), minter:players!data_api_keys_minted_by_fkey(full_name)',
        )
        .order('created_at', { ascending: false })
    : { data: null, error: null };

  // AN ERROR HERE IS A KNOWN STATE, NOT A FAULT, which is why it is not
  // reported the way the access-log read above is. 00241 creates these tables
  // and ships UNAPPLIED: applying it is the owner's, so until they run it
  // PostgREST answers this select with "table not found" and supabase-js
  // returns { data: null }. The same shape as the `roleRows` fallback below.
  // Either way the honest sentence is that the key store is not reachable, and
  // the card says so rather than claiming the club has issued nothing.
  const apiKeys = (apiKeyRows ?? []).map((row) => ({
    id: row.id as string,
    consumer: embedded<{ name: string }>(row.consumer)?.name ?? 'Unknown consumer',
    key_prefix: row.key_prefix as string,
    label: (row.label as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
    created_at: row.created_at as string,
    expires_at: (row.expires_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
    minted_by_name: embedded<{ full_name: string }>(row.minter)?.full_name ?? null,
  }));

  // WHAT THE ROLES ACTUALLY SAY, READ FROM THE TABLE RATHER THAN FROM THE CODE.
  //
  // This card is club-facing documentation of the four jobs, and until 00104 it
  // could read ROLE_DEFAULTS because that constant WAS the answer. It is the
  // SEED now — the owner edits the rows — so rendering it here would describe
  // Finance as the expense ledger on a club whose Finance sees the whole books.
  // Documentation derived from the wrong source is worse than none: it is
  // believed.
  //
  // The four built-ins only. The club's own baselines are listed on /permissions
  // beside the people holding them, which is where a question about them starts;
  // this card answers "what do the named jobs mean", and it has always answered
  // it about four things.
  const { data: roleRows } = await adminClient
    .from('permission_baselines')
    .select('name, capabilities, builtin_role')
    .not('builtin_role', 'is', null)
    .order('name');

  // FALLS BACK TO THE SHIPPED DEFAULTS WHEN THE QUERY ANSWERS NOTHING, and the
  // case that actually reaches it is 00104 UNAPPLIED — where `builtin_role` does
  // not exist, PostgREST answers the whole select with an error, and supabase-js
  // returns { data: null } rather than throwing. So `roleRows` is null and this
  // fires. (A migration applied but somehow unseeded lands here too.)
  //
  // The constant is still literally correct in exactly that state, because
  // nothing can have edited a row that does not exist — which is what makes a
  // fallback honest here rather than a guess. An empty card would read as "these
  // roles do nothing", which is the one thing they never mean.
  const namedRoles: { key: string; label: string; capabilities: readonly Capability[] }[] =
    (roleRows ?? []).length > 0
      ? (roleRows ?? []).map((row) => ({
          key: row.builtin_role as string,
          label: row.name as string,
          capabilities: ((row.capabilities as string[] | null) ?? []).filter(isCapability),
        }))
      : BUILTIN_PERMISSION_ROLES.map((role) => ({
          key: role,
          label: PERMISSION_ROLE_LABELS[role],
          capabilities: ROLE_DEFAULTS[role],
        }));

  // The saved switches, for the rail's count. An absent row reads as every
  // feature on, exactly as the member app reads it.
  const featureFlags = parseFeatureFlags(settings?.find((row) => row.key === FEATURES_SETTING_KEY)?.value ?? null);
  const featuresOn = FEATURES.filter((f) => featureFlags[f.id]).length;

  // The rail lists what is actually on the page, so a withheld section never
  // leaves a link to nothing.
  const sections: AccountsRailSection[] = [
    ...(showPlatformSettings
      ? [
          {
            id: 'member-pages',
            label: 'Member pages',
            sub: 'Switch pages on or off',
            badge: `${featuresOn} / ${FEATURES.length} on`,
            tone: featuresOn === FEATURES.length ? ('success' as const) : ('warning' as const),
          },
        ]
      : []),
    ...(showOfficers
      ? [
          { id: 'officers', label: 'Officers', sub: 'Who holds the console', badge: String(officers.length) },
          { id: 'roles', label: 'What roles can do', sub: 'Read-only summary' },
        ]
      : []),
    ...(showPlatformSettings
      ? [
          { id: 'account-rules', label: 'Account rules', sub: 'What a membership may do' },
          { id: 'club-links', label: 'Club links', sub: 'Instagram, Discord, membership' },
        ]
      : []),
    ...(showDataApiKeys
      ? [{ id: 'data-api-keys', label: 'Data API keys', sub: 'Who reads the data from outside' }]
      : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow={showOfficers ? `ACCESS · ${plural(officers.length, 'OFFICER')}` : 'ACCESS'}
        title="Accounts"
        // The mockup's line — "Who can see what, and who can undo it" —
        // describes only the officers half. This page is both halves, and a sub
        // that names one of them is half false.
        sub="Who holds the console and what they can undo, and what a member's account may do"
        watermark="A"
        actions={
          showOfficers ? (
            // NOT a form. Giving somebody the console writes `role`, `is_exec`
            // and `is_trainer` — the hard floor in player-field-access.ts that
            // no capability reaches and only an admin may cross — and
            // setConsoleAccess already owns that act, refuses self-demotion and
            // clears any composition left behind. A second way in would be a
            // second place all of that has to be remembered.
            <Link
              href="/permissions"
              className="inline-flex min-h-[40px] items-center justify-center whitespace-nowrap border border-transparent bg-[var(--red)] px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-white transition-colors hover:bg-[var(--red-ink)]"
            >
              Add officer
            </Link>
          ) : undefined
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_300px]">
        {/* LEFT: section rail, client-side so the highlight follows the page. */}
        <AccountsRail sections={sections} />

        {/* MIDDLE */}
        <div className="flex min-w-0 flex-col gap-5">
          {showPlatformSettings && (
            <section id="member-pages" className="scroll-mt-32" data-tour="member-pages">
              <Card className="overflow-hidden p-0">
                <SectionCardHeader
                  title="Member pages"
                  sub="Switch a page off and members see a short notice instead. Admins, and anyone given its access key, can still open it."
                  aside="Saved with a reason, logged"
                />
                <div className="px-6 pt-5">
                  <PlatformSettingsForm
                    settings={settingsForSection(withSeededSettings(settings ?? []), 'pages')}
                    layout="tiles"
                  />
                </div>
              </Card>
            </section>
          )}

          {showOfficers ? (
            <>
              {/* The anchor lives on a wrapper because Card takes no id, and
                  packages/ui is not this change's to edit. */}
              <section id="officers" className="scroll-mt-32">
              <Card className="overflow-hidden p-0">
                <SectionCardHeader title="Officers" sub="Everyone who can open this console." />
                {officers.length === 0 ? (
                  <div className="px-6 py-5">
                    <EmptyState
                      title="Nobody holds the console"
                      description="Give somebody console access from Permissions."
                    />
                  </div>
                ) : (
                  <ResponsiveTable
                    cards={officers.map(({ person, level }) => (
                      <TableCard
                        key={person.id as string}
                        title={
                          <span className="flex items-center gap-2">
                            <AvatarChip
                              name={displayName(person)}
                              id={person.id as string}
                              src={person.avatar_url as string | null}
                              size="sm"
                              ring={person.id === viewer.id}
                            />
                            {displayName(person)}
                          </span>
                        }
                        badges={<RoleBadges person={person} level={level} />}
                        fields={[
                          { label: 'Identity', value: identityLine(person, viewer.id as string) },
                          { label: 'Last sign-in', value: signInLabel(signIns.get(person.id as string)) },
                        ]}
                        actions={
                          <Link
                            href="/permissions"
                            className="inline-flex min-h-[44px] items-center justify-center border border-[var(--line)] px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                          >
                            Edit
                          </Link>
                        }
                      />
                    ))}
                  >
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-[var(--line)]">
                          <Th>Officer</Th>
                          <Th>Role</Th>
                          <Th>Last sign-in</Th>
                          <Th className="text-right">Action</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {officers.map(({ person, level }) => (
                          <tr key={person.id as string} className="border-b border-[var(--line)] last:border-0">
                            <td className="px-6 py-3.5">
                              <div className="flex items-center gap-2.5">
                                <AvatarChip
                                  name={displayName(person)}
                                  id={person.id as string}
                                  src={person.avatar_url as string | null}
                                  size="sm"
                                  ring={person.id === viewer.id}
                                />
                                <div className="min-w-0">
                                  <div className="truncate text-sm text-[var(--ink)]">
                                    {displayName(person)}
                                  </div>
                                  <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
                                    {identityLine(person, viewer.id as string)}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-3.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <RoleBadges person={person} level={level} />
                              </div>
                            </td>
                            <td className="px-6 py-3.5 font-mono text-xs text-[var(--ink-2)]">
                              {signInLabel(signIns.get(person.id as string))}
                            </td>
                            <td className="px-6 py-3.5 text-right">
                              <Link
                                href="/permissions"
                                className="inline-flex min-h-[44px] items-center justify-center border border-[var(--line)] px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                              >
                                Edit
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ResponsiveTable>
                )}
              </Card>
              </section>

              {/* WHAT ROLES CAN DO — READ-ONLY, AND EVERY WORD OF IT DERIVED.
                  The mockup drew five selects mapping jobs like "Suspend or ban"
                  onto "President only" / "President + treasurer". That is a
                  second, incompatible authorisation model: those names are not
                  roles this app has (exec_title is free text, guarded by 00072),
                  and a control that wrote them would be a second source of truth
                  for who may do what, sitting next to a resolver that would go
                  on ignoring it. So the card reports instead of deciding, the
                  text comes out of ROLE_DEFAULTS and CAPABILITY_GATES rather
                  than out of a sentence somebody typed, and the one control on
                  it is a link to the screen that really does this. */}
              <section id="roles" className="scroll-mt-32">
              <Card className="overflow-hidden p-0">
                <SectionCardHeader
                  title="What roles can do"
                  sub={
                    <>
                      A summary of the four named roles.{' '}
                      <Link href="/permissions" className="text-[var(--ink)] underline underline-offset-2">
                        Permissions
                      </Link>{' '}
                      is where they are assigned and adjusted, per person.
                    </>
                  }
                />
                <dl className="flex flex-col px-6 py-5">
                  {namedRoles.map(({ key, label, capabilities }) => {
                    return (
                      <div
                        key={key}
                        className="flex flex-col gap-1 border-t border-[var(--line)] py-3.5 first:border-t-0 first:pt-0 sm:flex-row sm:items-baseline sm:gap-4"
                      >
                        <dt className="w-[140px] shrink-0 text-[15px] text-[var(--ink)]">
                          {label}
                        </dt>
                        <dd className="min-w-0 text-[13px] text-[var(--mute)]">
                          {capabilities.length === 0 ? (
                            // A role edited down to nothing. It used to be how
                            // `custom` rendered — the empty base, which is no
                            // longer listed here because it is not one of the
                            // four named jobs.
                            'Nothing: every capability would be picked by hand, per person.'
                          ) : (
                            <>
                              {sectionsOpenedBy(capabilities).join(' · ')}
                              <span className="ml-2 font-mono text-[11px] text-[var(--ink-2)]">
                                {plural(capabilities.length, 'CAPABILITY', 'CAPABILITIES')}
                              </span>
                            </>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </Card>
              </section>
            </>
          ) : (
            // WITHHELD, NOT EMPTY. A blank panel reads as broken; this says who
            // is not being shown what, and why.
            <Card>
              <CardHeading title="Officers" />
              <p className="mt-3 text-[13px] text-[var(--mute)]">
                The list of officers is not shown to you. It needs the Permissions section.
              </p>
            </Card>
          )}

          {showPlatformSettings && (
            <section id="account-rules" className="scroll-mt-32">
              <Card className="overflow-hidden p-0">
                <SectionCardHeader
                  title="Account rules"
                  sub="What a member's account may do: challenges, match caps, no-shows, inactivity, check-in."
                />
                <div className="px-6 py-5">
                  <PlatformSettingsForm
                    settings={settingsForSection(withSeededSettings(settings ?? []), 'accounts')}
                    layout="grouped"
                  />
                </div>
              </Card>
            </section>
          )}

          {showPlatformSettings && (
            <section id="club-links" className="scroll-mt-32">
              <Card className="overflow-hidden p-0">
                <SectionCardHeader
                  title="Club links"
                  sub="The links the club publishes: Instagram, Discord, and where to buy a membership."
                />
                <div className="px-6 py-5">
                  <PlatformSettingsForm
                    settings={settingsForSection(withSeededSettings(settings ?? []), 'club')}
                    layout="links"
                  />
                </div>
              </Card>
            </section>
          )}

          {showDataApiKeys ? (
            // The anchor lives on a wrapper for the same reason the officers
            // one does: Card takes no id and packages/ui is not this change's
            // to edit.
            <section id="data-api-keys" className="scroll-mt-32">
              {apiKeysError ? (
                <Card>
                  <CardHeading title="Data API keys" />
                  <p className="mt-3 text-[13px] text-[var(--mute)]">
                    The key store cannot be read. Migration 00241 creates it and has to be
                    applied to this database before the panel works; until then this is
                    expected rather than a fault.
                  </p>
                </Card>
              ) : (
                <DataApiKeysCard
                  keys={apiKeys}
                  canMint={canMintDataApiKey}
                  canRevoke={canRevokeDataApiKey}
                  canEditScopes={canMintDataApiKey}
                />
              )}
            </section>
          ) : (
            // WITHHELD, NOT EMPTY, exactly as the officers half above. A page
            // with no key card at all reads as a club that has never thought
            // about the question.
            <Card>
              <CardHeading title="Data API keys" />
              <p className="mt-3 text-[13px] text-[var(--mute)]">
                Who holds a data API key is not shown to you. It needs the Data API keys
                capability.
              </p>
            </Card>
          )}
        </div>

        {/* RIGHT */}
        {showOfficers && (
          <div className="flex flex-col gap-5 lg:col-start-2 xl:col-start-auto xl:sticky xl:top-[calc(var(--console-header-h)+var(--sticky-gap))] xl:self-start">
            {/* ACCESS RIGHT NOW. Every figure is the size of the set of people
                whose effectiveCapabilities() contains ONE named capability —
                never a count of `is_exec`, which stopped answering this question
                the day permissions became composable, and never a hand-assembled
                bundle like "can touch money", which drifts the moment a
                capability is added. See officer-access.ts. */}
            <Card>
              <CardHeading title="Access right now" />
              <div className="mt-4 flex items-baseline gap-3">
                <span className="font-mono text-4xl leading-none text-[var(--ink)]">
                  {summary.active}
                </span>
                <span className="font-mono text-[10px] uppercase leading-tight tracking-[0.14em] text-[var(--mute)]">
                  {plural(summary.active, 'OFFICER')}
                  <br />
                  {summary.headline} CAN BAN
                </span>
              </div>
              <dl className="mt-4">
                {summary.rows.map((row) => (
                  <div
                    key={row.capability}
                    className="flex items-baseline justify-between gap-3 border-t border-[var(--line)] py-2.5"
                  >
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
                      {row.label}
                    </dt>
                    <dd className="font-mono text-sm text-[var(--ink)]">{row.count}</dd>
                  </div>
                ))}
              </dl>
              {summary.withheld > 0 && (
                // The table lists everybody who HOLDS a level; these counts are
                // everybody who could act tonight. Where the two differ, say so
                // — otherwise the card and the table beside it disagree with no
                // explanation.
                <p className="mt-3 border-t border-[var(--line)] pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-warning)]">
                  {plural(summary.withheld, 'OFFICER')} NOT COUNTED · CANNOT SIGN IN
                </p>
              )}
            </Card>

            <Card>
              <CardHeading title="Last changed" />
              {lastChange ? (
                <div className="mt-4">
                  <div className="flex items-center gap-2.5">
                    <AvatarChip
                      name={actorName(lastChange)}
                      id={(lastChange.actor_id as string | null) ?? actorName(lastChange)}
                      src={actorAvatar(lastChange)}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[var(--ink)]">{actorName(lastChange)}</div>
                      <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
                        {shortDate(lastChange.created_at as string)} ·{' '}
                        {changeSummary(lastChange, (subject?.full_name as string | null) ?? null)}
                      </div>
                    </div>
                  </div>
                  {/* Rendered only when there is one to render. Every access
                      change written from here on carries a typed reason —
                      player_permissions_changed included, which was the last
                      one that did not — but rows written BEFORE that have
                      `reason` NULL for good, and an unconditional blockquote
                      would show them as an empty pair of quotation marks. */}
                  {typeof lastChange.reason === 'string' && lastChange.reason.trim() !== '' && (
                    <blockquote className="mt-3 border-l-2 border-[var(--line)] pl-3 text-[13px] text-[var(--ink-2)]">
                      {lastChange.reason}
                    </blockquote>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-[var(--mute)]">
                  No access change has been recorded yet.
                </p>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentation helpers. Nothing here decides anything — every authorisation
// answer on this page comes from officer-access.ts or from permits().
// ---------------------------------------------------------------------------

/**
 * One embedded row from a PostgREST many-to-one join.
 *
 * PostgREST returns a many-to-one embed as an OBJECT, but supabase-js types it
 * as an ARRAY whenever the client carries no generated Database type, which
 * this one deliberately does not (see supabase-server.ts). Unwrapping rather
 * than casting blind means the row survives whichever shape arrives, instead of
 * reading `.name` off an array and rendering "undefined".
 */
function embedded<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return (value as T | null) ?? null;
}

/**
 * The header strip of a full-bleed card in the middle column: display title,
 * a line under it, and an optional note on the right, above a hairline.
 */
function SectionCardHeader({
  title,
  sub,
  aside,
}: {
  title: string;
  sub?: React.ReactNode;
  aside?: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--line)] px-6 py-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2
          className="text-[22px] font-bold uppercase leading-tight tracking-[0.04em] text-[var(--ink)]"
          style={{ fontFamily: 'var(--display)' }}
        >
          {title}
        </h2>
        {sub && <p className="text-[14px] text-[var(--mute)]">{sub}</p>}
      </div>
      {aside && <span className="font-mono text-[12px] text-[var(--mute)]">{aside}</span>}
    </div>
  );
}

function CardHeading({
  title,
  sub,
  className,
}: {
  title: string;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <h2
        className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
        style={{ fontFamily: 'var(--display)' }}
      >
        {title}
      </h2>
      {sub && <p className="mt-1 text-[13px] text-[var(--mute)]">{sub}</p>}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-6 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--mute)] ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

type PersonRowish = Record<string, unknown>;

function displayName(person: PersonRowish): string {
  return (
    (person.full_name as string | null)
    ?? (person.email as string | null)
    ?? 'Unnamed'
  );
}

/**
 * The mono second line under a name: YOU for yourself, otherwise their email.
 *
 * Falls back to the exec title when there is no email rather than to a blank —
 * a row with nothing under the name reads as a rendering fault.
 */
function identityLine(person: PersonRowish, viewerId: string): string {
  if (person.id === viewerId) return 'YOU';
  return (
    (person.email as string | null)
    ?? (person.exec_title as string | null)
    ?? 'NO EMAIL ON FILE'
  );
}

function RoleBadges({
  person,
  level,
}: {
  person: PersonRowish;
  level: ReturnType<typeof accessLevelFor>;
}) {
  // The level's own wording, taken through console-access.ts rather than a
  // fifth hand-written mapping between the four console-access answers and the
  // three levels.
  const label = EXEC_ROLE_OPTIONS.find((option) => option.value === accessForLevel(level))?.label;
  const composed = (person.permission_role as string | null) ?? null;
  const composedLabel =
    composed && composed in PERMISSION_ROLE_LABELS
      ? PERMISSION_ROLE_LABELS[composed as keyof typeof PERMISSION_ROLE_LABELS]
      : null;
  return (
    <>
      {/* neutral, not the red `default` — one accent per screen, and it is
          already spent on Add officer. `info` exists on Badge but the console
          guidelines allow success/warning/danger/neutral only. */}
      <Badge variant="neutral">{label}</Badge>
      {composedLabel && <Badge variant="neutral">{composedLabel}</Badge>}
      {/* accessLevelFor ignores standing, so this row holds the level and still
          cannot get through the front door. Saying so is the difference between
          a list of people who have access and a list of people who look like
          they do. */}
      {!isInGoodStanding(person as OfficerInput) && <Badge variant="danger">Cannot sign in</Badge>}
    </>
  );
}

/** GoTrue's timestamp, or one of the three things its absence can mean. */
function signInLabel(value: string | null | undefined | 'unknown'): string {
  // No auth user to ask about: a player row created by an officer that nobody
  // has ever signed into.
  if (value === undefined) return 'No account';
  if (value === 'unknown') return 'Unknown';
  // The state last_active_at could never express, because it is NOT NULL
  // DEFAULT NOW().
  if (value === null) return 'Never';
  return formatRelativeTime(value);
}

function shortDate(value: string): string {
  return new Date(value)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    .toUpperCase();
}

type AuditRowish = Record<string, unknown>;

function actorRecord(log: AuditRowish): Record<string, unknown> | null {
  // PostgREST returns an embedded to-one as an object, but a stale schema cache
  // can hand back a single-element array for the same relationship.
  const actor = log.actor;
  if (Array.isArray(actor)) return (actor[0] as Record<string, unknown>) ?? null;
  if (actor && typeof actor === 'object') return actor as Record<string, unknown>;
  return null;
}

function actorName(log: AuditRowish): string {
  // Null when the actor row was deleted — audit_logs.actor_id is ON DELETE SET
  // NULL, so the trail outlives the person.
  return (actorRecord(log)?.full_name as string | null) ?? 'A removed account';
}

function actorAvatar(log: AuditRowish): string | null {
  return (actorRecord(log)?.avatar_url as string | null) ?? null;
}

/**
 * What the change did, in the mono line beside the date.
 *
 * The stored triple does not answer that — a role is a name whose contents live
 * in code — so a permissions row is described by the capability delta it
 * snapshotted, which setPlayerPermissions' own comment calls the only part of
 * the row that cannot go stale. A row with no snapshot says what it acted on
 * and no more, rather than inventing a figure.
 */
function changeSummary(log: AuditRowish, subjectName: string | null): string {
  const who = (subjectName ?? 'A MEMBER').toUpperCase();
  const delta = capabilityDelta(log.old_value, log.new_value);
  if (!delta) return `CONSOLE ACCESS · ${who}`;
  const parts: string[] = [];
  if (delta.added > 0) parts.push(`+${delta.added}`);
  if (delta.removed > 0) parts.push(`-${delta.removed}`);
  return parts.length > 0 ? `${parts.join(' ')} · ${who}` : `NO CHANGE · ${who}`;
}

/**
 * The sections a role opens, in that role's own declaration order.
 *
 * Every capability in an area requires that area's `.page` — the resolver's one
 * structural invariant — so the page keys ARE the sections, and CAPABILITY_GATES
 * already has a human sentence for each of them. Deriving the prose this way is
 * the whole reason this card can be trusted: there is no sentence here for a
 * later edit to ROLE_DEFAULTS to falsify.
 */
function sectionsOpenedBy(capabilities: readonly Capability[]): string[] {
  // The page keys as they are LISTED, rather than every capability mapped
  // through pageOf() and de-duplicated — the two differ in order, and the
  // second one sorts by whichever capability of an area happens to come first.
  // Safe because every role carries the page for every area it touches; that is
  // an invariant of the resolver (a capability whose area page is absent is
  // pruned) and it is pinned by a test, so filtering cannot lose a section.
  return capabilities
    .filter((capability) => capability === pageOf(capability))
    .map((page) => CAPABILITY_GATES[page].label);
}

/** `5 OFFICERS`, `1 OFFICER`. */
function plural(count: number, singular: string, plural_ = `${singular}S`): string {
  return `${count} ${count === 1 ? singular : plural_}`;
}
