import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionCharts } from '@/app/fees/collection-charts';
import { LedgerCharts } from '@/app/fees/ledger-charts';
import { NetPositionChart } from '@/app/fees/net-position-chart';
import { SeasonTrendPanel } from '@/app/seasons/trend-panel';
import { buildRunningTotal } from '@/lib/charts';
import { clubDayOf } from '@/components/charts';

/**
 * THE CHART PANELS ON /fees AND /seasons, RENDERED.
 *
 * The maths under them is already pinned by charts.test.ts; what is pinned here
 * is the half a pure-function test cannot reach — WHICH BRANCH a panel takes for
 * a given ledger, and therefore what a reader is actually told. Every panel here
 * has an honest-empty-state path, and an empty state that silently stopped
 * rendering, or a shape drawn over nothing, is exactly the failure the kit's
 * refusals exist to prevent: a null scale that quietly rendered no note at all
 * would pass every assertion in charts.test.ts.
 *
 * THE FIXTURES ARE STAGING'S ACTUAL SHAPE, read off the database on 2026-08-11
 * and transcribed rather than invented, because the degenerate cases there are
 * ones a real club produces: a ledger whose money is dated OUTSIDE its own
 * season's window, an income ledger holding exactly the two days a line needs,
 * an expense ledger with an unpaid row in it, and — on /seasons — a club every
 * one of whose seasons is still ahead of the calendar.
 *
 * createElement RATHER THAN JSX, and a .ts rather than a .tsx: the admin
 * vitest config sets no JSX transform, and turning one on for one test file
 * would change how every other test in this app is compiled. These are server
 * components with no state and no effects, so renderToStaticMarkup drives them
 * exactly as a request would.
 */

// GENERIC over the component's own props. This was typed as
// `Parameters<typeof h>[0]`, which createElement resolves to a component
// taking NO props — so every chart here, all of which take required props,
// was a type error while the tests themselves passed. Tying `props` to the
// component's parameter also means passing the wrong shape is now caught.
const html = <P,>(type: (props: P) => unknown, props: P) =>
  renderToStaticMarkup(h(type as never, props as never));

// Staging's Fall 2026 dues: five payments over five club-local days, the last
// dated in October — inside the season but after today, which is why the time
// domain comes from the data and never from seasons.start_date.
const DUES = [
  { at: '2026-08-01T19:00:00Z', cents: 5000 },
  { at: '2026-08-14T19:00:00Z', cents: 5000 },
  { at: '2026-09-02T19:00:00Z', cents: 1500 },
  { at: '2026-09-20T19:00:00Z', cents: 1500 },
  { at: '2026-10-04T19:00:00Z', cents: 2500 },
];

describe('CollectionCharts', () => {
  it('draws the billable total and the share of it that is in', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2026',
      isPast: false,
      collectedCents: 15500,
      outstandingCents: 434500,
      payments: DUES,
    });
    // Collected plus still owed IS the season's billable total, which is what
    // makes this a split rather than two bars on a shared scale.
    expect(out).toContain('Billable this season');
    expect(out).toContain('$4500.00');
    expect(out).toContain('$155.00');
    expect(out).toContain('$4345.00');
  });

  // THE FIGURE THAT WOULD BE FICTION. "Still owed" is priced from TODAY's
  // roster, and a term that has ended has no stored record of who was billable
  // in it — so the split is withheld rather than estimated.
  it('withholds what is still owed on a closed term, and says why', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Spring 2026',
      isPast: true,
      collectedCents: 15500,
      outstandingCents: null,
      payments: DUES,
    });
    expect(out).toContain('is closed, so what is still owed cannot be worked out');
    expect(out).not.toContain('Billable this season');
    // What WAS taken in is still knowable, and is still shown.
    expect(out).toContain('$155.00');
  });

  // SplitBar is the one shape in the kit that draws something for nothing — a
  // zero total gives an empty track rather than null — so the caller owes the
  // words. A brand-new season with nobody billable yet.
  it('says nothing has happened rather than drawing an empty track', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2027',
      isPast: false,
      collectedCents: 0,
      outstandingCents: 0,
      payments: [],
    });
    expect(out).toContain('nothing to divide');
    expect(out).toContain('No dues have been recorded');
  });

  // The dashboard agent found a season where every payment landed on one day.
  // computeRunningScale returns null there, and a flat line across the box
  // would read "nothing happened all term" over a ledger where everything
  // happened at once.
  it('refuses a line through one day and explains the gap', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2026',
      isPast: false,
      collectedCents: 5000,
      outstandingCents: 1000,
      payments: [{ at: '2026-08-01T19:00:00Z', cents: 5000 }],
    });
    expect(out).toContain('landed on one day');
    expect(out).not.toContain('<svg');
    // The figures survive the missing chart — the split is still drawable.
    expect(out).toContain('Billable this season');
  });
});

// Dues paid on the Campus Rec website are paid but are not the club's money. The
// split keeps them as a third segment, so the billable total still counts
// those members and "Collected" is the club's money alone.
describe('CollectionCharts with dues Campus Rec collected', () => {
  it('draws Campus Rec as its own segment and counts it as paid', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2026',
      isPast: false,
      collectedCents: 10000,
      sfuRecCents: 10000,
      outstandingCents: 20000,
      payments: DUES.slice(0, 2),
    });
    expect(out).toContain('Billable this season');
    expect(out).toContain('$400.00');
    expect(out).toContain('Collected by Campus Rec');
    // Half the billable dues are paid: a quarter by each route.
    expect(out).toContain('50% of the term');
    expect(out).toContain('Dues the club collected for Fall 2026: $100.00');
  });

  it('draws the two-part split unchanged when nothing went through Campus Rec', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2026',
      isPast: false,
      collectedCents: 15500,
      outstandingCents: 434500,
      payments: DUES,
    });
    expect(out).not.toContain('Campus Rec');
  });

  it('still shows what Campus Rec collected on a closed term', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Spring 2026',
      isPast: true,
      collectedCents: 15500,
      sfuRecCents: 8000,
      outstandingCents: null,
      payments: DUES,
    });
    expect(out).toContain('Collected by Campus Rec');
    expect(out).toContain('$80.00');
  });

  // Every payment so far went through Campus Rec, so the club's own curve is
  // empty. "No dues have been recorded" would be untrue.
  it('does not claim no dues were recorded when Campus Rec collected them all', () => {
    const out = html(CollectionCharts, {
      seasonName: 'Fall 2026',
      isPast: false,
      collectedCents: 0,
      sfuRecCents: 5000,
      outstandingCents: 5000,
      payments: [],
    });
    expect(out).not.toContain('No dues have been recorded');
    expect(out).toContain('collected by Campus Rec');
  });
});

// Staging's club_expenses: three paid rows across three club-local days, plus
// one row with no paid_at that the ledger card badges "Not recorded". Two of
// the paid rows were bought out of pocket, one of those has been settled, and
// the third went on the club's own card.
const EXPENSES = [
  {
    amount_cents: 30000,
    category: 'court_rental',
    paid_at: '2026-07-22T18:00:00Z',
    paid_by: 'exec-1',
    reimbursed_at: null,
  },
  {
    amount_cents: 8400,
    category: 'shuttles',
    paid_at: '2026-07-29T18:00:00Z',
    paid_by: 'exec-2',
    reimbursed_at: '2026-08-02T18:00:00Z',
  },
  {
    amount_cents: 18000,
    category: 'shuttles',
    paid_at: '2026-08-07T18:00:00Z',
    paid_by: null,
    reimbursed_at: null,
  },
  // Money that has not left the bank. It is in the table below, badged, and it
  // must not be in the total above it.
  {
    amount_cents: 8500,
    category: 'food',
    paid_at: null,
    paid_by: 'exec-1',
    reimbursed_at: null,
  },
];

describe('LedgerCharts', () => {
  it('totals only the rows that have actually been paid', () => {
    const out = html(LedgerCharts, { kind: 'expense', seasonName: 'Fall 2026', rows: EXPENSES });
    // 30000 + 8400 + 18000. The unpaid $85.00 food row is excluded, so the
    // figure is the sum of exactly the rows badged "Counted" beneath it.
    expect(out).toContain('$564.00');
    expect(out).not.toContain('$649.00');
  });

  // The denominator is what people FRONTED, not all spending. A season paid for
  // entirely on the club card would otherwise read as fully settled having
  // settled nothing.
  it('measures the out-of-pocket debt against what was fronted', () => {
    const out = html(LedgerCharts, { kind: 'expense', seasonName: 'Fall 2026', rows: EXPENSES });
    expect(out).toContain('Out of pocket');
    expect(out).toContain('$84.00'); // paid back
    expect(out).toContain('$300.00'); // still owed
    expect(out).toContain('1 expense is');
  });

  it('draws no out-of-pocket split when the club paid for everything itself', () => {
    const out = html(LedgerCharts, {
      kind: 'expense',
      seasonName: 'Fall 2026',
      rows: [
        { amount_cents: 18000, category: 'shuttles', paid_at: '2026-08-07T18:00:00Z', paid_by: null, reimbursed_at: null },
        { amount_cents: 30000, category: 'court_rental', paid_at: '2026-08-09T18:00:00Z', paid_by: null, reimbursed_at: null },
      ],
    });
    expect(out).not.toContain('Out of pocket');
  });

  // One category draws one full-width bar beside a figure identical to the
  // headline three inches above it — a chart that restates a number already on
  // the screen.
  it('draws no breakdown for a ledger with a single category', () => {
    const out = html(LedgerCharts, {
      kind: 'income',
      seasonName: 'Fall 2026',
      rows: [
        { amount_cents: 40000, category: 'grant', paid_at: '2026-07-12T18:00:00Z' },
        { amount_cents: 25000, category: 'grant', paid_at: '2026-07-27T18:00:00Z' },
      ],
    });
    expect(out).not.toContain('Where it came from');
    expect(out).toContain('$650.00');
  });

  it('breaks down an income ledger holding more than one kind of money', () => {
    const out = html(LedgerCharts, {
      kind: 'income',
      seasonName: 'Fall 2026',
      rows: [
        { amount_cents: 40000, category: 'grant', paid_at: '2026-07-12T18:00:00Z' },
        { amount_cents: 25000, category: 'sponsorship', paid_at: '2026-07-27T18:00:00Z' },
      ],
    });
    expect(out).toContain('Where it came from');
    // Exactly two club-local days — the minimum a running total can be drawn
    // over, and what staging's other_income actually holds.
    expect(out).toContain('<svg');
  });

  // The ledger card underneath already says the ledger is empty in its own
  // words; a second empty state stacked on the first is furniture.
  it('renders nothing at all when no row has been paid', () => {
    expect(
      html(LedgerCharts, {
        kind: 'expense',
        seasonName: 'Fall 2026',
        rows: [{ amount_cents: 8500, category: 'food', paid_at: null, paid_by: null, reimbursed_at: null }],
      }),
    ).toBe('');
  });
});

// A term the club paid for before the money came in: three hundred dollars of
// court rental in July against dues that arrive from August onwards. It is the
// ordinary shape of a season, and it means the net position spends part of the
// term BELOW zero — which is the case the whole signed scale exists for.
const NET_PAYMENTS = [
  { at: '2026-07-22T18:00:00Z', cents: -30000 },
  { at: '2026-08-01T19:00:00Z', cents: 5000 },
  { at: '2026-08-14T19:00:00Z', cents: 20000 },
  { at: '2026-09-02T19:00:00Z', cents: 9000 },
];

const FINANCES = {
  income: {
    clubCents: 34000,
    tournamentCents: 0,
    reinstatementCents: 0,
    eventCents: 0,
    otherCents: 0,
    totalCents: 34000,
    collectedBySfuRecCents: 0,
    payments: [],
  },
  expenseCents: 30000,
  expensesByCategory: [{ category: 'court_rental', cents: 30000 }],
  netCents: 4000,
  netPayments: NET_PAYMENTS,
};

describe('NetPositionChart', () => {
  // THE INVARIANT THE WHOLE PANEL RESTS ON. The curve's last point has to BE
  // the headline figure, not merely agree with it — both come from rows filtered
  // `paid_at is not null`, so cumulating the signed list must land on netCents.
  // A curve whose end disagrees with the number beside it is worse than no
  // curve.
  it('ends the curve on exactly the net the strip prints', () => {
    const points = buildRunningTotal(NET_PAYMENTS, clubDayOf);
    expect(points[points.length - 1]!.cents).toBe(FINANCES.netCents);
  });

  it('draws the term and names how far into the red it went', () => {
    const out = html(NetPositionChart, { finances: FINANCES, seasonName: 'Fall 2026' });
    expect(out).toContain('<svg');
    expect(out).toContain('The rule is break-even');
    // $300 out before a penny came in — the low point, and a figure a reader
    // cannot recover from a deliberately unlabelled axis.
    expect(out).toContain('lowest point was $300.00 in the red');
  });

  it('says nothing about the red for a term that never went into it', () => {
    const out = html(NetPositionChart, {
      finances: {
        ...FINANCES,
        netPayments: [
          { at: '2026-08-01T19:00:00Z', cents: 5000 },
          { at: '2026-08-14T19:00:00Z', cents: 20000 },
        ],
        netCents: 25000,
      },
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('<svg');
    expect(out).not.toContain('lowest point');
  });

  // A club still AT its worst day. The low point is then the net position — the
  // figure already in the strip above and in this chart's own label — and
  // saying it again in words, once with a minus sign and once without, is the
  // restatement three other charts on these two pages were cut for.
  it('does not name the low point when the low point is today', () => {
    const out = html(NetPositionChart, {
      finances: {
        ...FINANCES,
        netPayments: [
          { at: '2026-08-01T19:00:00Z', cents: 5000 },
          { at: '2026-08-14T19:00:00Z', cents: -30000 },
        ],
        netCents: -25000,
      },
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('The rule is break-even');
    expect(out).not.toContain('lowest point');
  });

  it('refuses a line through one day', () => {
    const out = html(NetPositionChart, {
      finances: { ...FINANCES, netPayments: [{ at: '2026-08-01T19:00:00Z', cents: 5000 }] },
      seasonName: 'Fall 2026',
    });
    expect(out).toContain('landed on one day');
    expect(out).not.toContain('<svg');
  });

  // Distinct from the one-day case: nothing at all has been recorded, and
  // telling somebody their payments all landed on one day would be a small lie.
  it('tells an untouched season apart from a one-day one', () => {
    const out = html(NetPositionChart, {
      finances: { ...FINANCES, netPayments: [], netCents: 0 },
      seasonName: 'Fall 2027',
    });
    expect(out).toContain('no position to plot');
    expect(out).not.toContain('landed on one day');
  });
});

// Staging on 2026-08-11: four seasons, and every one of them starts in the
// future. The club's own ACTIVE season begins on 1 September.
const FUTURE_SEASONS = [
  { id: 's4', name: 'Summer 2027', start_date: '2029-08-15', end_date: null, active_flag: false },
  { id: 's3', name: 'Fall 2027', start_date: '2027-09-01', end_date: '2027-12-31', active_flag: false },
  { id: 's2', name: 'Spring 2027', start_date: '2027-01-01', end_date: '2027-04-30', active_flag: false },
  { id: 's1', name: 'Fall 2026', start_date: '2026-09-01', end_date: '2026-12-31', active_flag: true },
];

describe('SeasonTrendPanel', () => {
  // THE DEGENERATE CASE, AND IT IS THE ONE STAGING IS IN. Four seasons that
  // have not begun, charted as four zero columns, would read as a club that has
  // stopped playing.
  it('says nothing has started rather than drawing four zero columns', () => {
    const out = html(SeasonTrendPanel, {
      seasons: FUTURE_SEASONS,
      matchCounts: new Map(),
      playerCounts: new Map(),
      now: '2026-08-11',
    });
    expect(out).toContain('No season has started yet');
    expect(out).not.toContain('Fall 2026');
  });

  it('tells a club with no seasons apart from one whose seasons are all ahead', () => {
    const out = html(SeasonTrendPanel, {
      seasons: [],
      matchCounts: new Map(),
      playerCounts: new Map(),
      now: '2026-08-11',
    });
    expect(out).toContain('No season has been created yet');
  });

  // Once the calendar catches up: the same four seasons, two of them started,
  // drawn oldest first so the axis runs forwards in time.
  it('draws the started terms in calendar order and leaves the rest out', () => {
    const out = html(SeasonTrendPanel, {
      seasons: FUTURE_SEASONS,
      matchCounts: new Map([['s1', 60], ['s2', 41]]),
      playerCounts: new Map([['s1', 22], ['s2', 18]]),
      now: '2027-02-01',
    });
    expect(out.indexOf('Fall 2026')).toBeGreaterThan(-1);
    expect(out.indexOf('Fall 2026')).toBeLessThan(out.indexOf('Spring 2027'));
    // Fall 2027 and Summer 2027 have not begun.
    expect(out).not.toContain('Fall 2027');
    expect(out).toContain('>60<');
    expect(out).toContain('>22<');
  });

  // A term that HAS started and holds nothing is a real zero and is drawn as
  // one — an empty tick with its figure under it, never a minimum-height stub.
  it('draws a started term with nothing in it as a genuine zero', () => {
    const out = html(SeasonTrendPanel, {
      seasons: FUTURE_SEASONS,
      matchCounts: new Map([['s2', 41]]),
      playerCounts: new Map([['s2', 18]]),
      now: '2027-02-01',
    });
    expect(out).toContain('Fall 2026');
    expect(out).toContain('>0<');
    expect(out).toContain('A term at zero has started');
  });

  // seasons.name is not unique in the schema, and ColumnChart keys on the
  // label — a collision would collapse two terms into one React child.
  it('keeps two identically named terms as two columns', () => {
    const out = html(SeasonTrendPanel, {
      seasons: [
        { id: 'b', name: 'Fall 2026', start_date: '2026-02-01', end_date: null, active_flag: false },
        { id: 'a', name: 'Fall 2026', start_date: '2026-01-01', end_date: null, active_flag: false },
      ],
      matchCounts: new Map([['a', 12], ['b', 30]]),
      playerCounts: new Map([['a', 5], ['b', 9]]),
      now: '2026-08-11',
    });
    expect(out).toContain('Fall 2026 (2)');
    expect(out).toContain('>12<');
    expect(out).toContain('>30<');
  });
});
