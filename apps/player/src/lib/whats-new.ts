// THE MEMBERS' RELEASE NOTES, shown at /whats-new.
//
// Newest first, one entry per version that shipped, written for members rather
// than for whoever deployed it. A version that never shipped (1.0.9) is not
// listed. `execs` is for changes only the console shows.

export type WhatsNewEntry = {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  members: string[];
  execs?: string[];
};

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.1.8',
    date: '2026-11-03',
    title: 'Paid events, live tournaments and better receipts',
    members: [
      'A paid club event takes your e-Transfer screenshot as you sign up.',
      'A full event can keep a waitlist, and the club can cap how long it gets.',
      "A tournament run for a club event is entered from the club event's page.",
      'Doubles check-in is per person: your team is in once both of you are.',
      'Tournament days run live: the next match goes on court by itself, and you can see your court.',
      'Fee receipts are read from more banks, HEIC photos and SFU Rec purchases.',
    ],
    execs: [
      'Fees is one member list with a View menu, and the club money moved to a new Finances page.',
      'Add somebody to a club event by hand, and sign-up lists show newest first.',
      'Court helpers score their own courts from My courts, and a court can skip a match for now.',
      'A staged group stage can add a round and take late entrants, and a group plays only on its own courts.',
      'Every exec can read everything, and every new ability can be granted.',
      'The Discord bot works in any server, with auto mod, /purge and /event signups.',
      'Saved settings show as text first, with an Edit button.',
    ],
  },
  {
    version: '1.1.7',
    date: '2026-10-22',
    title: 'Read first, edit second',
    members: [],
    execs: [
      'Saved records show as text with an Edit button, so nothing changes by accident.',
      "A Google Form sign-up shows the preferred partner they typed on the event's list.",
      'Approving a receipt records the amount actually paid, prefilled from what the receipt shows.',
      'The paste box example reads name, email, amount, and says the email is optional.',
    ],
  },
  {
    version: '1.1.6',
    date: '2026-10-22',
    title: 'Faster updates',
    members: [
      'Fee receipt screenshots in newer image formats are read more reliably.',
    ],
    execs: ['Updates to the app build in about a quarter of the time, so fixes reach you sooner.'],
  },
  {
    version: '1.1.5',
    date: '2026-10-22',
    title: 'Receipt reading',
    members: [
      'The receipt reader finds the amount on more screenshots, including bank "deposited" notices.',
    ],
    execs: [
      'The payee name setting takes several names, separated by commas.',
      "A Google Form's question mapping saved before waiver questions existed now offers the waiver questions too.",
    ],
  },
  {
    version: '1.1.4',
    date: '2026-10-22',
    title: 'One Review button',
    members: [],
    execs: [
      'Each receipt has one Review button that shows the screenshot with Approve and Reject.',
      'A Google Form receipt without a reference can still be approved.',
      'A receipt sent before its event was made, or after it ended, is held for a person to look at.',
    ],
  },
  {
    version: '1.1.3',
    date: '2026-10-21',
    title: 'Receipts that confirm themselves',
    members: [
      'A fee receipt the app reads cleanly is confirmed straight away, with no wait for an exec.',
    ],
    execs: [
      "The console can make an event's Google Form and keep it in step with the event.",
      "A Google Form's waiver answers sign the guest waiver.",
      'One Signed up list for members and Form guests, and a printable sheet of groups and match times.',
      'A club event row opens the event, and Past events stay hidden until one has happened.',
    ],
  },
  {
    version: '1.1.2',
    date: '2026-10-21',
    title: 'Club events for everyone',
    members: [
      "Anyone can see the club's events and tournaments; a visitor signs up through the event's Google Form.",
      "Club event pages have a poster header, a details strip and a 'your spot' card.",
      "Answering a club event's Google Form signs you up at once. Not me takes it back if it was not you.",
      "If you signed the waiver on an event's Google Form, the app does not ask again for its tournament.",
      'A club event can run as a tournament, with brackets, scores and check-in.',
    ],
    execs: [
      'Run a club event as a tournament: sign-ups and entries stay the same both ways, and the fee is charged once.',
      'Non-members from a Google Form are entered as guests, with a Guests view under Players.',
      'Door check-in for club events and whole tournaments, with walk-ins, no-shows and a waitlist.',
      '/softban on Discord removes a spammer and their recent messages, and a server log records what happens.',
    ],
  },
  {
    version: '1.1.1',
    date: '2026-10-19',
    title: 'The club on Discord',
    members: [
      '/schedule on Discord shows your next two weeks of sessions, events and tournaments.',
      'A full-page Calendar, and tournaments now appear in your subscribed calendar.',
      '/tournaments on Discord: enter, read a draw, find your next match and follow results.',
      "Passkey sign-in inside an app's built-in browser, such as Instagram, now says what to do instead of failing silently.",
    ],
    execs: [
      'Run sessions, club events and tournament days from Discord with /session, /event and /tourney.',
      "A Google Form's e-Transfer screenshots reach the fee review, and a form can pay a season's dues.",
      'A draft club event takes its Google Form, so the mapping can be tested before the event is announced.',
      "The console's top bar becomes a menu on phones.",
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-08',
    title: 'Membership, receipts and club events',
    members: [
      "A public Membership page shows this season's prices and how to buy a membership, and your fee statement now lives there.",
      'Send a receipt for your fees: a screenshot of your e-Transfer or SFU Rec purchase.',
      'Sign in with a password if you like. Email codes and passkeys still work, and Settings can sign out your other devices.',
      'Sign-in and sign-up are separate pages, and account setup asks one question per screen.',
      'The Feed is the home page: a week strip, the month calendar and Up next for the coming two weeks.',
      'Club events: socials, workshops, clinics, outings and the AGM, with their own sign-up.',
      'A short tour on your first visit. Replay it from Settings.',
      'Challenges are redesigned, and best of 5 and best of 7 results can be reported in full.',
      'Challenge, report a result or join the club from Discord.',
      'Send a fee receipt from Discord with /receipt, once your Discord account is linked.',
      'Choose whether the club may use photos and videos of you, in Settings.',
      'A Discord link on every page, and a Socials page.',
      'Error screens show a short code to quote when you report a problem.',
      'This page: a list of what changed in each version, under Settings > About.',
      'Joining from Discord asks for your SFU email if you have one.',
      'Your challenges can show a predicted chance of winning, when the club turns predictions on.',
      "Signed up through the club's Google Form? Confirm the entry in the app, or say it was not you.",
      'Signed in, this page also lists changes to how the club runs, such as rating settings and club rules, when the club posts them.',
    ],
    execs: [
      'Fee tools: receipt review, Paste a list, and named payments that follow a member who signs up later.',
      'Switch member pages on or off under Accounts.',
      'Audit trail download, and the top bar grouped into menus.',
      "A Member app link in the console's top bar takes you back to the members' site.",
      "The audit log's search, filters and download sit in two tidy rows, and the activity chart is gone.",
      'The four Legal pages are one Legal entry in the Club menu, which opens to show them.',
      'The Data API has a public changelog page.',
      'A Data API key can be minted with no expiry, and its date uses the club calendar.',
      'The Accounts side menu follows the section you are reading.',
      'Data API keys can carry a predictions write scope.',
      'Bind a Google Form to a tournament or club event: members confirm in the app, and non-members are entered with a named fee and a guest waiver email.',
      "The console can read a Google Form itself, with no script on the form: keep the form in the club's forms folder and set its question titles on the Google Form card.",
      'Club changes: edits to ratings, account rules, member pages, club links and officer roles collect as plain-language lines. Reword them and post one or all to members, optionally as an announcement.',
    ],
  },
  {
    version: '1.0.8',
    date: '2026-09-29',
    title: 'Court desk search',
    members: [],
    execs: [
      'Search the court desk, and check-in times shown in club time.',
    ],
  },
  {
    version: '1.0.7',
    date: '2026-09-29',
    title: 'Tournament fixes',
    members: [
      'Repeat challenges against the same opponent within 30 days count for less. Past ratings are not recalculated.',
      "A tournament's start date shows the right day, and pairs are called pairs.",
      'Confirming a rated challenge result no longer fails.',
    ],
    execs: [
      'Unrated events for teams from other clubs, entered by name.',
      'Boost one rated match by up to 2x, and tune how much repeat challenges count.',
      'Undo a check-in or a no-show.',
    ],
  },
  {
    version: '1.0.6',
    date: '2026-09-29',
    title: 'My stats by season',
    members: [
      'Every card on My stats now follows the season you pick.',
      'Signed-in pages, the Feed and Settings load faster.',
    ],
  },
  {
    version: '1.0.5',
    date: '2026-09-26',
    title: 'Passkey fixes',
    members: [
      "If a passkey cannot work inside an app's built-in browser, the page now says so.",
      'On iPhone, one tap opens the passkey sheet.',
      'A fresh sign-in code is no longer reported as expired.',
    ],
  },
  {
    version: '1.0.4',
    date: '2026-09-22',
    title: 'Your data',
    members: [
      'Download everything the club holds about you, from Settings.',
    ],
  },
  {
    version: '1.0.3',
    date: '2026-09-19',
    title: 'Final standings',
    members: [
      'The leaderboard shows final standings for a finished season and marks your own row.',
      'Rounded corners across the app.',
    ],
  },
  {
    version: '1.0.2',
    date: '2026-09-18',
    title: 'Tidying up',
    members: [
      'A zero singles streak no longer shows as a bare 0 on your profile.',
      'The ladder and your profile say which figures count since the last season rollover.',
    ],
    execs: [
      'Edit a posted announcement in place in the composer.',
      'Boxes in the console have rounded corners again.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-09-17',
    title: 'First fixes',
    members: [
      'Dates more than a week away show in club time.',
      'Tournament points are no longer labelled Provisional.',
      'The app no longer names the current season when you are looking at a past one.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-13',
    title: 'Launch',
    members: [
      'The SFU Badminton Club app: sessions, the ladder, challenges, tournaments and your stats in one place.',
    ],
  },
];
