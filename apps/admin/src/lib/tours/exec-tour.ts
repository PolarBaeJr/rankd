// THE EXEC TOUR, as data. Its own module with no framework import so a test
// can read it: the host component (components/exec-tour-host.tsx) pulls in
// next/navigation.
//
// IT VISITS EACH PAGE. A step's href is the page it is shown on, and the tour
// opens it through the router; the target is something on that page. A step
// whose page redirects the reader away, or whose target never appears, is
// skipped, so each step's `requires` must match what its page actually renders
// (exec-tour.test.ts checks that the reader can open every href).
//
// Each step names the capability that makes it true for the reader. What an
// officer holds varies with their role and grants (access-level.ts), so an
// officer who cannot approve signups is never told how to. Two steps also have
// a sentence that depends on a second capability (bulk session edits, the
// Discord cross-post), which is why the steps are built from what the reader
// holds rather than declared once.
//
// Deep imports, not the package barrels: a test loads this file.
import type { TourStep } from '@badminton/ui/src/tour';
import type { TourKey } from '@badminton/shared/src/utils/tours';

export const EXEC_TOUR_KEY: TourKey = 'exec_v2';

/**
 * Whether the tour may open by itself for this level. Never for a trainer,
 * whose console is the roster and varsity notes, and never before the level is
 * known. A replay from Settings is allowed for anybody.
 */
export function execTourMayAutoStart(level: string | null): boolean {
  return level !== null && level !== 'trainer';
}

export function execTourSteps(held: ReadonlySet<string>): TourStep[] {
  const canBulkSessions = held.has('sessions.create.write') || held.has('sessions.update.write');
  const canIssueQr = held.has('sessions.checkin.token.write');
  const canPostToDiscord = held.has('announcements.discord.write');

  return [
    {
      id: 'welcome',
      title: 'Welcome to the console',
      body: 'A short look at where the club is run from. What you see depends on what you have been given, so some of this may not apply to you yet.',
      targets: [],
      missingTarget: 'center',
    },
    {
      id: 'pending-approvals',
      title: 'Pending approvals',
      body: 'New signups waiting for an exec land on the dashboard, and you approve them here.',
      href: '/dashboard',
      targets: ['[data-tour="pending-approvals"]'],
      missingTarget: 'skip',
      requires: { capabilitiesAll: ['players.approve.write'] },
    },
    {
      id: 'sessions',
      title: 'Sessions',
      body: canBulkSessions
        ? 'The club schedule. Create a session, or select several and edit, archive or delete them together. Find it under Play in the top bar.'
        : 'The club schedule, and who is coming to each night. Find it under Play in the top bar.',
      href: '/sessions',
      targets: ['[data-tour="sessions-upcoming"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], capabilitiesAll: ['sessions.page'] },
    },
    {
      id: 'door',
      title: 'The door list',
      body: canIssueQr
        ? "Tonight's door list shows who is signed up and who has checked in. Check-in QR puts up the code members scan at the door."
        : "Tonight's door list shows who is signed up and who has checked in. Showing the check-in QR code needs a permission an admin can grant.",
      href: '/sessions',
      targets: ['[data-tour="checkin-qr"]', '[data-tour="door-tonight"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['sessions'], capabilitiesAll: ['sessions.page'] },
    },
    {
      id: 'members',
      title: 'Members',
      body: 'Every member of the club, their standing and their approval. Search by name, handle or email. Find it under Members.',
      href: '/players',
      targets: ['[data-tour="roster"]'],
      missingTarget: 'skip',
      requires: { capabilitiesAll: ['players.page'] },
    },
    {
      id: 'club-events',
      title: 'Club events',
      body: 'Socials, workshops, clinics and the AGM, and who has signed up. Find it under Events.',
      href: '/events',
      targets: ['[data-tour="events-upcoming"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['events'], capabilitiesAll: ['events.page'] },
    },
    {
      id: 'announcements',
      title: 'Announcements',
      body: canPostToDiscord
        ? 'Post news to the members app, and send it to the club Discord at the same time. Find it under Club.'
        : 'Post news to the members app. Find it under Club.',
      href: '/announcements',
      targets: ['[data-tour="announcement-composer"]'],
      missingTarget: 'skip',
      requires: { featuresAny: ['announcements'], capabilitiesAll: ['announcements.page'] },
    },
    {
      id: 'feature-switches',
      title: 'Feature switches',
      body: 'Switch whole parts of the members app on or off, such as challenges or tournaments. Find it under System, then Platform.',
      href: '/platform',
      targets: ['[data-tour="member-pages"]'],
      missingTarget: 'skip',
      // /platform opens on platform.page, a super admin's alone (00321).
      requires: { capabilitiesAll: ['platform.page', 'platform.settings.write'] },
    },
    {
      id: 'settings',
      title: 'Settings',
      body: 'Add a passkey here. The console needs one after your first 14 days. Replay console tour, on this page, runs this again.',
      href: '/settings',
      targets: ['[data-tour="passkeys"]'],
      missingTarget: 'center',
    },
    {
      id: 'done',
      title: 'That is the tour',
      body: 'Replay it any time from Settings.',
      targets: [],
      missingTarget: 'center',
    },
  ];
}
