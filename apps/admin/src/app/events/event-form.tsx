'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  DateTimePicker,
  Dialog,
  Input,
  Select,
  Textarea,
  useConfirm,
  useEditableSection,
} from '@badminton/ui';
import { CLUB_EVENT_KINDS, CLUB_EVENT_KIND_LABELS } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { cancelClubEvent, createClubEvent, deleteClubEvent, updateClubEvent } from '@/lib/actions/club-events';

// Times are club wall-clock strings, "YYYY-MM-DDTHH:MM", from DateTimePicker. The action
// converts them, so nothing here builds a Date from one.
export interface ClubEventFormValues {
  title: string;
  kind: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  signup_opens_at: string;
  signup_closes_at: string;
  capacity: string;
  cost_dollars: string;
  publish: boolean;
}

const EMPTY_CLUB_EVENT_FORM: ClubEventFormValues = {
  title: '',
  kind: 'social',
  description: '',
  location: '',
  starts_at: '',
  ends_at: '',
  signup_opens_at: '',
  signup_closes_at: '',
  capacity: '',
  cost_dollars: '',
  publish: false,
};

const KIND_OPTIONS = CLUB_EVENT_KINDS.map((kind) => ({ value: kind, label: CLUB_EVENT_KIND_LABELS[kind] }));

export function ClubEventForm({
  eventId,
  initial = EMPTY_CLUB_EVENT_FORM,
}: {
  /** Both absent on /events/new. */
  eventId?: string;
  initial?: ClubEventFormValues;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { close } = useEditableSection();
  const [values, setValues] = useState<ClubEventFormValues>(initial);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ClubEventFormValues>(key: K, value: ClubEventFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const input = {
        title: values.title,
        kind: values.kind as (typeof CLUB_EVENT_KINDS)[number],
        description: values.description,
        location: values.location,
        starts_at: values.starts_at,
        ends_at: values.ends_at,
        signup_opens_at: values.signup_opens_at,
        signup_closes_at: values.signup_closes_at,
        capacity: values.capacity.trim() === '' ? null : Number(values.capacity),
        cost_dollars: values.cost_dollars.trim() === '' ? null : Number(values.cost_dollars),
        publish: values.publish,
      };
      if (eventId) {
        const result = await updateClubEvent(eventId, input);
        if (!result.ok) {
          toast(result.error, 'error');
          return;
        }
        toast('Event saved', 'success');
        router.refresh();
        close();
      } else {
        const result = await createClubEvent(input);
        if (!result.ok) {
          toast(result.error, 'error');
          return;
        }
        toast(values.publish ? 'Event published' : 'Draft saved', 'success');
        router.push(`/events/${result.data.id}`);
      }
    } finally {
      setSaving(false);
    }
  }

  // On an event's page the form sits inside the Details section's card, so it
  // brings its own only on /events/new.
  const form = (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="Title"
        required
        maxLength={120}
        value={values.title}
        onChange={(e) => set('title', e.target.value)}
      />
      <Select
        label="Kind"
        options={KIND_OPTIONS}
        value={values.kind}
        onChange={(e) => set('kind', e.target.value)}
      />
      <Textarea
        label="Description"
        maxLength={4000}
        rows={5}
        value={values.description}
        onChange={(e) => set('description', e.target.value)}
      />
      <Input
        label="Location"
        maxLength={200}
        value={values.location}
        onChange={(e) => set('location', e.target.value)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <DateTimePicker
          label="Starts"
          required
          value={values.starts_at}
          onChange={(next) => set('starts_at', next)}
        />
        <DateTimePicker
          label="Ends"
          value={values.ends_at}
          onChange={(next) => set('ends_at', next)}
        />
        <DateTimePicker
          label="Sign-ups open"
          value={values.signup_opens_at}
          onChange={(next) => set('signup_opens_at', next)}
        />
        <DateTimePicker
          label="Sign-ups close"
          value={values.signup_closes_at}
          onChange={(next) => set('signup_closes_at', next)}
        />
        <Input
          label="Capacity"
          type="number"
          min={1}
          step={1}
          placeholder="No limit"
          value={values.capacity}
          onChange={(e) => set('capacity', e.target.value)}
        />
        <Input
          label="Cost (dollars)"
          type="number"
          min={0}
          max={1000}
          step={0.01}
          placeholder="Not shown"
          value={values.cost_dollars}
          onChange={(e) => set('cost_dollars', e.target.value)}
        />
      </div>
      <p className="text-[12px] text-[var(--mute)]">
        Times are club time. The cost is shown to members only; nothing charges for it.
      </p>
      <Checkbox
        checked={values.publish}
        onChange={(checked) => set('publish', checked)}
        label="Published: members can see it and sign up"
        showLabel
      />
      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          {eventId ? 'Save' : 'Create event'}
        </Button>
        {eventId && (
          <Button type="button" variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
  return eventId ? form : <Card>{form}</Card>;
}

/**
 * Cancel and delete. Delete is only offered with nobody signed up, and the
 * action refuses it otherwise: a cancel is what tells the people signed up.
 */
export function ClubEventControls({
  eventId,
  canCancel,
  canDelete,
}: {
  eventId: string;
  canCancel: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [reason, setReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // The reason is asked for in the dialog itself, so the page carries one
  // button rather than a reason box that is always open.
  async function handleCancel() {
    setBusy(true);
    try {
      const result = await cancelClubEvent(eventId, reason);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setCancelOpen(false);
      toast('Event cancelled', 'success');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete this event?',
      message: 'It is removed for good. Nobody has signed up.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await deleteClubEvent(eventId);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      toast('Event deleted', 'success');
      router.push('/events');
    } finally {
      setBusy(false);
    }
  }

  if (!canCancel && !canDelete) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canCancel && (
          <Button variant="danger" onClick={() => setCancelOpen(true)} disabled={busy}>
            Cancel event
          </Button>
        )}
        {canDelete && (
          <Button variant="secondary" onClick={handleDelete} loading={busy}>
            Delete event
          </Button>
        )}
      </div>
      <Dialog
        open={cancelOpen}
        onClose={() => !busy && setCancelOpen(false)}
        title="Cancel this event?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)} disabled={busy}>
              Keep event
            </Button>
            <Button variant="danger" onClick={handleCancel} loading={busy}>
              Cancel event
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--ink-2)]">
            Everyone signed up is sent a notification. A cancelled event cannot be reopened.
          </p>
          <Textarea
            label="Reason (sent to members)"
            maxLength={500}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </Dialog>
    </>
  );
}
