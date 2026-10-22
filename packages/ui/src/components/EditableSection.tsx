'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Button } from './Button';
import { cn } from '../utils';

interface EditableSectionState {
  editing: boolean;
  open: () => void;
  close: () => void;
}

const EditableSectionContext = createContext<EditableSectionState | null>(null);

const NO_SECTION: EditableSectionState = { editing: true, open: () => {}, close: () => {} };

/**
 * The edit state of the nearest EditableSection. A form calls `close()` after a
 * successful save and on Cancel. Outside a section (the same form on a create
 * page) `close` is a no-op, so the form needs no second code path.
 */
export function useEditableSection(): EditableSectionState {
  return useContext(EditableSectionContext) ?? NO_SECTION;
}

/** The toggle and the content are dead without a provider, so they refuse to render outside one. */
function useRequiredSection(component: string): EditableSectionState {
  const section = useContext(EditableSectionContext);
  if (!section) throw new Error(`${component} must be inside an EditableSectionProvider`);
  return section;
}

/**
 * The edit state alone, for a page that already has a header slot (a panel's
 * trailing slot, say): put EditableSectionToggle in the slot and
 * EditableSectionContent in the body, with this wrapped round both.
 */
export function EditableSectionProvider({ children }: { children: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const open = useCallback(() => setEditing(true), []);
  const close = useCallback(() => setEditing(false), []);
  const value = useMemo(() => ({ editing, open, close }), [editing, open, close]);
  return <EditableSectionContext.Provider value={value}>{children}</EditableSectionContext.Provider>;
}

/** The Edit button. Hidden while editing: the form carries its own Save and Cancel. */
export function EditableSectionToggle({
  canEdit = true,
  label = 'Edit',
  className,
}: {
  canEdit?: boolean;
  label?: string;
  className?: string;
}) {
  const { editing, open } = useRequiredSection('EditableSectionToggle');
  if (!canEdit || editing) return null;
  return (
    <Button variant="secondary" size="sm" onClick={open} className={className}>
      {label}
    </Button>
  );
}

/**
 * The read view, or the form while editing. The form is MOUNTED ONLY WHILE
 * EDITING, never kept mounted and hidden: each Edit seeds its state from fresh
 * props, and Cancel discards a draft by unmounting it.
 */
export function EditableSectionContent({ read, form }: { read: React.ReactNode; form: React.ReactNode }) {
  const { editing } = useRequiredSection('EditableSectionContent');
  return <>{editing ? form : read}</>;
}

/**
 * A saved record shown as text, with an Edit button that swaps in its form.
 * Draws its own card with the title row; use EditableSectionProvider instead
 * where the page already has a header to put the toggle in.
 */
export function EditableSection({
  title,
  sub,
  canEdit = true,
  editLabel = 'Edit',
  read,
  form,
  className,
}: {
  title?: string;
  sub?: React.ReactNode;
  canEdit?: boolean;
  editLabel?: string;
  read: React.ReactNode;
  form: React.ReactNode;
  className?: string;
}) {
  return (
    <EditableSectionProvider>
      <div className={cn('bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6', className)}>
        {(title || sub || canEdit) && (
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {title && (
                <h2
                  className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
                  style={{ fontFamily: 'var(--display)' }}
                >
                  {title}
                </h2>
              )}
              {sub && <div className="mt-1 text-sm text-[var(--ink-2)]">{sub}</div>}
            </div>
            <EditableSectionToggle canEdit={canEdit} label={editLabel} />
          </div>
        )}
        <EditableSectionContent read={read} form={form} />
      </div>
    </EditableSectionProvider>
  );
}

/** Label and value pairs, two columns from `sm` up. */
export function DetailList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2', className)}>{children}</dl>;
}

/** One pair in a DetailList. An empty value reads as a muted "Not set". */
export function DetailRow({
  label,
  value,
  wide,
  mono = true,
}: {
  label: string;
  value?: React.ReactNode;
  /** Spans both columns, for long text such as a description. */
  wide?: boolean;
  /** Off for prose, which reads badly in mono. */
  mono?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="dialog-group-label !mb-1">{label}</dt>
      <dd
        className={cn(
          'break-words text-sm',
          mono && 'font-mono',
          empty ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]',
        )}
      >
        {empty ? 'Not set' : value}
      </dd>
    </div>
  );
}
