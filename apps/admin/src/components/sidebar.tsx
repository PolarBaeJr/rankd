'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn, NavMenu, nestItems, visibleEntries, isRouteActive, isGroupActive } from '@badminton/ui';
// Deep import, not the '@badminton/shared' barrel — see the player middleware.
import { signOutThisDevice } from '@badminton/shared/src/utils/sign-out';
import { withBase } from '@/lib/base-path';
import { memberAppUrl } from '@/lib/player-url';
import { LogOut, ArrowLeftRight, Menu, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import {
  canAccess,
  effectiveCapabilities,
  permissionsOf,
  UNRESTRICTED,
  type AccessLevel,
  type PermissionsInput,
} from '@/lib/permissions';
import { NAV_LAYOUT, adminNavItemOn, type NavItem } from './nav-sections';
import { ALL_FEATURES_ENABLED, type FeatureFlags } from '@badminton/shared/src/utils/features';
import { isChromelessRoute } from '@/lib/chromeless-routes';

// How quickly a promotion, demotion or narrowing reaches an already-open tab.
const POLL_MS = 5000;

export function Sidebar({
  initialAccessLevel = null,
  initialPermissions = null,
  features = ALL_FEATURES_ENABLED,
}: {
  initialAccessLevel?: AccessLevel | null;
  // The stored triple, not a resolved Permissions: a Set does not survive the
  // boundary between a server component and this one. Resolved below with the
  // same function the server used.
  initialPermissions?: PermissionsInput | null;
  // The club feature switches, read by the layout. Not polled with the access
  // level: they change rarely, and saving one re-renders the layout.
  features?: FeatureFlags;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  // Seeded from the server so the FIRST paint is already filtered. The effect
  // below still runs (it also fetches the email, and refreshes the level on a
  // client-side navigation), but it no longer decides what the user sees first.
  //
  // Level and triple move together, in ONE state, because they are one answer:
  // holding them apart would let a render see the new level with the old
  // permissions, which is the half-updated nav this whole component exists to
  // avoid.
  const [access, setAccess] = useState<{
    level: AccessLevel | null;
    permissions: PermissionsInput | null;
  }>({ level: initialAccessLevel, permissions: initialPermissions });
  const [accessLoaded, setAccessLoaded] = useState(initialAccessLevel !== null);
  // The phone menu. Below lg the bar holds only the brand and this toggle: the
  // grouped row needs about 1000px, and squeezed beside the account links it
  // became a sideways-scrolling strip a hundred pixels wide.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  // Don't render header on public routes
  const isPublicRoute = isChromelessRoute(pathname);

  // Load the email once, then keep the access level fresh.
  //
  // POLLED, not one-shot: a promotion or demotion has to reach an open tab
  // without waiting for the person to navigate. Server components already read
  // the level per request, and the middleware re-checks it on every request, so
  // the only stale surface is a tab someone is sitting on — this closes it
  // within POLL_MS.
  //
  // Paused while the tab is hidden. A console left open in a background tab
  // overnight should not be doing anything.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function readLevel(): Promise<void> {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) { setAccessLoaded(true); return; }
      setUserEmail(user.email ?? null);

      // The same RPC the middleware calls, so the nav and the boundary are
      // answering from one source. A narrowing takes effect here within POLL_MS
      // for exactly the same reason a demotion does.
      const { data, error } = await supabase.rpc('admin_console_access', { p_user_id: user.id });
      if (cancelled) return;
      // Only trust a SUCCESSFUL read. supabase-js returns data: null on error,
      // so writing it unconditionally would turn a transient RPC failure into
      // "you have no access" — and since the nav now fails closed, that emptied
      // the whole sidebar until a reload. Keeping the last good answer is not
      // failing open: the middleware re-decides on every navigation and the
      // server actions gate independently, so the worst case is a link that
      // bounces, not a door that opens.
      if (error) { setAccessLoaded(true); return; }

      const row = data as (PermissionsInput & { level: string | null }) | null;
      const next = {
        level: (row?.level as AccessLevel | null) ?? null,
        permissions: row
          ? {
              permission_role: row.permission_role ?? null,
              permission_grants: row.permission_grants ?? [],
              permission_revokes: row.permission_revokes ?? [],
            }
          : null,
      };

      setAccess((prev) => {
        // Server components hold the old answer too, so re-render them rather
        // than leaving a half-updated page — the nav would say one thing and
        // the page body another. Compared by value: the triple is a fresh
        // object on every poll, so an identity check would refresh forever.
        if (JSON.stringify(prev) !== JSON.stringify(next)) router.refresh();
        return next;
      });
      setAccessLoaded(true);
    }

    void readLevel();

    function start() {
      if (timer === null) timer = setInterval(() => { void readLevel(); }, POLL_MS);
    }
    function stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') { void readLevel(); start(); } else { stop(); }
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  async function handleSignOut() {
    await signOutThisDevice(createClient().auth);
    window.location.href = withBase('/login');
  }

  if (isPublicRoute) return null;

  // Fails CLOSED: nothing is shown until the access level is known. The layout
  // seeds it from the server, so in practice this resolves before first paint
  // and nothing flashes at all. It only bites on a public route or if the
  // lookup threw — and an empty nav for a moment is the right failure, because
  // the alternative was execs watching admin-only sections appear and vanish on
  // every load.
  //
  // Still cosmetic, not a boundary: the middleware and every server action gate
  // independently. This just stops the UI advertising doors that won't open.
  const permissions = access.permissions
    ? permissionsOf(access.level, access.permissions)
    : UNRESTRICTED;
  // A group this person can open nothing in is dropped; one with anything in it
  // stays a menu, even a menu of one, so the bar keeps the same shape as a
  // grant or revoke lands.
  const held = effectiveCapabilities(access.level, permissions);
  const entries = visibleEntries(
    NAV_LAYOUT,
    (item) =>
      accessLoaded
      && canAccess(access.level, permissions, item.href)
      && adminNavItemOn(item.href, features, held),
  );

  const navText = (isActive: boolean) =>
    cn(
      'relative px-3 py-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap transition-colors',
      isActive
        ? 'text-[var(--text-primary)]'
        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
    );

  const navLink = (item: NavItem) => {
    const isActive = isRouteActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={navText(isActive)}
      >
        {item.label}
        {isActive && (
          <span className="absolute left-3 right-3 bottom-0 h-[2px] bg-[var(--color-accent)]" />
        )}
      </Link>
    );
  };

  const mobileRow = (isActive: boolean, indented = false) =>
    cn(
      'flex items-center gap-2.5 min-h-[44px] px-4 text-[12px] font-semibold uppercase tracking-[0.08em] transition-colors',
      indented && 'pl-8',
      isActive
        ? 'text-[var(--text-primary)] shadow-[inset_2px_0_0_var(--color-accent)] bg-[var(--border-hover)]'
        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
    );

  // exact: a parent with folded rows is current only on its own page, as in the bar.
  const mobileLink = (href: string, label: string, exact = false, indented = false) => {
    const isActive = exact ? pathname === href : isRouteActive(pathname, href);
    return (
      <Link key={href} href={href} onClick={() => setMenuOpen(false)} aria-current={isActive ? 'page' : undefined} className={mobileRow(isActive, indented)}>
        {label}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-40 bg-[var(--bg-primary)] border-b border-[var(--border)]">
      {/* Brand + grouped nav + user */}
      <div className="flex items-center gap-4 px-4 lg:px-6">
        <Link href="/dashboard" className="flex items-center gap-2.5 flex-shrink-0 py-2.5">
          <span className="w-8 h-8 grid place-items-center bg-[var(--color-accent)] text-white font-display font-bold text-sm">
            SB
          </span>
          <span className="hidden sm:block text-xs font-bold uppercase tracking-[0.12em] whitespace-nowrap text-[var(--text-primary)]">
            Club Ladder <span className="text-[var(--text-muted)]">· Admin</span>
          </span>
        </Link>
        <nav className="hidden lg:flex items-center overflow-x-auto min-w-0">
          {entries.map((entry) => {
            if (entry.kind === 'link') return navLink(entry.item);
            const { group } = entry;
            const isActive = isGroupActive(pathname, group);
            return (
              // Keyed by the group's id, never its items: the access poll above
              // hands back fresh arrays every five seconds, and a key built from
              // them would remount the menu and shut it under the reader.
              <NavMenu
                key={group.id}
                id={group.id}
                label={group.label}
                active={isActive}
                pathname={pathname}
                // A parent with folded rows is current only on its own page,
                // exactly: under it, the child row is the one that lights up.
                items={nestItems(group.items, group.nest).map(({ item, selfLabel, children }) =>
                  children.length > 0
                    ? {
                        href: item.href,
                        label: item.label,
                        current: pathname === item.href,
                        selfLabel,
                        children: children.map((child) => ({
                          href: child.href,
                          label: child.label,
                          current: isRouteActive(pathname, child.href),
                        })),
                      }
                    : {
                        href: item.href,
                        label: item.label,
                        current: isRouteActive(pathname, item.href),
                      },
                )}
                renderLink={(item, props) => <Link href={item.href} {...props} />}
                triggerClassName={cn(
                  navText(isActive),
                  'flex items-center gap-1',
                  isActive &&
                    "after:content-[''] after:absolute after:left-3 after:right-3 after:bottom-0 after:h-[2px] after:bg-[var(--color-accent)]"
                )}
                panelClassName="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl overflow-hidden shadow-xl py-1"
                linkClassName="flex items-center gap-2.5 px-4 min-h-[40px] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] focus-visible:outline-none focus-visible:bg-[var(--border-hover)] aria-[current=page]:text-[var(--text-primary)] aria-[current=page]:shadow-[inset_2px_0_0_var(--color-accent)] transition-colors"
                toggleClassName="grid w-9 place-items-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] focus-visible:outline-none focus-visible:bg-[var(--border-hover)]"
                childIndentClassName="pl-8"
              />
            );
          })}
        </nav>
        <div className="ml-auto hidden lg:flex items-center gap-3 flex-shrink-0">
          <a
            href={memberAppUrl()}
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
          >
            <ArrowLeftRight className="w-4 h-4" aria-hidden />
            <span>Member app</span>
          </a>
          {userEmail && (
            <span className="hidden lg:block text-xs text-[var(--text-muted)] truncate max-w-[200px]">
              {userEmail}
            </span>
          )}
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            {/* Always labelled. This was `hidden md:inline`, which left an
                unexplained icon on a narrow window — and the console is used on
                a phone at the door, which is exactly where a bare glyph is
                least guessable. The owner could not find how to sign out. */}
            <span>Sign out</span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-controls="admin-mobile-menu"
          className="lg:hidden ml-auto -mr-2 grid w-11 h-11 place-items-center text-[var(--text-primary)]"
        >
          {menuOpen ? <X className="w-5 h-5" aria-hidden /> : <Menu className="w-5 h-5" aria-hidden />}
          <span className="sr-only">{menuOpen ? 'Close menu' : 'Open menu'}</span>
        </button>
      </div>
      {menuOpen && (
        <nav
          id="admin-mobile-menu"
          className="lg:hidden border-t border-[var(--border)] max-h-[calc(100dvh-53px)] overflow-y-auto overscroll-contain pb-2"
        >
          {entries.map((entry) => {
            if (entry.kind === 'link') return mobileLink(entry.item.href, entry.item.label);
            const { group } = entry;
            return (
              <div key={group.id} className="pt-2">
                <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  {group.label}
                </div>
                {nestItems(group.items, group.nest).map(({ item, selfLabel, children }) => (
                  <div key={item.href}>
                    {mobileLink(item.href, children.length > 0 ? (selfLabel ?? item.label) : item.label, children.length > 0)}
                    {children.map((child) => mobileLink(child.href, child.label, false, true))}
                  </div>
                ))}
              </div>
            );
          })}
          <div className="mt-2 border-t border-[var(--border)] pt-2">
            {userEmail && (
              <div className="px-4 py-2 text-xs text-[var(--text-muted)] truncate">{userEmail}</div>
            )}
            <a href={memberAppUrl()} className={mobileRow(false)}>
              <ArrowLeftRight className="w-4 h-4" aria-hidden />
              Member app
            </a>
            <button type="button" onClick={handleSignOut} className={cn(mobileRow(false), 'w-full')}>
              <LogOut className="w-4 h-4" aria-hidden />
              Sign out
            </button>
          </div>
        </nav>
      )}
    </header>
  );
}
