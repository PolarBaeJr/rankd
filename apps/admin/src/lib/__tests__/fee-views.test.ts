import { describe, it, expect } from 'vitest';
import { FEE_VIEWS, legacyTabRedirect, resolveFeeView, type FeeViewId } from '../fee-views';
import { adminNavItemHasContent } from '../../components/nav-sections';
import {
  effectiveCapabilities,
  resolvePermissions,
  EXEC_BASELINE,
  UNRESTRICTED,
  type Capability,
} from '../permissions';

// The /fees list's views: which one a URL opens, and where the two ledgers
// that left for /finances send an old link.

const EVERY_VIEW: FeeViewId[] = FEE_VIEWS.map((v) => v.id);
const ROSTER_ONLY: FeeViewId[] = ['all', 'unpaid', 'paid'];
const RECEIPTS_ONLY: FeeViewId[] = ['review'];

describe('resolveFeeView', () => {
  it('opens the view each old tab showed', () => {
    expect(resolveFeeView({ tab: 'fees' }, EVERY_VIEW, false)).toBe('all');
    expect(resolveFeeView({ tab: 'submitted' }, EVERY_VIEW, false)).toBe('review');
    expect(resolveFeeView({ tab: 'outstanding' }, EVERY_VIEW, true)).toBe('unpaid');
  });

  it('lets an explicit view beat a legacy tab', () => {
    expect(resolveFeeView({ view: 'paid', tab: 'submitted' }, EVERY_VIEW, true)).toBe('paid');
  });

  it('opens an explicit view even while receipts are waiting', () => {
    expect(resolveFeeView({ view: 'all' }, EVERY_VIEW, true)).toBe('all');
  });

  it('falls back to the default for a view that is not permitted', () => {
    expect(resolveFeeView({ view: 'review' }, ROSTER_ONLY, true)).toBe('all');
    expect(resolveFeeView({ view: 'paid' }, RECEIPTS_ONLY, false)).toBe('review');
    expect(resolveFeeView({ view: 'waived' }, ROSTER_ONLY, false)).toBe('all');
    expect(resolveFeeView({ view: 'nonsense' }, EVERY_VIEW, false)).toBe('all');
  });

  it('defaults to To review only when a receipt waits and the viewer may settle it', () => {
    expect(resolveFeeView({}, EVERY_VIEW, true)).toBe('review');
    expect(resolveFeeView({}, EVERY_VIEW, false)).toBe('all');
    expect(resolveFeeView({}, ROSTER_ONLY, true)).toBe('all');
    expect(resolveFeeView({}, RECEIPTS_ONLY, false)).toBe('review');
  });

  it('opens no view for somebody who may see none', () => {
    expect(resolveFeeView({}, [], true)).toBeNull();
    expect(resolveFeeView({ view: 'all' }, [], false)).toBeNull();
  });
});

describe('legacyTabRedirect', () => {
  it('sends the two ledgers to their section of /finances', () => {
    expect(legacyTabRedirect('income', undefined)).toBe('/finances#income');
    expect(legacyTabRedirect('expenses', undefined)).toBe('/finances#expenses');
  });

  it('keeps the season the link named', () => {
    expect(legacyTabRedirect('expenses', 'abc-123')).toBe('/finances?season=abc-123#expenses');
    expect(legacyTabRedirect('income', 'abc-123')).toBe('/finances?season=abc-123#income');
  });

  it('leaves every other tab on /fees', () => {
    for (const tab of [undefined, 'fees', 'submitted', 'outstanding', 'nonsense']) {
      expect(legacyTabRedirect(tab, 'abc-123'), String(tab)).toBeNull();
    }
  });
});

describe('adminNavItemHasContent', () => {
  it('shows an exec on the floor Finances and not Fees', () => {
    const held = effectiveCapabilities('exec', UNRESTRICTED);
    expect(adminNavItemHasContent('/fees', held)).toBe(false);
    expect(adminNavItemHasContent('/finances', held)).toBe(true);
  });

  it('shows a holder of markpaid both', () => {
    const granted = resolvePermissions('exec', 'custom', [...EXEC_BASELINE, 'fees.clubfees.markpaid.write'], []);
    const held = effectiveCapabilities('exec', granted);
    expect(adminNavItemHasContent('/fees', held)).toBe(true);
    expect(adminNavItemHasContent('/finances', held)).toBe(true);
  });

  it('shows an admin everything', () => {
    const held = effectiveCapabilities('admin', UNRESTRICTED);
    expect(adminNavItemHasContent('/fees', held)).toBe(true);
    expect(adminNavItemHasContent('/finances', held)).toBe(true);
  });

  it('shows a holder of the reinstatement ledger alone Fees', () => {
    const held = new Set<Capability>(['fees.page', 'fees.reinstatements.read']);
    expect(adminNavItemHasContent('/fees', held)).toBe(true);
    expect(adminNavItemHasContent('/finances', held)).toBe(false);
  });

  it('never hides any other item', () => {
    expect(adminNavItemHasContent('/players', new Set())).toBe(true);
  });
});
