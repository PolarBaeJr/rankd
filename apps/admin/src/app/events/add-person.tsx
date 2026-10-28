'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button, Dialog, Input, PlayerPicker, Select, Tabs, type PlayerOption } from '@badminton/ui';
import { PAYMENT_METHODS, PAYMENT_METHOD_CUSTOM, isReservedMethod, resolvePaymentMethod } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { addClubEventPersonByHand, loadClubEventHandQuestions } from '@/lib/actions/club-event-add';

// Somebody added by hand (00306): a member, or a guest by name alone, who paid
// at the door or does not use the app. Every answer is optional, the Form's
// required ones too, and no waiver is asked for.

const NOT_PAID = 'not_paid';

export function AddPersonButton({
  eventId,
  members,
  costCents,
  canMarkPaid,
}: {
  eventId: string;
  members: PlayerOption[];
  costCents: number | null;
  canMarkPaid: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <UserPlus className="h-3.5 w-3.5" /> Add person
      </Button>
      {open && (
        <AddPersonDialog
          eventId={eventId}
          members={members}
          costCents={costCents}
          canMarkPaid={canMarkPaid}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AddPersonDialog({
  eventId,
  members,
  costCents,
  canMarkPaid,
  onClose,
}: {
  eventId: string;
  members: PlayerOption[];
  costCents: number | null;
  canMarkPaid: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const charged = (costCents ?? 0) > 0;
  const [kind, setKind] = useState<'member' | 'guest'>('guest');
  const [playerId, setPlayerId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [partner, setPartner] = useState('');
  const [photos, setPhotos] = useState<'' | 'yes' | 'no'>('');
  const [method, setMethod] = useState(charged && canMarkPaid ? 'cash' : NOT_PAID);
  const [customMethod, setCustomMethod] = useState('');
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [questionsNote, setQuestionsNote] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function showQuestions() {
    setQuestionsNote('Reading the Form...');
    const result = await loadClubEventHandQuestions(eventId);
    if (!result.ok) {
      setQuestionsNote(result.error);
      return;
    }
    setQuestions(result.data.questions);
    setQuestionsNote(result.data.note ?? (result.data.questions.length === 0 ? 'The Form asks nothing else.' : null));
  }

  async function save() {
    setError(null);
    if (kind === 'member' && !playerId) return setError('Pick a member.');
    if (kind === 'guest' && !name.trim()) return setError('Type their name.');
    const paidMethod =
      method === NOT_PAID ? undefined : resolvePaymentMethod(method, customMethod);
    if (method === PAYMENT_METHOD_CUSTOM && !paidMethod) return setError('Type how they paid.');
    if (paidMethod && isReservedMethod(paidMethod)) return setError('"waived" is not a payment.');
    const filled = Object.fromEntries(
      Object.entries(answers)
        .map(([question, answer]) => [question, answer.trim()])
        .filter(([, answer]) => answer !== ''),
    );
    const common = {
      ...(partner.trim() ? { partner: partner.trim() } : {}),
      ...(Object.keys(filled).length > 0 ? { answers: filled } : {}),
      ...(paidMethod ? { paidMethod } : {}),
    };
    setSaving(true);
    try {
      const result = await addClubEventPersonByHand(
        eventId,
        kind === 'member'
          ? { kind: 'member', playerId, ...common }
          : {
              kind: 'guest',
              name: name.trim(),
              ...(email.trim() ? { email: email.trim() } : {}),
              ...(photos ? { mediaConsent: photos === 'yes' } : {}),
              ...common,
            },
      );
      if (!result.ok) return setError(result.error);
      const who = kind === 'member' ? (members.find((m) => m.id === playerId)?.name ?? 'The member') : name.trim();
      toast(result.data.paid ? `${who} is signed up and paid.` : `${who} is signed up.`, 'success');
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
      title="Add a person"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            <UserPlus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Tabs
          variant="subtle"
          activeTab={kind}
          onChange={(id) => {
            setKind(id as 'member' | 'guest');
            setError(null);
          }}
          tabs={[
            { id: 'guest', label: 'No account' },
            { id: 'member', label: 'Member' },
          ]}
        />
        {kind === 'member' ? (
          <PlayerPicker
            label="Member"
            value={playerId}
            onChange={setPlayerId}
            players={members}
            placeholder="Search a name"
          />
        ) : (
          <>
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="off"
              placeholder="Their full name"
            />
            <Input
              label="Email (optional)"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              autoComplete="off"
              placeholder="Leave empty if they have none"
            />
            <Select
              label="Photos and video (optional)"
              value={photos}
              onChange={(event) => setPhotos(event.target.value as '' | 'yes' | 'no')}
              options={[
                { value: '', label: 'Not asked' },
                { value: 'yes', label: 'Allowed' },
                { value: 'no', label: 'Not allowed' },
              ]}
            />
          </>
        )}

        <Input
          label="Preferred partner (optional)"
          value={partner}
          onChange={(event) => setPartner(event.target.value)}
          maxLength={120}
          autoComplete="off"
        />

        {charged && (
          <div className="space-y-2">
            <Select
              label={`Payment ($${((costCents ?? 0) / 100).toFixed(2)})`}
              value={method}
              disabled={!canMarkPaid}
              onChange={(event) => {
                setMethod(event.target.value);
                if (event.target.value !== PAYMENT_METHOD_CUSTOM) setCustomMethod('');
              }}
              options={[
                ...PAYMENT_METHODS.map((m) => ({
                  value: m.value,
                  label: m.value === PAYMENT_METHOD_CUSTOM ? 'Paid another way' : `Paid by ${m.label.toLowerCase()}`,
                })),
                { value: NOT_PAID, label: 'Not paid yet' },
              ]}
            />
            {method === PAYMENT_METHOD_CUSTOM && (
              <Input
                label="How they paid"
                value={customMethod}
                onChange={(event) => setCustomMethod(event.target.value)}
                maxLength={60}
                placeholder="e.g. cheque"
              />
            )}
            {!canMarkPaid && (
              <p className="text-xs text-[var(--text-muted)]">
                Marking a fee paid needs the fees permission, so they are added unpaid.
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          {questions === null ? (
            <Button variant="ghost" size="sm" onClick={showQuestions} disabled={questionsNote === 'Reading the Form...'}>
              Answer the Form&apos;s other questions
            </Button>
          ) : (
            questions.map((question) => (
              <Input
                key={question}
                label={question}
                value={answers[question] ?? ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [question]: event.target.value }))}
                maxLength={2000}
                autoComplete="off"
                placeholder="Skip if not asked"
              />
            ))
          )}
          {questionsNote && <p className="text-xs text-[var(--text-muted)]">{questionsNote}</p>}
        </div>

        <p className="text-xs text-[var(--text-muted)]">
          Everything but the name can be left empty. No waiver is asked for. If the event later runs as a
          tournament, they are entered in it like everybody else.
        </p>
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
