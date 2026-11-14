'use client';

import { ATTENDANCE_POLICY_TEXT } from '@badminton/shared';

// THE CLUB'S ATTENDANCE POLICY, said before the member enters. The event
// standard warns a no-show and may restrict them from future events, and a
// member who first hears that in the warning was never told.
//
// A tick box for the same reason as SoloEntryConsent: while the
// attendance_policy_ack switch is on, registerForEvent and joinEventWaitlist
// refuse without `attendancePolicyAcknowledged`, and this is the only thing in
// the app that sets it.

export function AttendancePolicyConsent({
  accepted,
  onAcceptedChange,
}: {
  accepted: boolean;
  onAcceptedChange: (value: boolean) => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        display: 'grid',
        gap: 10,
      }}
    >
      <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
        <strong>Attendance policy.</strong> {ATTENDANCE_POLICY_TEXT}
      </p>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          fontSize: 13,
          lineHeight: 1.5,
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
          style={{ marginTop: 2, accentColor: 'var(--red)', flexShrink: 0 }}
        />
        <span>I have read the attendance policy.</span>
      </label>
    </div>
  );
}
