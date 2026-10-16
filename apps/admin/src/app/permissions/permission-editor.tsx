'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  SearchFilter,
  Select,
  Textarea,
  cn,
  filterPlayerOptions,
  useConfirm,
} from '@badminton/ui';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { setConsoleAccess, setPlayerPermissions } from '@/lib/actions';
// The console's shared floor for a typed reason, imported and never copied —
// audit-reason.ts is a plain module, so a client component may read it. The
// server measures against the same constant; this only decides when Save stops
// being disabled.
import { REASON_MIN } from '@/lib/audit-reason';
// The one mapping between "what console access does this person have" and the
// three columns that store it, shared with the /players Edit dialog.
import { EXEC_ROLE_OPTIONS, accessForLevel, type ExecRole } from '@/lib/console-access';
// Labels and grouping for all 115. Its own module precisely so that pages
// which only need the vocabulary do not ship it; the editor is the one screen
// that genuinely does.
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
// Everything about the QUEUE — who has something pending, what it adds up to,
// and the validate-everyone-then-write-everyone ordering. Pure, and tested as
// such in lib/__tests__/permission-batch.test.ts.
import {
  draftOf,
  draftSet,
  dropPending,
  isPermissionRole as isRole,
  localRefusal,
  pendingEntries,
  saveBatch,
  totalChanges,
  type Draft,
  type PendingEdits,
} from '@/lib/permission-batch';
import {
  effectiveCapabilities,
  isBuiltinPermissionRole,
  resolvePermissions,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  type AccessLevel,
  type Area,
  type Capability,
  type CustomBaseline,
  type PermissionRole,
} from '@/lib/permissions';
// The row this editor lists. It lives in a pure module because a second screen
// builds one now and the mapping needed a test — see the header there.
import type { PersonRow } from '@/lib/person-row';

// Re-exported so every existing `from './permission-editor'` import keeps
// working. The shape did not move because somebody wanted it elsewhere in the
// tree; it moved so the builder beside it could be called without a DOM.
export type { PersonRow };

// Words for the machine-readable path segments. The area and group keys are
// path segments — lower-case, no spaces — and putting them on screen raw would
// make this read like a config file rather than like a list of jobs.
const AREA_LABELS: Record<Area, string> = {
  players: 'Players',
  seasons: 'Seasons',
  sessions: 'Sessions',
  matches: 'Matches',
  challenges: 'Challenges',
  announcements: 'Announcements',
  tournaments: 'Tournaments',
  events: 'Club events',
  fees: 'Finances',
  legal: 'Legal',
  walkovers: 'Walkovers',
  disputes: 'Disputes',
  permissions: 'Permissions',
  audit: 'Audit log',
  ratings: 'Ratings',
  accounts: 'Accounts',
  platform: 'Platform',
  changelog: 'Club changes',
  page: 'Switched-off pages',
};

const GROUP_LABELS: Record<string, string> = {
  manage: 'Setup',
  draw: 'Draw',
  results: 'Results',
  fees: 'Entry fees',
  expenses: 'Expenses',
  otherincome: 'Other income',
  clubfees: 'Club fees',
  reinstatements: 'Reinstatements',
  netposition: 'Net position',
  playerflags: 'Fee flags',
};

// TIER 2 APPEARS ONLY WHERE IT EARNS ITS KEEP. Tournaments is 38 of the 70
// offerable capabilities and is unreadable as one flat list; every other area
// is eight rows or fewer, and wrapping four rows in a collapsible group is a
// click that buys nothing. The threshold is a rendering decision, not a
// boundary — nothing about access depends on which tier a leaf is drawn at.
const FLAT_UNDER = 9;

// HOW MANY ORDINARY MEMBERS A SEARCH SHOWS AT ONCE. The list behind the search
// box is the whole club — a hundred people on staging — and a search that
// returns eighty rows has not answered anything. Typing another letter is the
// cheaper way to narrow it, and the count below the list says so.
const OTHERS_SHOWN = 20;

type Leaf = { capability: Capability; label: string; mode: 'page' | 'read' | 'write' };
// `page` is held apart from `leaves` rather than sorted to the front of them.
// It is not a peer of the data reads: it is the thing every other row in the
// area depends on, and the resolver prunes the lot when it is off. Giving it its
// own slot is what lets the area render it as a statement rather than as the
// first tick box in a list.
type Node = { key: string; label: string; page: Leaf | null; leaves: Leaf[]; children: Node[] };

// The tree, built once from the offerable list. Ordering follows
// EDITOR_OFFERABLE, which follows the exec baseline, which reads top-down as
// the club's own list of what an exec does.
function buildTree(): Node[] {
  const areas: Node[] = [];
  for (const capability of EDITOR_OFFERABLE) {
    const entry = CAPABILITY_GATES[capability];
    let area = areas.find((a) => a.key === entry.area);
    if (!area) {
      area = { key: entry.area, label: AREA_LABELS[entry.area], page: null, leaves: [], children: [] };
      areas.push(area);
    }
    const leaf: Leaf = { capability, label: entry.label, mode: entry.mode };
    if (entry.mode === 'page') area.page = leaf;
    else area.leaves.push(leaf);
  }
  for (const area of areas) {
    if (area.leaves.length < FLAT_UNDER) continue;
    for (const leaf of area.leaves) {
      const group = CAPABILITY_GATES[leaf.capability].group;
      if (group === null) continue;
      let child = area.children.find((c) => c.key === `${area.key}.${group}`);
      if (!child) {
        child = {
          key: `${area.key}.${group}`,
          label: GROUP_LABELS[group] ?? group,
          page: null,
          leaves: [],
          children: [],
        };
        area.children.push(child);
      }
      child.leaves.push(leaf);
    }
    // Only the leaves that found a group move down a tier; anything without one
    // stays where it is rather than vanishing.
    if (area.children.length > 0) {
      const grouped = new Set(area.children.flatMap((c) => c.leaves.map((l) => l.capability)));
      area.leaves = area.leaves.filter((l) => !grouped.has(l.capability));
    }
  }
  return areas;
}

const TREE = buildTree();

const ALL_KEYS = TREE.flatMap((area) => [area.key, ...area.children.map((c) => c.key)]);

// `level` is the state a person is in before anybody composes them: they hold
// the capability because of the LEVEL they were given, and nothing is stored.
// Its own state rather than a shade of `role`, because the two answer different
// questions — "their job gives them this" and "the club gave them this level" —
// and the first click on a `level` cell is what turns one into the other.
type CellState = 'level' | 'role' | 'granted' | 'revoked' | 'off';

// THE THREE SEGMENTS, and the whole of the model they stand for. `inherit` is
// no delta at all — whatever the base gives, they get; `on` is a grant; `off` is
// a revoke. Five cell states collapse onto three segments because two pairs of
// them are the SAME stored row read against different bases: "from level" and
// "from role" are both "nothing stored for this", and so is an `off` under a
// role that never gave it.
type Segment = 'inherit' | 'off' | 'on';

const SEGMENT_OF: Record<CellState, Segment> = {
  level: 'inherit',
  role: 'inherit',
  off: 'inherit',
  granted: 'on',
  revoked: 'off',
};

// The active segment is FILLED and the other two are not, so a row reads as one
// answer rather than as three buttons. Green is the only colour here that means
// anything on its own — it is the same green the counts use for "they hold this".
const SEGMENTS: readonly { value: Segment; label: string; activeClass: string }[] = [
  { value: 'inherit', label: 'Inherit', activeClass: 'bg-[var(--surface-2)] text-[var(--mute)]' },
  { value: 'off', label: 'Off', activeClass: 'bg-[var(--surface-3)] text-[var(--ink)]' },
  { value: 'on', label: 'On', activeClass: 'bg-[var(--win)] text-[var(--bg)]' },
];

// page has no badge. The design called for purple and the console has no purple
// token — and adding one is the single thing ds-bundle/guidelines/admin-console
// forbids outright ("No new colour values", "Badge — success/warning/danger/
// neutral only"). It costs nothing here: the page row is already the one row in
// an area drawn on its own surface with its own prose, so it is told apart by
// shape rather than by hue.
const SCOPE_BADGE: Record<Leaf['mode'], 'info' | 'warning' | null> = {
  page: null,
  read: 'info',
  write: 'warning',
};

const LEVEL_DEFAULT_OPTION = '';

const LEVEL_LABELS: Record<AccessLevel, string> = {
  admin: 'Admin',
  exec: 'Executive',
  trainer: 'Varsity trainer',
};

// THE DEFAULT STATE IS NAMED AFTER WHAT THE PERSON HAS, never after the absence
// of a stored role. It used to read "Unrestricted", which is engineering
// shorthand for permission_role IS NULL and, on a varsity trainer, an outright
// lie: the club owner opened the trainer's row and saw "Unrestricted" directly
// above "Effective access — 3 of 116". Their words were "it is very restricted",
// and they were right.
//
// The underlying concept is untouched — a NULL role still means "not composed",
// and every comment explaining why still says so. This is what the screen calls
// it.
const LEVEL_ACCESS_LABELS: Record<AccessLevel, string> = {
  admin: 'Admin access',
  exec: 'Executive access',
  trainer: 'Varsity access',
};

// WHAT THAT DEFAULT MEANS, IN WORDS, PER LEVEL. Two places describe the state
// somebody returns to when no role is set — the confirmation behind the select
// and the line under it — and both used to say "the executive baseline" because
// only an exec could be composed. On a trainer that is simply false, so the
// phrase is read from the row being edited rather than written into the prose.
const BASELINE_PHRASE: Record<AccessLevel, string> = {
  admin: 'every capability there is',
  exec: 'everything an executive can do',
  trainer: 'opening the roster, reading it, and writing varsity notes',
};

// A CUSTOM BASELINE IS CHOSEN LIKE A ROLE AND STORED LIKE A HAND-PICKED SET.
// The select value carries the id because <Select> deals in strings, and the
// prefix keeps it out of the way of the five real role values — a baseline
// called "custom" must not read back as the role.
const BASELINE_PREFIX = 'baseline:';

// Built per row for the same reason: the first option names the person's own
// level, so it cannot be a module constant any more.
//
// THE FOUR VP JOBS ARE NOT IN THIS LIST ANY MORE, AND LEAVING THEM WOULD BE THE
// BUG THIS WHOLE FEATURE HAS TO AVOID. Since 00104 they are ROWS, editable by
// the club — and they arrive here through `baselines` like any other. A literal
// `finance` option beside the editable Finance row would be two things with one
// name and different answers: picking the option resolves through the hard-coded
// ROLE_DEFAULTS, which is now only the SEED, while picking the row copies what
// the club actually edited it to say. So the built-ins are offered exactly once,
// as rows, and PERMISSION_ROLES keeps them only for reading legacy storage.
//
// `custom` STAYS, because it is not a VP job — it is the empty base, the thing a
// hand-picked set is stored as, and there is no row that could replace it.
//
// A LEGACY ROLE STILL SHOWS IF THE PERSON HAS ONE. 00104 rewrites every such row,
// but a select whose value is absent from its options renders as blank — which
// would read as "no role" on somebody who has one, on the screen where that
// misreading is most expensive. So the person's own stored role is added back if
// it is not otherwise offered, and choosing anything else replaces it for good.
function roleOptions(
  level: AccessLevel,
  baselines: readonly CustomBaseline[],
  storedRole: PermissionRole | null,
) {
  const roles = PERMISSION_ROLES.filter(
    (role) => !isBuiltinPermissionRole(role) || role === storedRole,
  );
  return [
    { value: LEVEL_DEFAULT_OPTION, label: LEVEL_ACCESS_LABELS[level] },
    ...roles.map((role) => ({
      value: role,
      label: isBuiltinPermissionRole(role)
        ? `${PERMISSION_ROLE_LABELS[role]} (old)`
        : PERMISSION_ROLE_LABELS[role],
    })),
    // THE CLUB'S OWN BASELINES AND THE FOUR BUILT-INS, in the order the manager
    // lists them.
    ...baselines.map((baseline) => ({
      value: `${BASELINE_PREFIX}${baseline.id}`,
      label: baselineLabel(baseline),
    })),
  ];
}

// A built-in is not prefixed "Baseline —": to the person picking it, Finance is
// still Finance, and the fact that it is now a row rather than a constant is not
// something the picker should make them think about.
//
// ITS OWN FUNCTION because the console-access control offers the same list under
// a different VALUE: a bare id going to setConsoleAccess, rather than a prefixed
// one going to changeRole. Two lists of the same baselines labelled two ways on
// the same screen is a difference nobody chose.
function baselineLabel(baseline: CustomBaseline): string {
  return baseline.builtinRole !== null ? baseline.name : `Baseline — ${baseline.name}`;
}

const CONFIRM_PHRASE = 'HAND OUT PERMISSIONS';

// The shared name-and-email matching, the same one the roster and the pickers
// use. An admin who learns that typing "chen" finds Chen on /players should not
// have to relearn it here.
function search(people: PersonRow[], query: string): PersonRow[] {
  if (query.trim() === '') return people;
  return filterPlayerOptions(people.map((p) => ({ ...p, meta: p.email })), query);
}

/** 11px/700 uppercase — the console's one micro-label, used for every field name here. */
const MICRO = 'text-[11px] font-bold uppercase tracking-[0.12em]';

type FilterMode = 'all' | 'granted' | 'changed';

const MODES: readonly { value: FilterMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'granted', label: 'Granted' },
  { value: 'changed', label: 'Changed' },
];

/**
 * A row of hairline-joined buttons where exactly one is filled.
 *
 * Not a Tabs and not a Switch: the tri-state below has three answers and no
 * "current view", and the filter above it has three that are peers. Both are one
 * question with one answer, which is what makes them the same control.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; activeClass?: string; disabled?: boolean }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex flex-shrink-0 border border-[var(--line)]', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              MICRO,
              'px-2.5 min-h-[36px] border-l border-[var(--line)] first:border-l-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              active
                ? option.activeClass ?? 'bg-[var(--surface-3)] text-[var(--ink)]'
                : 'text-[var(--mute)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function PermissionEditor({
  holders,
  others,
  viewerId,
  viewerIsAdmin,
  viewerCanGrantConsole,
  viewerCapabilities,
  baselines,
  solo = false,
  viewerCanComposeCapabilities = true,
}: {
  holders: PersonRow[];
  others: PersonRow[];
  viewerId: string;
  /**
   * ADMIN BY LEVEL, and now used for one thing only: whether "Admin" is on the
   * console-access menu. Making somebody an admin is the act no capability
   * reaches, so the option is not drawn for anybody else and setConsoleAccess
   * refuses it again from the actor's own row.
   */
  viewerIsAdmin: boolean;
  /**
   * Holds `players.consoleaccess.write`, or is an admin — the question that used
   * to be spelled `viewerIsAdmin` everywhere on this screen. It decides whether
   * the console-access control is drawn at all and whether members WITHOUT a
   * level are searchable, which are the two halves of "may hand out the
   * console". Not the boundary: setConsoleAccess resolves the same answer from
   * the actor's own row.
   */
  viewerCanGrantConsole: boolean;
  viewerCapabilities: Capability[];
  /** The club's own baselines, offered beside the four VP jobs. */
  baselines: CustomBaseline[];
  /**
   * ONE PERSON, NO RAIL: this editor embedded on that person's own detail page.
   * `holders` carries exactly that one row and `others` is empty, so there is
   * nobody to pick and nothing to search — the pane IS the panel.
   */
  solo?: boolean;
  /**
   * Whether the viewer holds `permissions.write`. Default `true` so /permissions
   * passes nothing: that route is gated on `permissions.page`, and therefore on
   * the write, so the question could not arise there.
   *
   * NEEDED AS AN EXPLICIT PROP rather than read off `viewerCapabilities`,
   * because localRefusal (lib/permission-batch.ts) mirrors setPlayerPermissions'
   * five checks and NOT the actor's own `permissions.write` — so the queue
   * validator cannot be relied on to hide a Save the server always refuses.
   */
  viewerCanComposeCapabilities?: boolean;
}) {
  // WHO THE RAIL HAS PICKED, which in solo mode is nobody and never will be.
  // Read through `selectedId` below rather than directly — see the derivation
  // under the state block, which is what makes solo mode work at all.
  const [pickedId, setPickedId] = useState<string | null>(null);
  // EVERY PERSON'S PENDING TRIPLE, KEYED BY ID, and this is the whole of the
  // change. It used to be three pieces of state describing whoever was selected,
  // so picking somebody else silently threw the work away — the club owner wants
  // to queue changes across several people and save them together, and a queue
  // that empties when you look at the next person is not one.
  //
  // A KEY EXISTS ONLY FOR SOMEBODY WHO HAS BEEN TOUCHED. See PendingEdits: a
  // draft seeded for everybody would mark anyone carrying a stored capability
  // this build no longer knows as having a queued change nobody made.
  const [pending, setPending] = useState<PendingEdits>({});
  const [capabilitySearch, setCapabilitySearch] = useState('');
  const [mode, setMode] = useState<FilterMode>('all');
  const [memberSearch, setMemberSearch] = useState('');
  // SEEDED IN THE INITIALISER FOR SOLO, because select() — the rail button's
  // handler, and the only other place this is ever seeded — never runs when
  // there is no rail. Left at 'none' otherwise, exactly as before: on
  // /permissions nobody is selected yet, so there is no level to read.
  const [access, setAccess] = useState<ExecRole>(() =>
    accessForLevel(solo ? (holders[0]?.level ?? null) : null),
  );
  const [accessReason, setAccessReason] = useState('');
  /**
   * THE JOB TO APPLY IN THE SAME ACT AS THE LEVEL, as a raw baseline id, with ''
   * for "no baseline for now". Not prefixed like the "Starts from" select's
   * values: this one is a parameter of setConsoleAccess rather than something
   * changeRole has to tell apart from a role name.
   *
   * DELIBERATELY NOT IN THE PENDING QUEUE. The queue is capability edits, saved
   * together under one reason; a console level is saved on its own the moment
   * Apply is pressed, and the baseline is now part of that one act rather than a
   * fifth thing to remember on the way to the Save bar.
   */
  const [accessBaseline, setAccessBaseline] = useState<string>('');
  /**
   * ONE REASON FOR THE WHOLE QUEUE, and it belongs beside the Save button
   * rather than on each person. A batch is one decision an officer made — "the
   * new socials team starts this week" — and asking for it five times would get
   * the same five words typed five times, or four of them abbreviated to "as
   * above". Every person's audit row is written with this text.
   */
  const [batchReason, setBatchReason] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  // The capability awaiting a typed confirmation, and what has been typed.
  const [dangerous, setDangerous] = useState<Capability | null>(null);
  const [typed, setTyped] = useState('');
  const [saving, startSaving] = useTransition();
  const [savingAccess, startSavingAccess] = useTransition();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  // THE SELECTION IS DERIVED, NOT STORED, AND THAT IS THE WHOLE OF SOLO MODE.
  // Do not "simplify" this back into one piece of state.
  //
  // In solo there is exactly one person and they are always the one on screen,
  // so the id comes from the row rather than from a click that never happens.
  // The trick is what that does to the two `setPickedId(null)` calls — the end of
  // save() and the end of applyAccess(), both of which drop the selection because
  // on /permissions the person has just moved between the two lists. Here there
  // is no list to move between and the panel must stay where it is, so writing
  // `pickedId` leaves the derived answer untouched and both calls become harmless
  // no-ops. Storing the solo id instead would mean either blanking the panel or
  // teaching both call sites about a mode they have no other reason to know.
  const soloPerson = solo ? (holders[0] ?? null) : null;
  const selectedId = soloPerson ? soloPerson.id : pickedId;

  const held = useMemo(() => new Set(viewerCapabilities), [viewerCapabilities]);
  const baselineNames = useMemo(
    () => new Map(baselines.map((baseline) => [baseline.id, baseline.name])),
    [baselines],
  );
  // WHICH BASELINES THIS VIEWER COULD HAND OVER: closure, shown as a shorter list
  // rather than as a failed Apply, the same way the baseline manager shows it as a
  // missing Edit button.
  //
  // THIS IS THE FOURTH TRANSCRIPTION OF THAT RULE (baseline-manager.tsx,
  // lib/permission-batch.ts and lib/console-access-offer.ts are the others) and it
  // is deliberate: the client is never the boundary, so these are four places that
  // refuse EARLY and none of them is the refusal. The real check is checks 1 to 5
  // of setPlayerPermissions in lib/actions/permissions.ts, against the actor's set
  // resolved from their own row, which is the only copy that can be relied on.
  const offerableBaselines = useMemo(
    () =>
      baselines.filter((baseline) =>
        baseline.capabilities.every((capability) => held.has(capability)),
      ),
    [baselines, held],
  );
  const everyone = useMemo(() => [...holders, ...others], [holders, others]);
  const selected = everyone.find((p) => p.id === selectedId) ?? null;
  const selectedLevel = selected?.level ?? null;

  // THE QUEUE, RESOLVED. Everybody with something pending, what each edit would
  // do to them, and the totals the save bar reports — over EVERYONE, not over
  // whoever happens to be selected.
  const entries = useMemo(() => pendingEntries(everyone, pending), [everyone, pending]);
  const queuedIds = useMemo(() => new Set(entries.map((e) => e.person.id)), [entries]);
  const queuedChanges = totalChanges(entries);

  const seededRole = selected && isRole(selected.role) ? selected.role : null;

  // THE SELECTED PERSON'S TRIPLE — their queued edit if they have one, otherwise
  // their row as it stands. Derived rather than stored, which is what lets the
  // queue survive the selection moving: everything below goes on reading `role`,
  // `grants` and `revokes` exactly as it did when they were three useStates.
  const draft: Draft = selected
    ? (pending[selected.id] ?? draftOf(selected))
    : { role: null, grants: [], revokes: [], baselineId: null };
  const { role, grants, revokes } = draft;
  const baselineId = draft.baselineId ?? null;
  const fromBaseline = baselines.find((b) => b.id === baselineId) ?? null;

  /** Queue a change for the selected person. The one write into `pending`. */
  function setDraft(next: Draft) {
    if (!selected) return;
    setPending((prev) => ({ ...prev, [selected.id]: next }));
  }

  // WHAT THEY HOLD RIGHT NOW, from the row as it is STORED. Computed before
  // anything else needs it because two things read it: the warning about what
  // saving would take away, and the check below on whether this row may be
  // edited at all.
  const before = effectiveCapabilities(
    selectedLevel,
    resolvePermissions(selectedLevel, seededRole, selected?.grants ?? [], selected?.revokes ?? []),
  );

  // Every reason this person's permissions cannot be edited, in the order they
  // should be read. Composed rather than collapsed into one boolean so the
  // panel can SAY which one applies — "read-only" with no reason is the state
  // that generates support conversations.
  const readOnlyReason =
    selected === null
      ? null
      : selected.id === viewerId
        ? 'This is you. A permissions screen where the row you are editing might be your own is where misreadings live — ask another admin to change yours.'
        : selected.level === 'admin'
          ? 'Admins are superusers by level. They hold every capability and nothing stored here is consulted for them — a role on this row would look like a narrowing and would not be one. Make them an executive first.'
          : // GRANT CLOSURE, SHOWN AS A LOCKED ROW RATHER THAN AS A FAILED SAVE.
            // setPlayerPermissions refuses any edit to somebody holding a
            // capability the actor does not (check 3), so this is the same
            // answer arriving earlier. It also carries weight now that the tree
            // is live for a person on their level default: the first click there
            // seeds their WHOLE effective set as grants, and the seed cannot be
            // filtered down to what the actor holds — filtering it would turn a
            // grant into a silent revoke of everything else. Locking the row is
            // what makes the unfiltered seed safe.
            [...before].some((capability) => !held.has(capability))
            ? 'They already hold capabilities you do not, so you cannot change their permissions. Ask an admin.'
            : null;
  // WHETHER THIS VIEWER MAY HAND-PICK CAPABILITIES AT ALL, as opposed to whether
  // this ROW may be composed. The two are different questions and only the
  // second one has a reason to state — a viewer who reached this panel from a
  // member's detail page on `players.consoleaccess.write` alone is not being
  // refused anything, they simply never had the capability the tree writes.
  const canCompose = viewerCanComposeCapabilities;
  // ONE CONJUNCTION, AND IT CASCADES TO THE WHOLE TREE. Verified rather than
  // assumed: `composable` is what disables every segment, hides the "Starts
  // from" select and the Reads/All/None buttons, hides the losing band and the
  // orphan-revokes box, and gates the tree itself. So with it false nothing can
  // reach `pending` — which means no save bar, and no beforeunload or click
  // interceptor armed either, since both key off `entries.length`.
  //
  // readOnlyReason and the read-only "Everything they hold" panel stay visible on
  // purpose: somebody who may only set a console level still needs to see what
  // the level they are setting comes with.
  const composable =
    selected !== null && selectedLevel !== null && readOnlyReason === null && canCompose;

  // PICKING SOMEBODY RESETS THE VIEW AND NOTHING ELSE. The filter, the mode and
  // the open areas describe how this pane is being LOOKED at and belong to the
  // person being looked at; the console-access control is a level, saved on its
  // own, and a reason typed for one person must not follow the admin to the
  // next. Their pending permission edit is deliberately not touched — that is
  // the whole point of the queue.
  function select(person: PersonRow) {
    setPickedId(person.id);
    setAccess(accessForLevel(person.level));
    setAccessReason('');
    setAccessBaseline('');
    setCapabilitySearch('');
    setMode('all');
    setExpanded([]);
  }

  // WHAT SITS UNDER THE TICKS. Not `ROLE_DEFAULTS[role]`: a named job's defaults
  // are what the job ADDS, and underneath them every officer stands on their
  // level's floor. `custom`'s defaults are empty, so reading the base off the
  // role alone answered "no" for every capability a hand-picked officer holds by
  // being an exec — which drew those rows Off while the summary two inches away
  // listed them as held, and left the Off segment unable to store the revoke
  // that would actually close the section.
  //
  // `UNRESTRICTED` is the floor by definition: it is the permissions value of
  // somebody with nothing stored, so resolving it gives exactly what the level
  // hands out before any role, grant or revoke. Reading it through
  // effectiveCapabilities rather than off a list of our own is the same rule the
  // rest of this component follows — one resolver, so the screen cannot drift
  // from the gates.
  const inheritedBase: ReadonlySet<Capability> = useMemo(
    () =>
      new Set<Capability>([
        ...(selectedLevel === null ? [] : effectiveCapabilities(selectedLevel, UNRESTRICTED)),
        ...(role === null ? [] : ROLE_DEFAULTS[role]),
      ]),
    [selectedLevel, role],
  );

  // The panel that answers the question the stored row no longer answers by
  // itself. Computed by the SAME effectiveCapabilities the gates call, on the
  // SAME resolver — not by a second reading of the ticks on screen, which is
  // how an editor comes to show one thing while the console does another.
  const permissions = resolvePermissions(selectedLevel, role, grants, revokes);
  const effective = effectiveCapabilities(selectedLevel, permissions);

  function stateOf(capability: Capability): CellState {
    // Nothing is stored, so nothing can be a grant or a revoke: what they hold,
    // they hold because of their level. Reading it off `effective` rather than
    // off a baseline list of its own is what makes the tree and the summary
    // above it agree by construction — they are the same set.
    if (role === null) return effective.has(capability) ? 'level' : 'off';
    if (grants.includes(capability)) return 'granted';
    if (revokes.includes(capability)) return 'revoked';
    return inheritedBase.has(capability) ? 'role' : 'off';
  }

  // WHICH SEGMENT IS FILLED. `off` means the same thing on every row now:
  // nothing stored, and nothing underneath gives it. A hand-picked set used to
  // be special-cased to fill Off instead of Inherit, on the premise that there
  // was no base under it to inherit FROM. The level floor is that base, so the
  // premise is gone and so is the branch.
  const segmentOf = (state: CellState): Segment => SEGMENT_OF[state];

  // WHAT INHERITING WOULD GIVE THEM — the answer the `Inherit` segment stands
  // for, said out loud beside it. The level floor plus whatever the job adds,
  // which off a level default is just the floor.
  const inherits = (capability: Capability) => inheritedBase.has(capability);

  // DIFFERS FROM SAVED, measured in what the person can DO rather than in what
  // the row stores. Switching somebody from their level default to a hand-picked
  // set of exactly the same capabilities changes the row and changes nothing
  // about them, and marking sixty rows amber for it would bury the one row that
  // did move.
  const changed = (capability: Capability) => before.has(capability) !== effective.has(capability);

  /**
   * The triple as it would have to be STORED for the ticks on screen to survive
   * a save — which, for somebody on their level default, means turning that
   * default into a hand-picked set first.
   *
   * SEEDED FROM THE RESOLVED EFFECTIVE SET, and getting that backwards is the
   * one way this feature could hurt somebody. A varsity trainer who ticks one
   * extra capability must end up with their three plus that one; seeding from
   * empty would end them up with one, turning a grant into a near-total revoke.
   * That is the same hazard the resolver's "no role but a grant" rule exists to
   * prevent, arriving from the editor instead. The `.page` keys come along for
   * free precisely because the seed is the resolved set — it already satisfies
   * the resolver's own invariant, so nothing it keeps is pruned on the way back.
   *
   * The base is `custom`, whose defaults are empty, so every capability lands in
   * `grants` and the stored row reads back as exactly what was chosen. Borrowing
   * one of the four VP names instead would file the person under a job they do
   * not have and put them inside the blast radius of any later change to what
   * that job means.
   */
  // A draft that definitely has a role — what every cell click writes through.
  type Composed = Draft & { role: PermissionRole; baselineId: string | null };

  function seedCustom(): Composed {
    return { role: 'custom', grants: [...effective], revokes: [], baselineId: null };
  }

  function asCustom(): Composed {
    if (role !== null) return { role, grants, revokes, baselineId };
    return seedCustom();
  }

  // ONE CLICK WRITES EXACTLY ONE DELTA ELEMENT, and only the one the chosen
  // segment needs. `inherit` clears both lists; `on` stores a grant ONLY where
  // the base does not already give it; `off` stores a revoke ONLY where it does.
  // That is what stops a redundant grant ever being stored — the same rule the
  // old two-state cell enforced by having nowhere else to go, said explicitly
  // now that there are three places to go.
  //
  // On a level default the click ALSO performs the switch to a hand-picked set,
  // so the first segment pressed does what the person pressing it expects
  // instead of nothing. That was the club owner's report — "i cant edit varsity
  // trainer?" — and it was fair: the cells were inert until a role was picked,
  // with nothing on screen saying that picking one was the way in.
  function setCell(capability: Capability, target: Segment) {
    const next = asCustom();
    // The floor counts as base here for the same reason it counts in stateOf:
    // pressing Off on a section an exec holds by level has to STORE the revoke,
    // or the control does nothing. The resolver applies revokes after the floor
    // and cascades the area shut, so this is the delta it already expects — the
    // editor was simply never able to express it.
    const inBase = inheritedBase.has(capability);
    const nextGrants = next.grants.filter((c) => c !== capability);
    const nextRevokes = next.revokes.filter((c) => c !== capability);
    if (target === 'on' && !inBase) nextGrants.push(capability);
    if (target === 'off' && inBase) nextRevokes.push(capability);
    // THE BASELINE LABEL GOES THE MOMENT A CELL MOVES, and every capability
    // stays. A row that said "Socials VP" while holding Socials VP plus one
    // would be re-copied over by the next edit to that baseline — a tick taken
    // away by somebody else's change to something else. setPlayerPermissions
    // clears it server-side for the same reason; this is what makes the screen
    // agree with the write.
    setDraft({ role: next.role, grants: nextGrants, revokes: nextRevokes, baselineId: null });
  }

  function onCellClick(capability: Capability, target: Segment) {
    // The one capability that can replicate itself. A segment is the wrong
    // weight of control for "this person can hand out anything they hold,
    // including this", so turning it ON costs a typed phrase; every other move
    // stays one click, because taking access away is the safe direction — and so
    // is putting back something a revoke had taken off a role that still gives
    // it, which is why the test is the cell's state and not its effect.
    if (capability === 'permissions.write' && target === 'on' && stateOf(capability) === 'off') {
      setDangerous(capability);
      setTyped('');
      return;
    }
    setCell(capability, target);
  }

  async function changeRole(value: string) {
    if (value === LEVEL_DEFAULT_OPTION) {
      const ok = await confirm({
        title: selectedLevel ? `Back to ${LEVEL_ACCESS_LABELS[selectedLevel].toLowerCase()}?` : 'Back to their level’s access?',
        message: (
          <>
            <span className="text-[var(--text-primary)] font-medium">{selected?.name}</span> will
            get {selectedLevel ? BASELINE_PHRASE[selectedLevel] : 'their level’s access'} again.
            Both the grants and the revokes below are cleared.
          </>
        ),
        confirmLabel: selectedLevel ? `Use ${LEVEL_ACCESS_LABELS[selectedLevel].toLowerCase()}` : 'Use their level’s access',
      });
      if (!ok) return;
      setDraft({ role: null, grants: [], revokes: [], baselineId: null });
      return;
    }

    // A CUSTOM BASELINE IS COPIED IN, not pointed at. What lands in the draft is
    // the baseline's own capabilities as a hand-picked set — which is exactly
    // what will be stored — plus the label saying where they came from, so this
    // person follows the baseline the next time it is edited.
    //
    // No confirmation, unlike going back to a level default: the tree below
    // redraws to show precisely what they would hold, `losing` names anything it
    // takes away, and nothing is written until Save.
    if (value.startsWith(BASELINE_PREFIX)) {
      const id = value.slice(BASELINE_PREFIX.length);
      const baseline = baselines.find((b) => b.id === id);
      if (!baseline) return;
      setDraft({
        role: 'custom',
        grants: [...baseline.capabilities],
        revokes: [],
        baselineId: baseline.id,
      });
      return;
    }
    // Choosing Hand-picked explicitly is the same act the first segment press
    // performs, so it starts from the same place: what they hold today. From a
    // NAMED role as much as from a level default — the base is about to become
    // empty, so without the seed "convert this to a hand-picked set" would
    // silently take away everything the role was giving them.
    if (value === 'custom') {
      setDraft(seedCustom());
      return;
    }
    // A named VP job, whose defaults live in code. The label goes with the
    // move — the grants are about to sit on top of a base the baseline knows
    // nothing about, so it would be describing part of the set.
    setDraft({ role: value as PermissionRole, grants, revokes, baselineId: null });
  }

  // WHAT PRESSING SAVE WOULD TAKE AWAY, worked out from the row as it is
  // STORED — the same resolver, run a second time on the values this screen was
  // seeded with (see `before` above).
  //
  // A role REPLACES the base rather than adding to it, so the first NAMED role
  // picked for somebody on their level default drops their whole baseline. On an
  // exec that is the point of the feature and the confirmation above says so.
  // On a trainer it is a surprise: giving them Tournaments so they can run a
  // session also takes away varsity notes, which is the one thing their level
  // existed to give them. The semantics are correct and deliberately not
  // special-cased in the resolver — a trainer whose baseline survived
  // composition would give the level ladder a second meaning — so the editor is
  // where it has to be visible, and visible BEFORE the save rather than after.
  //
  // Against the STORED row, not against the level's baseline: the question is
  // what this EDIT removes. An exec who was narrowed to Finance months ago
  // should see the delta they are making now, not the fifty-odd capabilities
  // somebody else took away then. It keeps working across the switch to Custom
  // for the same reason — the seed changes what is on screen, never what is
  // stored, so the comparison still has both sides.
  //
  // Only the losses are computed here. What an edit ADDS is a per-person figure
  // the save bar reports for everybody at once, so it is read off the queue
  // (see `entries`) rather than worked out a second time for whoever is on
  // screen.
  const losing = [...before].filter((capability) => !effective.has(capability));

  // A revoke is orphaned when nothing underneath it is giving the capability
  // away — so it is measured against the floor as well as the job. Revoking a
  // section an exec holds by level is the whole point of the Off segment and
  // must not be reported as a leftover.
  const orphanRevokes = revokes.filter((capability) => !inheritedBase.has(capability));

  const query = capabilitySearch.trim().toLowerCase();
  // A search or a mode OPENS everything it matched. Making somebody expand three
  // tiers to find the row they just filtered for is the same as not having a
  // filter — so while either is active the expand/collapse toggle has nothing
  // left to do, and is disabled rather than left looking broken.
  const filtering = query !== '' || mode !== 'all';
  const matches = (leaf: Leaf) =>
    (query === '' ||
      leaf.label.toLowerCase().includes(query) ||
      leaf.capability.includes(query)) &&
    (mode === 'all' ||
      (mode === 'granted' ? effective.has(leaf.capability) : changed(leaf.capability)));

  function allLeaves(node: Node): Leaf[] {
    return [
      ...(node.page ? [node.page] : []),
      ...node.leaves,
      ...node.children.flatMap(allLeaves),
    ];
  }

  function visibleLeaves(node: Node): Leaf[] {
    return allLeaves(node).filter(matches);
  }

  const shownLeaves = TREE.reduce((total, area) => total + visibleLeaves(area).length, 0);

  function isOpen(node: Node): boolean {
    return filtering || expanded.includes(node.key);
  }

  function toggleOpen(key: string) {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  const allExpanded = ALL_KEYS.every((key) => expanded.includes(key));

  // "Turn on everything here" is a BUTTON, never the header itself. A header
  // that toggled would need an aggregate state — half on, half off — and an
  // aggregate state is a thing a person can misread. These write the individual
  // leaves, one delta element each, exactly as pressing their segments would,
  // and they perform the same switch to a hand-picked set that a press does.
  //
  // "Reads" means everything that is not a WRITE, so the page comes with them.
  // A set of reads without the area's page is a set the resolver deletes on the
  // way in, and a button that silently produced one would be a button that does
  // nothing.
  function setAll(node: Node, on: boolean, readsOnly: boolean) {
    const next = asCustom();
    const roleBase = ROLE_DEFAULTS[next.role] as readonly Capability[];
    const nextGrants = new Set(next.grants);
    const nextRevokes = new Set(next.revokes);
    const leaves = allLeaves(node)
      .filter((l) => (readsOnly ? l.mode !== 'write' : true))
      .filter((l) => held.has(l.capability))
      .filter((l) => l.capability !== 'permissions.write');
    for (const leaf of leaves) {
      if (roleBase.includes(leaf.capability)) {
        if (on) nextRevokes.delete(leaf.capability);
        else nextRevokes.add(leaf.capability);
      } else if (on) {
        nextGrants.add(leaf.capability);
      } else {
        nextGrants.delete(leaf.capability);
      }
    }
    // Same rule as a single cell: the set is no longer what the baseline says.
    setDraft({ role: next.role, grants: [...nextGrants], revokes: [...nextRevokes], baselineId: null });
  }

  /** "Alice — you do not hold players.page", for a refusal or a failure. */
  const blame = (results: readonly { id: string; error: string }[]) =>
    results
      .map(({ id, error }) => `${everyone.find((p) => p.id === id)?.name ?? id} — ${error}`)
      .join('; ');

  /**
   * SAVE THE WHOLE QUEUE, one person at a time.
   *
   * VALIDATED IN FULL BEFORE ANYTHING IS WRITTEN. Every refusal
   * setPlayerPermissions would give is checked here first, for everybody, and a
   * single one of them stops the batch dead — a half-applied batch leaves the
   * admin not knowing what landed, which on this screen is the entire question.
   * That is the same all-or-nothing promise the single-person save has always
   * made, held one level up. It is a courtesy and not the boundary: the server
   * resolves the actor's own set from the actor's own row and runs all five
   * checks again on every call.
   *
   * IT IS STILL N CALLS AND NOT A TRANSACTION, and this does not pretend
   * otherwise. Each call writes its own audit row naming its own target — the
   * log's whole value — and revalidates, and if the third of five is refused by
   * the server despite passing above, the first two are already written. So the
   * rest are attempted, the toast says exactly which landed and which did not,
   * and the failures stay queued so they can be looked at and retried.
   */
  function save() {
    const queued = entries;
    if (queued.length === 0) return;
    // The Save button is disabled without one, so this is the stale-tab case
    // rather than the ordinary one. Refused here as well as on the server so
    // that a batch of five does not write its first person and then stop.
    const why = batchReason.trim();
    if (why.length < REASON_MIN) {
      toast(`Say why this is changing — at least ${REASON_MIN} characters.`, 'error');
      return;
    }
    startSaving(async () => {
      const result = await saveBatch(
        queued.map((entry) => ({ ...entry, id: entry.person.id })),
        {
          validate: (entry) => localRefusal(entry.person, entry.draft, { id: viewerId, held }),
          write: async (entry) => {
            try {
              // THE SAME REASON ON EVERY PERSON'S ROW. saveBatch is N calls and
              // each writes its own audit row against its own target, which is
              // where "why did my access change" is looked up — so the text
              // typed once has to travel with each of them.
              const res = await setPlayerPermissions(entry.person.id, {
                ...entry.draft,
                reason: why,
              });
              return res.ok ? { ok: true } : { ok: false, error: res.error };
            } catch (err) {
              return {
                ok: false,
                error: err instanceof Error ? err.message : 'Failed to save permissions',
              };
            }
          },
        },
      );

      if (result.refused.length > 0) {
        toast(`Nothing was saved. ${blame(result.refused)}`, 'error');
        return;
      }

      // DROPPED ONLY IF IT IS STILL THE DRAFT THAT WAS SUBMITTED. A batch of
      // five is five round trips, the tree stays live throughout, and an admin
      // who touches a cell while that person's write is in flight must not have
      // the click swallowed by the save that started before it. setDraft always
      // allocates, so reference identity is an exact test for "untouched since
      // this was submitted" — anything else stays queued and shows its marker.
      setPending((prev) => {
        const next = { ...prev };
        for (const id of result.saved) {
          const submitted = queued.find((entry) => entry.person.id === id)?.draft;
          if (next[id] === submitted) delete next[id];
        }
        return next;
      });
      router.refresh();

      if (result.failed.length > 0) {
        toast(
          `${result.saved.length} of ${queued.length} saved. Still pending: ${blame(result.failed)}`,
          'error',
        );
        return;
      }

      // ONE PERSON READS EXACTLY AS IT ALWAYS DID. The single-person flow is the
      // common one and nothing about it should feel like it grew a batch.
      const single = queued.length === 1 ? queued[0] : null;
      toast(
        single
          ? single.draft.role === null
            ? `${single.person.name} is back to ${single.person.level ? LEVEL_ACCESS_LABELS[single.person.level].toLowerCase() : 'their level’s access'}`
            : `${single.person.name} now holds ${draftSet(single.person, single.draft).size} of ${CAPABILITIES.length} capabilities`
          : `${queued.length} people updated`,
        'success',
      );
      // Only once the whole queue landed. A partial save leaves people still
      // pending, and clearing the box would make the admin retype the reason
      // they already gave for the very same act.
      setBatchReason('');
      setPickedId(null);
    });
  }

  /**
   * DISCARD THE WHOLE QUEUE — every person, not just the one on screen.
   *
   * Confirmed once more than one person is affected. Losing one person's pending
   * edit to a misplaced click is recoverable in a minute; losing four people's is
   * an evening. One person keeps the old behaviour, which was a plain button.
   */
  async function resetAll() {
    if (entries.length > 1) {
      const ok = await confirm({
        title: `Discard the changes to ${entries.length} people?`,
        message: (
          <>
            Everything queued for{' '}
            <span className="text-[var(--text-primary)] font-medium">
              {entries.map((entry) => entry.person.name).join(', ')}
            </span>{' '}
            is thrown away. Nothing has been saved yet, so there is nothing to undo afterwards.
          </>
        ),
        confirmLabel: 'Discard them all',
        danger: true,
      });
      if (!ok) return;
    }
    setPending({});
    // The reason described the queue, and the queue is gone.
    setBatchReason('');
  }

  // LEAVING WITH A QUEUE STILL IN IT. Two cases and two mechanisms: the browser
  // owns reload and close, so `beforeunload` is the only thing that can speak
  // there and it speaks in the browser's own words; in-app links are ours, so
  // they get the console's own confirmation. Back and forward are NOT covered —
  // App Router gives no way to hold a popstate open while a dialog resolves, and
  // a guard that fired for three of the four ways out would be worse than one
  // that says which it covers.
  useEffect(() => {
    if (entries.length === 0) return;
    // Both, and the second is not redundant: preventDefault() is the current
    // spec and what Chrome and current Safari read, and returnValue is what
    // older Safari reads. Either alone is a guard that silently does nothing on
    // half the phones in the club.
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [entries.length]);

  useEffect(() => {
    if (entries.length === 0) return;
    const people = entries.length;
    const intercept = (event: MouseEvent) => {
      // A modified click opens a tab and leaves this one alone, so there is
      // nothing to lose and nothing to ask about.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target !== '' && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      // Read before preventing: the anchor may be gone by the time the dialog
      // resolves, and a href resolved afterwards would be a href of nothing.
      const href = `${url.pathname}${url.search}`;
      event.preventDefault();
      event.stopPropagation();
      void confirm({
        title: 'Leave without saving?',
        message: `Changes to ${people} ${people === 1 ? 'person are' : 'people are'} queued and have not been saved. Leaving throws them away.`,
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay here',
        danger: true,
      }).then((ok) => {
        if (ok) router.push(href);
      });
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [entries.length, confirm, router]);

  // GIVING SOMEBODY THE CONSOLE, OR TAKING IT AWAY. The selection is dropped on
  // success rather than kept: the person moves between the two lists, their
  // stored composition may have been cleared on the way, and a panel still
  // showing what was seeded from the old row would be describing a row that no
  // longer exists.
  //
  // THEIR QUEUED EDIT GOES WITH IT, for the same reason and with more force now
  // that it would have outlived the selection. setConsoleAccess clears the
  // stored triple on most moves, so a draft seeded from the old row no longer
  // describes anything — and it was seeded from what they USED to hold, so
  // saving it afterwards would read as a large grant nobody chose.
  function applyAccess() {
    if (!selected) return;
    startSavingAccess(async () => {
      try {
        // A STALE ID IS SENT AS NOTHING. The picker is only drawn at the two live
        // levels, but choosing a baseline and then switching the level back to
        // `none` leaves the id in state, and that pair is refused server-side with
        // a sentence about a control this admin can no longer see.
        const sendBaseline =
          accessBaseline !== '' && (access === 'executive' || access === 'trainer')
            ? accessBaseline
            : null;
        const res = await setConsoleAccess(selected.id, access, accessReason, sendBaseline);
        if (!res.ok) { toast(res.error, 'error'); return; }
        const appliedBaseline = sendBaseline === null ? null : baselineNames.get(sendBaseline);
        toast(
          access === 'none'
            ? `${selected.name} no longer has console access`
            : `${selected.name} — ${EXEC_ROLE_OPTIONS.find((o) => o.value === access)?.label}${appliedBaseline ? ` · ${appliedBaseline}` : ''}`,
          'success',
        );
        setPending((prev) => dropPending(prev, [selected.id]));
        setPickedId(null);
        // THE REASON DESCRIBED A MOVE THAT HAS NOW HAPPENED. A no-op on
        // /permissions, which drops the selection and re-seeds through select();
        // in solo the panel stays put, so without this the box would still hold
        // the text typed for the change that just landed.
        setAccessReason('');
        // The same argument, and with more force: the job has been applied, so a
        // picker still naming it would invite applying it twice.
        setAccessBaseline('');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to change console access', 'error');
      }
    });
  }

  const segments = (leaf: Leaf, state: CellState) => (
    <Segmented
      label={leaf.label}
      value={segmentOf(state)}
      options={SEGMENTS}
      disabled={!composable || !held.has(leaf.capability)}
      onChange={(target) => onCellClick(leaf.capability, target)}
    />
  );

  const cell = (leaf: Leaf, dimmed: boolean) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const isDangerous = leaf.capability === 'permissions.write';
    const badge = SCOPE_BADGE[leaf.mode];
    return (
      <div
        key={leaf.capability}
        className={cn(
          'group flex items-center justify-between gap-3 py-2 pl-4 pr-3 border-t border-t-[var(--line)] border-l-[3px] transition-opacity',
          changed(leaf.capability) ? 'border-l-[var(--color-warning)]' : 'border-l-transparent',
          dimmed && 'opacity-45',
        )}
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
            {isDangerous && <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 text-[var(--red)]" />}
            {leaf.label}
            {badge && <Badge variant={badge}>{leaf.mode}</Badge>}
            {segmentOf(state) === 'inherit' && (
              <span className="text-[11px] text-[var(--mute)]">
                from {role === null ? 'level' : 'role'} · {inherits(leaf.capability) ? 'on' : 'off'}
              </span>
            )}
          </p>
          {/* THE DOTTED PATH IS THERE WHEN IT IS WANTED AND SILENT WHEN IT IS
              NOT. It is what an engineer greps for and what nobody else needs to
              read 116 times, so it is drawn at zero opacity and always occupies
              its line — fading it in rather than revealing it keeps every row
              the same height as the pointer crosses the list. */}
          <p className="font-mono text-[11px] text-[var(--mute)] opacity-0 transition-opacity duration-150 group-hover:opacity-50 group-focus-within:opacity-50">
            {leaf.capability}
          </p>
          {!mine && (
            <p className="text-[11px] text-[var(--mute)]">You do not hold this.</p>
          )}
        </div>
        {segments(leaf, state)}
      </div>
    );
  };

  // THE PAGE ROW. Its own shape at the top of the area, not a cell in the list
  // below it, because it is not one more thing you can tick: it is the switch
  // the rest of the area hangs off. Everything else here is deleted by the
  // resolver while this is off, and a row that looked like a peer of the data
  // reads would make that look like a bug rather than the rule. It is also the
  // one row never dimmed by the gate below it — the control you need to fix the
  // state cannot be the one faded out.
  const pageCell = (leaf: Leaf) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const on = effective.has(leaf.capability);
    return (
      <div
        className={cn(
          'group flex items-center justify-between gap-3 py-2.5 pl-4 pr-3 border-t border-t-[var(--line)] border-l-[3px] bg-[var(--surface-2)]',
          changed(leaf.capability) ? 'border-l-[var(--color-warning)]' : 'border-l-transparent',
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--ink)]">{leaf.label}</p>
          <p className="text-[11px] text-[var(--mute)]">
            {on
              ? 'They can open this section. What they see and do inside it is set below.'
              : 'Off — nothing else in this area applies, whatever is set below.'}
          </p>
          <p className="font-mono text-[11px] text-[var(--mute)] opacity-0 transition-opacity duration-150 group-hover:opacity-50 group-focus-within:opacity-50">
            {leaf.capability}
          </p>
          {!mine && <p className="text-[11px] text-[var(--mute)]">You do not hold this.</p>}
        </div>
        {segments(leaf, state)}
      </div>
    );
  };

  const renderNode = (node: Node, depth: number, dimmed: boolean) => {
    if (visibleLeaves(node).length === 0) return null;
    const open = isOpen(node);
    // COUNTED OVER THE WHOLE AREA, never over what the filter left standing. A
    // header that read "2 of 2" because the filter hid the other nine would be
    // the one number on this screen that is not the truth about the person.
    const leaves = allLeaves(node);
    const on = leaves.filter((l) => effective.has(l.capability)).length;
    const areaChanged = leaves.some((l) => changed(l.capability));
    // GATED, NOT BROKEN. The resolver deletes every other key in an area whose
    // page is off, so the rows below are describing something that cannot
    // happen. Dimming them and saying why is the difference between a screen
    // that looks wrong and one that explains itself.
    const gated = node.page !== null && !effective.has(node.page.capability);
    return (
      <div key={node.key} className={cn(depth === 0 && 'border-t border-[var(--line)]')}>
        <div className={cn('flex items-center gap-2 px-3 py-2.5', dimmed && 'opacity-45')}>
          {/* Expands, NEVER toggles. The counts beside it are a read-out. */}
          <button
            type="button"
            onClick={() => toggleOpen(node.key)}
            aria-expanded={open}
            className="flex flex-1 min-w-0 items-center gap-2 min-h-[36px] text-left"
          >
            {open ? (
              <ChevronDown className="w-4 h-4 flex-shrink-0 text-[var(--mute)]" />
            ) : (
              <ChevronRight className="w-4 h-4 flex-shrink-0 text-[var(--mute)]" />
            )}
            <span
              className={cn(
                'font-display font-bold uppercase tracking-[0.02em] truncate',
                depth === 0 ? 'text-[15px] text-[var(--ink)]' : 'text-[13px] text-[var(--ink-2)]',
              )}
            >
              {node.label}
            </span>
            <span
              className={cn(
                'font-mono text-[11px] flex-shrink-0',
                on > 0 ? 'text-[var(--win)]' : 'text-[var(--mute)]',
              )}
            >
              {on} of {leaves.length}
            </span>
            {areaChanged && <Badge variant="warning">changed</Badge>}
          </button>
          {composable && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setAll(node, true, true)}>Reads</Button>
              <Button variant="ghost" size="sm" onClick={() => setAll(node, true, false)}>All</Button>
              <Button variant="ghost" size="sm" onClick={() => setAll(node, false, false)}>None</Button>
            </div>
          )}
        </div>
        {open && (
          <div>
            {node.page && matches(node.page) && pageCell(node.page)}
            {gated && !dimmed && node.page && (
              <div className="flex items-start gap-2 border-t border-[var(--line)] bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] px-4 py-2">
                <AlertTriangle className="mt-px w-3.5 h-3.5 flex-shrink-0 text-[var(--color-warning)]" />
                <p className="text-[11px] text-[var(--color-warning)]">
                  {node.page.label} is off — nothing below applies until it is on
                </p>
              </div>
            )}
            {node.leaves.filter(matches).map((leaf) => cell(leaf, dimmed || gated))}
            {node.children.map((child) => renderNode(child, depth + 1, dimmed || gated))}
          </div>
        )}
      </div>
    );
  };

  /** The badge on a person's row — one word for how their access was arrived at. */
  const personBadge = (person: PersonRow) => {
    if (person.level === null) return <Badge variant="neutral">no access</Badge>;
    // An admin's stored row is never consulted, so "custom" would be a lie
    // whatever is in it.
    if (person.level === 'admin') return <Badge variant="success">all</Badge>;
    const deltas = person.grants.length + person.revokes.length;
    if (deltas > 0) return <Badge variant="warning">{deltas} custom</Badge>;
    return <Badge variant="neutral">role only</Badge>;
  };

  const personRow = (person: PersonRow) => {
    const active = selectedId === person.id;
    // SOMETHING QUEUED FOR THEM, SAID ON THEIR ROW. Once an edit outlives the
    // selection, the rail is the only place it can be seen from — a queued
    // change the admin cannot find is one they will save without meaning to.
    // A dot rather than a second badge: `role only` / `N custom` / `all` already
    // sit at the end of every row and are the answer to a different question, so
    // the marker leads the name instead of competing with them.
    const queued = queuedIds.has(person.id);
    return (
      <button
        key={person.id}
        type="button"
        onClick={() => select(person)}
        aria-current={active}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2.5 text-left border-b border-b-[var(--line)] border-l-[3px] transition-colors',
          active
            ? 'border-l-[var(--red)] bg-[var(--surface-2)]'
            : 'border-l-transparent hover:bg-[var(--surface-2)]',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-display text-[15px] font-bold uppercase tracking-[0.01em] text-[var(--ink)]">
            {queued && (
              <span
                role="img"
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--color-warning)]"
              />
            )}
            <span className="truncate">
              {person.name}
              {person.id === viewerId && <span className="text-[var(--mute)]"> (you)</span>}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--mute)]">
            {describe(person, baselineNames)}
          </span>
        </span>
        {personBadge(person)}
      </button>
    );
  };

  const shownHolders = search(holders, memberSearch);
  // EVERY MEMBER IS HERE; ONLY THE PEOPLE WITH THE CONSOLE ARE LISTED UNPROMPTED.
  // The club is a hundred people and four of them can open this screen, so a
  // list of all of them would bury the answer to the question the page is
  // named after. Searching is what brings the rest in, which is also the act
  // somebody performs when they have a specific person in mind — the only
  // reason to look at an ordinary member here at all.
  const matchedOthers = memberSearch.trim() === '' ? [] : search(others, memberSearch);
  const shownOthers = matchedOthers.slice(0, OTHERS_SHOWN);

  const groupHeading = (text: string) => (
    <p className={cn(MICRO, 'px-3 pt-3 pb-1.5 text-[var(--mute)]')}>{text}</p>
  );

  const note = (text: string) => (
    <p className="px-3 py-3 text-[11px] text-[var(--mute)]">{text}</p>
  );

  // The one queued edit, when there is exactly one. What the save bar reads to
  // decide whether it is describing a person or a batch.
  const only = entries.length === 1 ? entries[0] : null;

  return (
    <>
      {/* TWO PANES ON A LAPTOP, ONE COLUMN ON A PHONE. Below `md` the grid
          collapses and exactly one of the two is drawn: the list until somebody
          is picked, the editor afterwards, with a back control that clears the
          selection. A 296px rail beside a capability tree on a 390px screen
          would be two unusable columns rather than one usable one.

          IN SOLO THE CARD IS NOT A CARD. The host is a `Panel` on the member's
          own detail page and already draws the hairline box, so a second border
          and a second surface inside it would read as a box in a box. The radius
          is left alone on purpose: Card's own `rounded-xl` is the console's card
          corner. */}
      <Card
        padding={false}
        className={cn(
          solo ? 'border-0 bg-transparent' : 'md:grid md:grid-cols-[296px_minmax(0,1fr)]',
        )}
      >
        {!solo && (
        <div
          className={cn(
            'md:sticky md:top-[var(--console-header-h)] md:self-start md:h-[calc(100vh-var(--console-header-h)-20px)] md:flex md:flex-col md:border-r md:border-[var(--line)]',
            selected && 'hidden md:flex',
          )}
        >
          <div className="p-3">
            <SearchFilter
              label="Find a person by name or email"
              placeholder="Find a person"
              value={memberSearch}
              onChange={setMemberSearch}
              resultCount={shownHolders.length + shownOthers.length}
              noun="person"
              nounPlural="people"
            />
          </div>

          <div className="md:flex-1 md:min-h-0 md:overflow-y-auto border-t border-[var(--line)]">
            {shownHolders.length > 0 && (
              <>
                {groupHeading('With console access')}
                {shownHolders.map(personRow)}
              </>
            )}

            {!viewerCanGrantConsole
              ? memberSearch.trim() !== '' &&
                shownHolders.length === 0 &&
                note(`Nobody with console access matches “${memberSearch.trim()}”.`)
              : memberSearch.trim() !== '' && (
                  <>
                    {shownOthers.length > 0 && (
                      <>
                        {groupHeading('No console access')}
                        {shownOthers.map(personRow)}
                      </>
                    )}
                    {matchedOthers.length > shownOthers.length &&
                      note(
                        `${matchedOthers.length - shownOthers.length} more match “${memberSearch.trim()}”. Type a little more to narrow it.`,
                      )}
                    {shownHolders.length === 0 &&
                      matchedOthers.length === 0 &&
                      note(`Nobody matches “${memberSearch.trim()}”.`)}
                  </>
                )}
          </div>

          {/* THE FOOTNOTE IS PERMANENT, and it is where the page's one paragraph
              of explanation lives now that the list is a rail rather than a
              card. It also carries the reason the rail looks short: every member
              of the club is reachable from that search box, and only the people
              who already hold the console are listed without being asked for. */}
          <p className="border-t border-[var(--line)] px-3 py-3 text-[11px] leading-relaxed text-[var(--mute)]">
            {viewerCanGrantConsole
              ? `Console access is the level somebody holds; capabilities are what they may do once they have it. ${others.length} other ${others.length === 1 ? 'member has' : 'members have'} none — search by name or email to bring one in. You can only hand out capabilities you hold yourself, and every change is recorded in the audit log.`
              : 'A role decides what somebody STARTS from; grants and revokes adjust it person by person. Leave a role unset and they keep the full access their level has always had. You can only hand out capabilities you hold yourself, and every change is recorded in the audit log.'}
          </p>
        </div>
        )}

        {/* The `hidden md:block` is the phone half of the two-pane collapse and
            has nothing to hide behind in solo: there is no list to fall back to,
            so an unpicked pane would be an empty panel below `md`. */}
        <div className={cn('min-w-0', !solo && !selected && 'hidden md:block')}>
          {selected === null ? (
            <EmptyState
              title="Nobody picked"
              description="Choose somebody on the left to see what they can do, and to change it."
            />
          ) : (
            <>
              <div className="border-b border-[var(--line)] px-4 py-4">
                {/* Back to a list that does not exist in solo, and the click
                    would not even blank the pane — the selection is derived
                    there. A control that does nothing is worse than no control. */}
                {!solo && (
                <button
                  type="button"
                  onClick={() => setPickedId(null)}
                  className={cn(
                    MICRO,
                    'md:hidden mb-3 inline-flex items-center gap-2 min-h-[36px] text-[var(--mute)] hover:text-[var(--ink)] transition-colors',
                  )}
                >
                  <ArrowLeft className="w-4 h-4" />
                  All people
                </button>
                )}

                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
                  <div className="min-w-0">
                    <h2 className="font-display text-[26px] font-bold uppercase leading-none text-[var(--ink)]">
                      {selected.name}
                    </h2>
                    <p className="mt-1.5 text-[13px] text-[var(--mute)]">
                      {selected.title ? `${selected.title} · ` : ''}
                      {selectedLevel ? LEVEL_LABELS[selectedLevel] : 'No console access'}
                      {selected.email ? ` · ${selected.email}` : ''}
                      {selectedLevel !== null && !selected.canSignIn ? ' · cannot sign in' : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                    {selectedLevel !== null && composable && (
                      <div className="w-[200px]">
                        <Select
                          label="Starts from"
                          options={roleOptions(selectedLevel, baselines, role)}
                          // A baseline holder reads back as their baseline, not
                          // as "Hand-picked": the label is the whole reason the
                          // column exists, and a select that forgot it the
                          // moment the page reloaded would be one.
                          value={
                            fromBaseline
                              ? `${BASELINE_PREFIX}${fromBaseline.id}`
                              : (role ?? LEVEL_DEFAULT_OPTION)
                          }
                          onChange={(e) => void changeRole(e.target.value)}
                        />
                      </div>
                    )}
                    {selectedLevel !== null && (
                      <div>
                        <p className={cn(MICRO, 'text-[var(--mute)]')}>Effective access</p>
                        <p className="mt-1.5 font-mono text-[22px] leading-none text-[var(--ink)]">
                          {effective.size}
                          <span className="text-[var(--mute)]"> of {CAPABILITIES.length}</span>
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {selectedLevel !== null && composable && (
                  <p className="mt-3 text-[11px] leading-relaxed text-[var(--mute)]">
                    {role === null
                      ? `${LEVEL_ACCESS_LABELS[selectedLevel]} — ${BASELINE_PHRASE[selectedLevel]}. Nothing is stored; move anything below off Inherit and they become a hand-picked set starting from exactly this.`
                      : fromBaseline
                        ? `${fromBaseline.name} — ${fromBaseline.capabilities.length} ${fromBaseline.capabilities.length === 1 ? 'capability' : 'capabilities'} copied from the baseline. Editing the baseline changes them with it; changing anything below makes this a hand-picked set of their own and it stops following.`
                        : role === 'custom'
                        ? `Hand-picked — ${grants.length} ${grants.length === 1 ? 'capability' : 'capabilities'} chosen one at a time, starting from no job at all.`
                        : grants.length === 0 && revokes.length === 0
                          ? `${PERMISSION_ROLE_LABELS[role]}, unadjusted.`
                          : `Custom — ${PERMISSION_ROLE_LABELS[role]} with ${grants.length} granted and ${revokes.length} revoked.`}
                  </p>
                )}
              </div>

              <div className="px-4 py-4 space-y-4">
                {/* CONSOLE ACCESS — the half of this page's subtitle it could not
                    answer until now. It is a LEVEL rather than a capability, and
                    handing one out is now itself a capability:
                    `players.consoleaccess.write`, which is in no baseline and is
                    given out by name. The control is not drawn for anybody
                    without it, and setConsoleAccess resolves the same answer from
                    the actor's own row regardless.

                    THE MENU IS NARROWER FOR A NON-ADMIN, and that is the line
                    this whole change keeps: `Admin` is offered only to an admin,
                    because a capability that could mint an admin would make
                    holding it the same thing as being one. The server refuses it
                    too — this only decides what is drawn. */}
                {viewerCanGrantConsole && (
                  <div className="rounded-md border border-[var(--line)] p-3 space-y-3">
                    <p className={cn(MICRO, 'text-[var(--mute)]')}>Console access</p>
                    {selected.id === viewerId ? (
                      <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
                        You cannot change your own — in either direction. Taking it away here loses you
                        the screen you would need to put it back, and the database only protects the
                        last admin holding a passkey, which is not the same promise. Handing yourself a
                        level you do not have is the one move that would let this capability promote its
                        own holder, so it is refused before anything is read. Ask another admin.
                      </p>
                    ) : selected.level === 'admin' && !viewerIsAdmin ? (
                      <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
                        Only an admin can change an admin&rsquo;s console access. Taking it away is the
                        same act as giving it, so the level that no capability hands out is also the one
                        no capability takes back.
                      </p>
                    ) : (
                      <>
                        <Select
                          label="Level"
                          // ADMIN IS OFFERED TO ADMINS ONLY. Filtered rather
                          // than disabled: a greyed-out option invites the
                          // question "why not", and the answer — that no
                          // capability may mint an admin — belongs in the
                          // documentation rather than in a tooltip on a menu.
                          options={
                            viewerIsAdmin
                              ? EXEC_ROLE_OPTIONS
                              : EXEC_ROLE_OPTIONS.filter((option) => option.value !== 'admin')
                          }
                          value={access}
                          onChange={(e) => setAccess(e.target.value as ExecRole)}
                          className="max-w-sm"
                        />
                        {selectedLevel !== null && !selected.canSignIn && (
                          <p className="text-[11px] text-[var(--red)]">
                            They hold this level but cannot sign in — banned, suspended, awaiting
                            approval or deactivated. Their access starts working when their account
                            does.
                          </p>
                        )}
                        {access !== accessForLevel(selected.level) && (
                          <>
                            <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
                              {access === 'none'
                                ? 'They lose the console entirely, and anything set below is cleared with it — a stored role nobody can reach would sit dormant and wake up if they were ever promoted again.'
                                : selected.level === null
                                  ? 'They get the console, starting from everything that level has always had. Narrow it below afterwards.'
                                  : access === 'admin'
                                    ? 'Admins hold every capability by level, so anything set below stops being consulted and is cleared.'
                                    : 'Their level changes. Anything set below still applies — the resolver does not look at levels.'}
                            </p>
                            {/* THE JOB, IN THE SAME ACT AS THE LEVEL. Giving
                                somebody the console and giving them the job they
                                were elected to were two saves with a read-only
                                executive in between them, and setConsoleAccess now
                                takes both: one prompted step, one reason, and one
                                all-or-nothing act, refused whole if the baseline
                                cannot be handed over.

                                DRAWN ONLY WHERE IT WOULD MEAN SOMETHING. The
                                viewer must hold `permissions.write`, or the write
                                behind this select is one the server will refuse;
                                the level must be one of the two that consult a
                                stored set; and the person must have nothing stored
                                already, because a baseline REPLACES a composition
                                and this control is too small to be the place
                                somebody's hand-picked set is discarded. Editing an
                                existing one stays in the tree below. */}
                            {canCompose
                              && (access === 'executive' || access === 'trainer')
                              && selected.role === null
                              && selected.grants.length === 0
                              && selected.revokes.length === 0 && (
                              <>
                                <Select
                                  label="Baseline (optional)"
                                  options={[
                                    { value: '', label: 'No baseline for now' },
                                    ...offerableBaselines.map((baseline) => ({
                                      value: baseline.id,
                                      label: baselineLabel(baseline),
                                    })),
                                  ]}
                                  value={accessBaseline}
                                  onChange={(e) => setAccessBaseline(e.target.value)}
                                  className="max-w-sm"
                                />
                                <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
                                  Optional, and worth reading as a default rather than as an extra: a
                                  new executive with no baseline holds their level&rsquo;s read-only
                                  floor and has nothing to do inside it until somebody comes back and
                                  gives them a job.
                                </p>
                                {offerableBaselines.length < baselines.length && (
                                  <p className="text-[11px] text-[var(--mute)]">
                                    {baselines.length - offerableBaselines.length}{' '}
                                    {baselines.length - offerableBaselines.length === 1
                                      ? 'baseline holds'
                                      : 'baselines hold'}{' '}
                                    more than you do and cannot be handed out by you.
                                  </p>
                                )}
                              </>
                            )}
                            <Textarea
                              label="Reason (required)"
                              value={accessReason}
                              onChange={(e) => setAccessReason(e.target.value)}
                              placeholder="Why is this changing?"
                            />
                            <div className="flex justify-end">
                              <Button
                                onClick={applyAccess}
                                loading={savingAccess}
                                // REASON_MIN, where this used to be 2. "ok"
                                // cleared the old floor and told the next
                                // reader of the log nothing — and this reason
                                // is now forwarded into setPlayerPermissions
                                // when the move clears a stored composition,
                                // which measures against the shared floor.
                                disabled={accessReason.trim().length < REASON_MIN}
                              >
                                Apply console access
                              </Button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}

                {selectedLevel === null ? (
                  <p className="text-sm text-[var(--mute)] max-w-[64ch]">
                    An ordinary member. Capabilities are what somebody with the console may do inside
                    it, so there is nothing to set here until they have one.
                  </p>
                ) : (
                  <>
                    {readOnlyReason && (
                      <p className="text-sm text-[var(--mute)] max-w-[64ch]">{readOnlyReason}</p>
                    )}

                    {/* WHY THERE IS NO TREE, said out loud. This viewer is not
                        being refused anything — the row is composable and they
                        simply do not hold `permissions.write` — so it is not a
                        readOnlyReason and it is drawn only when there is no other
                        reason competing with it. A tree that is silently absent
                        is read as a bug in the screen. */}
                    {!canCompose && readOnlyReason === null && (
                      <p className="text-sm text-[var(--mute)] max-w-[64ch]">
                        You can set this member&rsquo;s console access here, but not hand-pick the
                        capabilities that come with it — that is set on Permissions. What they hold
                        today is below.
                      </p>
                    )}

                    {/* ADMIN IGNORES EVERY CELL BELOW, so say it before somebody
                        spends a minute setting them.

                        effectiveCapabilities returns ALL_CAPABILITIES on
                        `level === 'admin'` before it looks at the stored set
                        (access-level.ts:1397). The row still saves — the grid is
                        not lying about what it wrote — but nothing reads it while
                        the level stands, so the console and the player menu are
                        unchanged and the edit looks lost. That is exactly how it
                        was reported on 2026-08-15: "the permission editor makes
                        no changes". Losing an hour to a screen that accepted the
                        work and discarded it is worse than being told up front. */}
                    {selectedLevel === 'admin' && (
                      <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3">
                        <p className={cn(MICRO, 'text-[var(--text-primary)]')}>
                          An admin holds every capability by level
                        </p>
                        <p className="mt-1 text-[11px] text-[var(--mute)] max-w-[64ch]">
                          Anything set below is stored but never read while they are an admin — the
                          level answers first. To give this person a narrower set, change their level
                          above; the capabilities then start counting.
                        </p>
                      </div>
                    )}

                    {/* WHAT SAVING WOULD TAKE AWAY. The figure in the header
                        answers "what will they hold"; this band answers the
                        question that actually catches people out, which is "what
                        do they hold RIGHT NOW that they would stop holding". They
                        are not the same question and only the second one is a
                        warning. See the note on `losing` above for why a trainer
                        needs it more sharply than an exec does. */}
                    {composable && losing.length > 0 && (
                      <div className="rounded-md border border-[var(--red-border)] bg-[var(--red-wash)] p-3">
                        <p className={cn(MICRO, 'text-[var(--red)]')}>
                          Saving takes away {losing.length}{' '}
                          {losing.length === 1 ? 'capability' : 'capabilities'} they hold today
                        </p>
                        <p className="mt-2 text-[11px] text-[var(--mute)] leading-relaxed">
                          {losing.map((capability) => CAPABILITY_GATES[capability].label).join(' · ')}
                        </p>
                      </div>
                    )}

                    {/* ORPHANED REVOKES — a revoke of something the current role does
                        not give. Inert today, and KEPT rather than tidied away: if the
                        role ever regains that capability, the revoke should bite again,
                        and deleting it now would be a silent future re-grant nobody
                        chose. Surfaced instead, with a one-click clear, so that "inert"
                        is a state somebody can see rather than one they discover. */}
                    {composable && orphanRevokes.length > 0 && (
                      <div className="rounded-md border border-[var(--line)] p-3">
                        <p className={cn(MICRO, 'text-[var(--ink)]')}>
                          {orphanRevokes.length} revoke{orphanRevokes.length === 1 ? '' : 's'} the{' '}
                          {role === null ? 'current' : PERMISSION_ROLE_LABELS[role]} role does not give
                        </p>
                        <p className="mt-2 text-[11px] text-[var(--mute)]">
                          {orphanRevokes.map((c) => CAPABILITY_GATES[c].label).join(' · ')} — doing
                          nothing today, and will apply again if the role regains them.
                        </p>
                        <div className="mt-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDraft({
                                role,
                                grants,
                                revokes: revokes.filter((c) => !orphanRevokes.includes(c)),
                              })
                            }
                          >
                            Clear them
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* ALWAYS VISIBLE. The cost of a model where a role is a name and
                        the deltas are two lists is that the stored row no longer says
                        what a person can do. The figure above is the count; this is
                        the same set in words, and it is computed by the same function
                        the gates call. */}
                    <div className="rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-3">
                      <p className={cn(MICRO, 'text-[var(--mute)]')}>Everything they hold</p>
                      <p className="mt-2 text-[11px] text-[var(--mute)] leading-relaxed">
                        {effective.size === 0
                          ? 'Nothing. This person can sign in and reach the dashboard, and no section at all.'
                          : [...effective]
                              .map((capability) => CAPABILITY_GATES[capability].label)
                              .join(' · ')}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {/* THE TREE IS ALWAYS HERE, and that is what changed when trainers
                  became composable. It used to be hidden for anybody on their
                  level default, on the grounds that every cell would read "off"
                  beside a panel saying 71 of 116 — two true statements that look
                  like a contradiction. The contradiction was real; hiding the
                  tree was the wrong end of it. Showing the level's own
                  capabilities in their own state fixes the disagreement instead,
                  and leaves the common case — which is everybody, on day one —
                  looking like something you can edit. */}
              {composable && (
                <>
                  {/* --console-header-h (globals.css) is the console header's height
                      (sidebar.tsx): one row since the nav became dropdowns. It was 120px
                      for the old two-row bar, which left a gap that rows scrolled through
                      above this filter. */}
                  <div className="sticky top-[var(--console-header-h)] z-10 flex flex-wrap items-center gap-2 border-y border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
                    <SearchFilter
                      className="min-w-[200px] flex-1"
                      label="Filter capabilities by name or dotted path"
                      placeholder="Filter by name or by dotted path"
                      value={capabilitySearch}
                      onChange={setCapabilitySearch}
                      resultCount={shownLeaves}
                      noun="capability"
                      nounPlural="capabilities"
                    />
                    <Segmented label="Show" value={mode} options={MODES} onChange={setMode} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={filtering}
                      onClick={() => setExpanded(allExpanded ? [] : ALL_KEYS)}
                    >
                      {allExpanded ? 'Collapse all' : 'Expand all'}
                    </Button>
                  </div>

                  {TREE.map((node) => renderNode(node, 0, false))}

                  {shownLeaves === 0 && (
                    <p className="border-t border-[var(--line)] px-4 py-6 text-center text-[11px] text-[var(--mute)]">
                      No capability matches this filter.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </Card>

      {/* THE SAVE BAR EXISTS ONLY WHEN THERE IS SOMETHING TO SAVE, and says what
          that something is. It now sits OUTSIDE the two panes, and that is not a
          layout preference: a queued change survives the selection moving, so a
          bar drawn inside the editor pane would vanish the moment the admin went
          back to the list — on a phone, where exactly one pane is on screen at a
          time, it would vanish for the whole of the act it exists to describe.
          Out here it is visible from both, in both column counts.

          A DIRTY PERSON AND A CHANGED PERSON ARE DIFFERENT QUESTIONS. `entries`
          is who has something to SAVE; the figure is what those saves would do
          to the PEOPLE, and the two can disagree — turning a level default into
          a hand-picked set of exactly the same capabilities rewrites the row and
          changes nothing about anybody. That state is reachable in one click, so
          on one person it gets a sentence rather than a "0", and across several
          it is why "0 changes across 3 people" is a state this can honestly
          reach.

          ONE PERSON READS EXACTLY AS IT DID BEFORE — same words, same figures,
          same plain Reset. The aggregate phrasing starts at two. */}
      {entries.length > 0 && (
        <div className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
          <div className="min-w-0">
            <p className={cn(MICRO, 'text-[var(--ink)]')}>
              {only ? (
                only.changes === 0 ? (
                  'Nothing changes for them'
                ) : (
                  <>
                    <span className="font-mono">{only.changes}</span>{' '}
                    {only.changes === 1 ? 'change' : 'changes'} pending
                  </>
                )
              ) : (
                <>
                  <span className="font-mono">{queuedChanges}</span>{' '}
                  {queuedChanges === 1 ? 'change' : 'changes'} across{' '}
                  <span className="font-mono">{entries.length}</span> people
                </>
              )}
            </p>
            <p className="mt-1 text-[11px] text-[var(--mute)]">
              {only
                ? only.changes === 0
                  ? 'The stored row changes; what they can do does not.'
                  : [
                      only.gaining.length > 0 &&
                        `${only.gaining.length} ${only.gaining.length === 1 ? 'capability' : 'capabilities'} added`,
                      only.losing.length > 0 && `${only.losing.length} taken away`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                : entries
                    .map((entry) => `${entry.person.name} (${entry.changes})`)
                    .join(' · ')}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {/* ONE BOX FOR THE WHOLE QUEUE. It sits with the Save button and
                not in the tree, because the reason describes the DECISION —
                "the new socials team starts this week" — rather than any one
                of the people it reaches, and every one of their audit rows is
                written with it. Save is disabled until it says something: this
                was the last audited action in the console whose rows all read
                `reason: null`, and a box that could be skipped would leave it
                that way for anyone in a hurry. */}
            <div className="w-full min-w-0 sm:w-[300px]">
              <Input
                value={batchReason}
                onChange={(e) => setBatchReason(e.target.value)}
                aria-label="Reason (required)"
                placeholder={
                  only ? 'Reason (required)' : `Reason (required) — for all ${entries.length}`
                }
              />
            </div>
            <Button variant="ghost" onClick={() => void resetAll()} disabled={saving}>
              Reset
            </Button>
            <Button
              onClick={save}
              loading={saving}
              disabled={batchReason.trim().length < REASON_MIN}
            >
              {only ? 'Save' : 'Save all'}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={dangerous !== null}
        onClose={() => setDangerous(null)}
        title="Hand out permissions?"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            This person will be able to hand out any capability they themselves hold, including
            this one. They will not be able to hand out anything they do not hold — but within
            that bound there is no further limit, and the audit log is the only trace.
          </p>
          <Input
            label={`Type ${CONFIRM_PHRASE} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setDangerous(null)}>Cancel</Button>
            <Button
              disabled={typed !== CONFIRM_PHRASE}
              onClick={() => {
                if (dangerous) setCell(dangerous, 'on');
                setDangerous(null);
              }}
            >
              Grant it
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * The one-line summary under a person's name in the rail.
 *
 * THE ROLE IS CONSULTED BEFORE THE LEVEL IS ALLOWED TO ANSWER FOR ITSELF, and
 * that ordering is what changed when trainers became composable. This used to
 * return "roster and varsity notes" for any trainer, because a trainer could not
 * hold a role — now they can, and answering from the level would describe the
 * baseline of somebody who has been composed out of it.
 *
 * The title leads it where there is one, because "Treasurer · Finance" is how
 * the club refers to the person and "Finance" alone is how the code does.
 */
function describe(person: PersonRow, baselineNames: ReadonlyMap<string, string>): string {
  const parts: string[] = [];
  if (person.title) parts.push(person.title);
  parts.push(accessSummary(person, baselineNames));
  if (person.level !== null && !person.canSignIn) parts.push('cannot sign in');
  return parts.join(' · ');
}

function accessSummary(person: PersonRow, baselineNames: ReadonlyMap<string, string>): string {
  if (person.level === null) return 'No console access';
  // Still answered from the level, and still correctly: an admin's stored role
  // is never consulted, so there is nothing else it could say.
  if (person.level === 'admin') return 'Admin';
  if (!isRole(person.role)) return LEVEL_ACCESS_LABELS[person.level];
  // THE BASELINE'S NAME BEATS 'Hand-picked', because that is what the club
  // called it. A baseline holder IS stored as a hand-picked set — that is the
  // whole mechanism — so without this the one screen that knows their job would
  // be the one screen that will not say it.
  //
  // Falls back when the map has no entry: a baseline deleted while the page was
  // open should read as the hand-picked set the row genuinely is, never as a
  // blank.
  const name = person.baselineId === null ? undefined : baselineNames.get(person.baselineId);
  if (name) return name;
  return PERMISSION_ROLE_LABELS[person.role];
}
