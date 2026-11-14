import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ATTENDANCE_POLICY_TEXT } from '@badminton/shared';
import { AttendancePolicyConsent } from '../AttendancePolicyConsent';

// The policy is said in the dialog itself, beside the box that sets
// attendancePolicyAcknowledged: a server render is enough to pin both.
describe('AttendancePolicyConsent', () => {
  it('shows the policy and an unticked box', () => {
    const html = renderToStaticMarkup(<AttendancePolicyConsent accepted={false} onAcceptedChange={() => {}} />);
    expect(html).toContain(ATTENDANCE_POLICY_TEXT);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('I have read the attendance policy.');
  });

  it('shows the box ticked once accepted', () => {
    const html = renderToStaticMarkup(<AttendancePolicyConsent accepted onAcceptedChange={() => {}} />);
    expect(html).toContain('checked=""');
  });
});
