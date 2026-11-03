'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Select, type SelectOption } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { setClubEventPartnerChoice, type PartnerChoice } from '@/lib/actions/club-event-partners';

/** Somebody signed up to the event, as the partner picker lists them. */
export interface PartnerOption {
  key: string;
  name: string;
  guest: boolean;
}

const TYPED = 'typed';
const NONE = 'none';

function choiceOf(value: string): PartnerChoice {
  if (value === TYPED) return { kind: 'typed' };
  if (value === NONE) return { kind: 'none' };
  const [kind, id] = value.split(':') as ['member' | 'guest', string];
  return { kind, id };
}

/**
 * The desk sets one sign-up's partner (00311) by picking somebody signed up to
 * the same event. "Use what they wrote" clears the desk's choice so the typed
 * note stands again.
 */
export function PartnerChoiceDialog({
  clubEventId,
  personKey,
  name,
  wrote,
  preselect,
  options,
  onClose,
}: {
  clubEventId: string;
  personKey: string;
  name: string;
  wrote: string | null;
  preselect: string;
  options: PartnerOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [value, setValue] = useState(preselect);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectOptions: SelectOption[] = [
    { value: TYPED, label: 'Use what they wrote' },
    { value: NONE, label: 'No preferred partner' },
    ...options
      .filter((option) => option.key !== personKey)
      .map((option) => ({ value: option.key, label: option.guest ? `${option.name} (Non-member)` : option.name })),
  ];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const [kind, id] = personKey.split(':') as ['member' | 'guest', string];
      const result = await setClubEventPartnerChoice(clubEventId, { kind, id }, choiceOf(value));
      if (!result.ok) return setError(result.error);
      toast(result.data?.paired ? `${name} is paired in the tournament.` : `${name}'s partner is saved.`, 'success');
      onClose();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${name}'s partner`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--ink-2)]">
          {wrote && wrote.trim() !== '' ? <>Wrote: {wrote}</> : 'They did not name a partner on the Form.'}
        </p>
        <Select
          label="Partner"
          value={value}
          onValueChange={setValue}
          options={selectOptions}
          searchable="auto"
          searchPlaceholder="Search a name"
        />
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
