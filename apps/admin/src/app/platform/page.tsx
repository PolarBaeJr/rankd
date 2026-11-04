export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { Card, PageHeader } from '@badminton/ui';
import { PlatformSettingsForm } from '@/components/platform-settings-form';
import { settingsForSection } from '@/lib/platform-setting-sections';
import { withSeededSettings } from '@/lib/platform-setting-fields';
import { FEATURES, FEATURES_SETTING_KEY, parseFeatureFlags } from '@badminton/shared/src/utils/features';
import { RELEASE_FLAGS, RELEASE_FLAGS_SETTING_KEY, parseReleaseFlags } from '@badminton/shared/src/utils/release-flags';
import {
  CONSOLE_PAGES,
  CONSOLE_PAGES_SETTING_KEY,
  parseConsolePages,
} from '@badminton/shared/src/utils/console-pages';
import { DataApiKeysCard } from './DataApiKeysCard';
import { AccountsRail, type AccountsRailSection } from '../accounts/accounts-rail';

// THE SUPER ADMIN'S PAGE (00321). "There should probably be a page that super
// admins can access to disable pages", and "remove platform systems from
// admins": everything here is PLATFORM_ONLY, so only a super admin opens it.
// The middleware sends anybody else to /unauthorized before this renders, and
// requireCapability below is the page's own re-check.
//
// What moved here from /accounts: the member page switches, the kill switches,
// the account rules, the club links and the data API keys. New here: the
// console page switches (console-pages.ts). /accounts keeps the officers and
// what the roles can do.
//
// Every settings card saves through updatePlatformSettings, which takes a
// reason and writes an audit row per key, exactly as before the move.
export default async function PlatformPage() {
  const viewer = await requireCapability('platform.page');
  const viewerLevel = accessLevelFor(viewer);
  const viewerPermissions = permissionsOf(viewerLevel, viewer);
  // The data API keys are their own capabilities, and the fetch below is
  // skipped without the read one, as it was on /accounts. The two writes
  // decide only which controls the card draws; the real gate on both acts is
  // the requireCapability inside actions/data-api-keys.ts.
  const showDataApiKeys = permits(viewerLevel, viewerPermissions, 'accounts.apikey.read');
  const canMintDataApiKey = permits(viewerLevel, viewerPermissions, 'accounts.apikey.mint.write');
  const canRevokeDataApiKey = permits(viewerLevel, viewerPermissions, 'accounts.apikey.revoke.write');

  const adminClient = createAdminClient();

  const { data: settings } = await adminClient.from('platform_settings').select('*').order('key');
  const seeded = withSeededSettings(settings ?? []);

  // `key_hash` IS NOT IN THIS SELECT and must never be: an unrendered column
  // still travels in the RSC payload. Both embeds name their foreign key,
  // because `data_api_keys` references `players` twice.
  const { data: apiKeyRows, error: apiKeysError } = showDataApiKeys
    ? await adminClient
        .from('data_api_keys')
        .select(
          'id, key_prefix, label, scopes, created_at, expires_at, revoked_at, consumer:data_api_consumers!data_api_keys_consumer_id_fkey(name), minter:players!data_api_keys_minted_by_fkey(full_name)',
        )
        .order('created_at', { ascending: false })
    : { data: null, error: null };

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

  // The saved switches, for the rail's counts. An absent row reads as every
  // switch on, exactly as the readers do.
  const valueOf = (key: string) => settings?.find((row) => row.key === key)?.value ?? null;
  const featureFlags = parseFeatureFlags(valueOf(FEATURES_SETTING_KEY));
  const featuresOn = FEATURES.filter((f) => featureFlags[f.id]).length;
  const consolePages = parseConsolePages(valueOf(CONSOLE_PAGES_SETTING_KEY));
  const consoleOn = CONSOLE_PAGES.filter((page) => consolePages[page.id]).length;
  const releaseFlags = parseReleaseFlags(valueOf(RELEASE_FLAGS_SETTING_KEY));
  const releaseOn = RELEASE_FLAGS.filter((f) => releaseFlags[f.id]).length;

  const sections: AccountsRailSection[] = [
    {
      id: 'member-pages',
      label: 'Member pages',
      sub: 'Switch member pages on or off',
      badge: `${featuresOn} / ${FEATURES.length} on`,
      tone: featuresOn === FEATURES.length ? 'success' : 'warning',
    },
    {
      id: 'console-pages',
      label: 'Console pages',
      sub: 'Switch console pages on or off',
      badge: `${consoleOn} / ${CONSOLE_PAGES.length} on`,
      tone: consoleOn === CONSOLE_PAGES.length ? 'success' : 'warning',
    },
    {
      id: 'kill-switches',
      label: 'Kill switches',
      sub: 'Undo a new console change',
      badge: `${releaseOn} / ${RELEASE_FLAGS.length} on`,
      tone: releaseOn === RELEASE_FLAGS.length ? 'success' : 'warning',
    },
    { id: 'account-rules', label: 'Account rules', sub: 'What a membership may do' },
    { id: 'club-links', label: 'Club links', sub: 'Instagram, Discord, membership' },
    ...(showDataApiKeys
      ? [{ id: 'data-api-keys', label: 'Data API keys', sub: 'Who reads the data from outside' }]
      : []),
  ];

  return (
    <div>
      <PageHeader
        eyebrow="SUPER ADMIN"
        title="Platform"
        sub="The switches and settings that run the whole platform, for super admins only"
        watermark="P"
      />

      <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <AccountsRail sections={sections} />

        <div className="flex min-w-0 flex-col gap-5">
          <section id="member-pages" className="scroll-mt-32" data-tour="member-pages">
            <Card className="overflow-hidden p-0">
              <SectionCardHeader
                title="Member pages"
                sub="Switch a page off and members see a short notice instead. Admins, and anyone given its access key, can still open it."
                aside="Saved with a reason, logged"
              />
              <div className="px-6 pt-5">
                <PlatformSettingsForm settings={settingsForSection(seeded, 'pages')} layout="tiles" />
              </div>
            </Card>
          </section>

          <section id="console-pages" className="scroll-mt-32">
            <Card className="overflow-hidden p-0">
              <SectionCardHeader
                title="Console pages"
                sub="Switch a console page off and it leaves the nav; officers who open it see a short notice instead. Super admins can still open it. Platform, Accounts, Permissions, the dashboard, sign-in and the legal documents cannot be switched off."
                aside="Saved with a reason, logged"
              />
              <div className="px-6 pt-5">
                <PlatformSettingsForm settings={settingsForSection(seeded, 'console')} layout="tiles" />
              </div>
            </Card>
          </section>

          <section id="kill-switches" className="scroll-mt-32">
            <Card className="overflow-hidden p-0">
              <SectionCardHeader
                title="Kill switches"
                sub="If a new console change breaks on the day, switch it off and the console goes back to what it did before. Each switch says what off falls back to."
                aside="Saved with a reason, logged"
              />
              <div className="px-6 pt-5">
                <PlatformSettingsForm settings={settingsForSection(seeded, 'release')} layout="tiles" />
              </div>
            </Card>
          </section>

          <section id="account-rules" className="scroll-mt-32">
            <Card className="overflow-hidden p-0">
              <SectionCardHeader
                title="Account rules"
                sub="What a member's account may do: challenges, match caps, no-shows, inactivity, check-in."
              />
              <div className="px-6 py-5">
                <PlatformSettingsForm settings={settingsForSection(seeded, 'accounts')} layout="grouped" />
              </div>
            </Card>
          </section>

          <section id="club-links" className="scroll-mt-32">
            <Card className="overflow-hidden p-0">
              <SectionCardHeader
                title="Club links"
                sub="The links the club publishes: Instagram, Discord, and where to buy a membership."
              />
              <div className="px-6 py-5">
                <PlatformSettingsForm settings={settingsForSection(seeded, 'club')} layout="links" />
              </div>
            </Card>
          </section>

          {showDataApiKeys && (
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
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One embedded row from a PostgREST many-to-one join, which supabase-js types
 * as an array on a client with no generated Database type.
 */
function embedded<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null;
  return (value as T | null) ?? null;
}

/** The header strip of a full-bleed card: title, a line under it, a note on the right. */
function SectionCardHeader({ title, sub, aside }: { title: string; sub?: React.ReactNode; aside?: string }) {
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

function CardHeading({ title }: { title: string }) {
  return (
    <h2
      className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
      style={{ fontFamily: 'var(--display)' }}
    >
      {title}
    </h2>
  );
}
