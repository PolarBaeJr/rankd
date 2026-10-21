'use client';

import React, { useMemo } from 'react';
import { DatePicker } from './DatePicker';
import { Select } from './Select';

// A date and a time of day as one wall-clock value, "YYYY-MM-DDTHH:MM", the
// same string a `datetime-local` input produces, so a form can swap one for
// the other without touching how it saves. The browser's own datetime popup
// ignores the console's theme; this is the themed calendar plus a time list.

interface DateTimePickerProps {
  label?: string;
  /** "YYYY-MM-DDTHH:MM", or '' */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  /** The time a newly picked date starts at, "HH:MM". */
  defaultTime?: string;
  /** Minutes between the offered times. */
  stepMinutes?: number;
  className?: string;
}

function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function DateTimePicker({
  label,
  value,
  onChange,
  required,
  disabled,
  error,
  defaultTime = '19:00',
  stepMinutes = 15,
  className,
}: DateTimePickerProps) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  const date = match?.[1] ?? '';
  const time = match?.[2] ?? '';

  const options = useMemo(() => {
    const times: string[] = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += stepMinutes) {
      times.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
    }
    // A saved time off the step (7:10) is still offered, so opening a form
    // never changes it.
    if (time && !times.includes(time)) times.push(time);
    return times.sort().map((t) => ({ value: t, label: timeLabel(t) }));
  }, [stepMinutes, time]);

  return (
    <div className={className}>
      {label && (
        <div className="mb-1.5 text-sm text-[var(--text-secondary)]">
          {label}
          {required && <span className="text-[var(--color-danger)]"> *</span>}
        </div>
      )}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <DatePicker
            value={date}
            required={required}
            disabled={disabled}
            onChange={(next) => onChange(next ? `${next}T${time || defaultTime}` : '')}
          />
        </div>
        <div className="w-36 shrink-0">
          <Select
            aria-label={label ? `${label} time` : 'Time'}
            options={options}
            value={time}
            placeholder="Time"
            disabled={disabled || !date}
            onValueChange={(next) => date && onChange(`${date}T${next}`)}
          />
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
