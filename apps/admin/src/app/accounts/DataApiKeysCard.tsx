'use client';

import { useState } from 'react';
import { Badge, Button, Card, Checkbox, DatePicker, EmptyState, Input } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import type { DataApiScope } from '@badminton/shared/src/utils/data-api-key';
import { mintDataApiKey, revokeDataApiKey, updateDataApiKeyScopes } from '@/lib/actions/data-api-keys';

// THE PANEL THAT HANDS OUT READ ACCESS TO THE CLUB'S DATA.
//
// A CLIENT COMPONENT BECAUSE THE MINTED KEY LIVES IN REACT STATE, and that is
// the only place it may live. The alternative shape, a plain form POST whose
// result is rendered by the server, puts the plaintext into server-rendered
// HTML, which Next may cache and which sits in the RSC payload. So the action
// is called from the browser and its answer is held here, in memory, for as
// long as the component is mounted and not one moment longer.
//
// NO localStorage, NO sessionStorage, NO URL FRAGMENT. Reloading loses the key
// permanently. That is not a limitation to apologise for, it is the property
// that makes "stored hashed, nobody can recover it for you" true, and the copy
// above the Mint button says so BEFORE the key is minted rather than after,
// when saying it is too late to be useful.
//
// THE HASH IS NEVER SHOWN, and more than that, the page never selects it. A
// sha256 of 32 random bytes is not brute-forceable and publishing it buys an
// attacker nothing today, but it is a credential probe, and a hidden field
// still travels in the RSC payload. The page's own comment about gated FETCHES
// rather than gated renders is the same argument.

export interface DataApiKeyRow {
  id: string;
  consumer: string;
  key_prefix: string;
  label: string | null;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  minted_by_name: string | null;
}

/**
 * Every scope, with what each one actually opens. Listed here rather than
 * imported because the shared module that holds DATA_API_SCOPES imports
 * node:crypto, which cannot reach a client bundle; the type import keeps each
 * string honest, and the server action refuses anything not in the real list.
 */
const SCOPE_CHOICES: { scope: DataApiScope; hint: string }[] = [
  { scope: 'players:read', hint: 'The roster: pseudonymous refs and lifetime ratings' },
  { scope: 'matches:read', hint: 'Match history, head to head, per-season records' },
  { scope: 'ratings:history:read', hint: 'Every recorded rating change per player' },
  { scope: 'seasons:read', hint: 'Seasons, season totals and standings' },
  { scope: 'tournaments:read', hint: 'Tournaments, events, entrants and draws' },
  { scope: 'schedule:read', hint: 'Sessions and club events, counts only' },
  {
    scope: 'predictions:write',
    hint: 'Lets this key post head-to-head win predictions. Never changes ratings.',
  },
  {
    scope: 'registrations:write',
    hint: 'Import form registrations. A write: lets a Google Form script enter non-members and ask members to confirm, only into the tournaments and events a form is bound to.',
  },
];

// The write scopes are never granted by the shortcut; each has to be ticked.
const READ_SCOPES: string[] = SCOPE_CHOICES.map((c) => c.scope).filter((s) => s.endsWith(':read'));

function ScopePicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const everything = READ_SCOPES.every((s) => selected.includes(s));
  return (
    <div className="flex flex-col gap-2">
      {SCOPE_CHOICES.map(({ scope, hint }) => (
        <div key={scope} className="flex items-baseline gap-3">
          <Checkbox
            checked={selected.includes(scope)}
            onChange={(on) =>
              onChange(on ? [...selected, scope] : selected.filter((s) => s !== scope))
            }
            label={scope}
            showLabel
          />
          <span className="text-[12px] text-[var(--mute)]">{hint}</span>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={everything}
          onClick={() => onChange([...new Set([...selected, ...READ_SCOPES])])}
        >
          All read scopes
        </Button>
      </div>
    </div>
  );
}

export function DataApiKeysCard({
  keys,
  canMint,
  canRevoke,
  canEditScopes,
}: {
  keys: DataApiKeyRow[];
  canMint: boolean;
  canRevoke: boolean;
  canEditScopes: boolean;
}) {
  const { toast } = useToast();
  const [consumerName, setConsumerName] = useState('');
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  // A key lasts until revoked unless an expiry is asked for, so the date
  // field only appears once this is unticked.
  const [neverExpires, setNeverExpires] = useState(true);
  const [scopes, setScopes] = useState<string[]>(['players:read']);
  const [minting, setMinting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Which row is asking for its reason, and what has been typed into it. A
  // revoke is not undoable from this panel, so it takes two clicks with a
  // sentence between them rather than one.
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  // The plaintext, for this render of this tab only.
  const [minted, setMinted] = useState<{ prefix: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Which live key has its scopes open for editing, and the draft.
  const [scopeTarget, setScopeTarget] = useState<string | null>(null);
  const [scopeDraft, setScopeDraft] = useState<string[]>([]);
  const [savingScopes, setSavingScopes] = useState(false);

  async function handleSaveScopes(row: DataApiKeyRow) {
    setSavingScopes(true);
    try {
      const result = await updateDataApiKeyScopes({ keyId: row.id, scopes: scopeDraft });
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setScopeTarget(null);
      toast(`${row.key_prefix} now carries ${result.data.scopes.length} scopes`, 'success');
    } finally {
      setSavingScopes(false);
    }
  }

  async function handleMint() {
    setMinting(true);
    try {
      const result = await mintDataApiKey({
        consumerName,
        label: label.trim() || null,
        scopes,
        expiresAt: neverExpires ? null : expiresAt.trim() || null,
      });
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setMinted({ prefix: result.data.prefix, key: result.data.key });
      setCopied(false);
      setConsumerName('');
      setLabel('');
      setExpiresAt('');
      setNeverExpires(true);
      setScopes(['players:read']);
      toast('Key minted. Copy it now, it is not shown again.', 'success');
    } finally {
      setMinting(false);
    }
  }

  async function handleRevoke(row: DataApiKeyRow) {
    setRevoking(row.id);
    try {
      const result = await revokeDataApiKey({ keyId: row.id, reason: revokeReason });
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setRevokeTarget(null);
      setRevokeReason('');
      toast(`${row.key_prefix} revoked`, 'success');
    } finally {
      setRevoking(null);
    }
  }

  async function handleCopy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.key);
      setCopied(true);
    } catch {
      // A clipboard refusal is silent otherwise, and the key is selectable in
      // the box above, so say which one happened.
      toast('The browser refused the clipboard. Select the key and copy it by hand.', 'error');
    }
  }

  return (
    <Card>
      <div>
        <h2
          className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
          style={{ fontFamily: 'var(--display)' }}
        >
          Data API keys
        </h2>
        <p className="mt-1 text-[13px] text-[var(--mute)]">
          Keys for outside consumers. Each key sees pseudonyms, never names. Only predictions:write and registrations:write let a key write anything.
        </p>
      </div>

      {minted && (
        // THE ONE AND ONLY SHOWING. Dismissing clears it from state; so does a
        // reload, a navigation, or closing the tab.
        <div className="mt-4 border border-[var(--red-border)] bg-[var(--red-wash)] p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink)]">
            Copy this now. It is not stored and cannot be shown again.
          </p>
          <code className="mt-3 block break-all border border-[var(--line)] bg-[var(--bg)] p-3 text-[13px] text-[var(--ink)]">
            {minted.key}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy key'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMinted(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {canMint && (
        <div className="mt-5 border-t border-[var(--line)] pt-4">
          <p className="text-[13px] text-[var(--mute)]">
            The key is shown once, here, and nowhere else. Nothing in this system can
            recover it afterwards: a lost key is revoked and reissued, which is why
            it has to be copied out of this page before leaving it.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Input
              label="Consumer"
              value={consumerName}
              onChange={(e) => setConsumerName(e.target.value)}
              placeholder="Who is receiving this key"
            />
            <Input
              label="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Optional, e.g. laptop script"
            />
            <div className="flex flex-col gap-2">
              {!neverExpires && (
                <DatePicker
                  label="Expires"
                  value={expiresAt}
                  onChange={setExpiresAt}
                  min={tomorrowIso()}
                  placeholder="Pick the last day"
                />
              )}
              <Checkbox
                label="Never expires"
                showLabel
                checked={neverExpires}
                onChange={(checked) => {
                  setNeverExpires(checked);
                  if (checked) setExpiresAt('');
                }}
              />
            </div>
          </div>
          <div className="mt-4">
            <ScopePicker selected={scopes} onChange={setScopes} />
          </div>
          <div className="mt-4">
            <Button
              onClick={handleMint}
              loading={minting}
              disabled={consumerName.trim() === '' || scopes.length === 0 || (!neverExpires && expiresAt === '')}
            >
              Mint key
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-[var(--line)] pt-4">
        {keys.length === 0 ? (
          <EmptyState
            title="No keys have been issued"
            description="Nothing outside the club is reading the data API."
          />
        ) : (
          <ul className="flex flex-col">
            {keys.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-2 border-t border-[var(--line)] py-3.5 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] text-[var(--ink)]">
                      {row.key_prefix}
                    </span>
                    <span className="text-[13px] text-[var(--ink)]">{row.consumer}</span>
                    {row.revoked_at ? (
                      <Badge variant="danger">Revoked</Badge>
                    ) : isExpired(row.expires_at) ? (
                      <Badge variant="warning">Expired</Badge>
                    ) : (
                      <Badge variant="success">Live</Badge>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--mute)]">
                    {row.scopes.join(' · ')}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--mute)]">
                    {row.label ? `${row.label} · ` : ''}
                    minted {shortDate(row.created_at)}
                    {row.minted_by_name ? ` by ${row.minted_by_name}` : ''}
                    {row.expires_at ? ` · expires ${shortDate(row.expires_at)}` : ''}
                    {row.revoked_at ? ` · revoked ${shortDate(row.revoked_at)}` : ''}
                  </div>
                  {scopeTarget === row.id && (
                    <div className="mt-3">
                      <ScopePicker selected={scopeDraft} onChange={setScopeDraft} />
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          loading={savingScopes}
                          disabled={scopeDraft.length === 0}
                          onClick={() => handleSaveScopes(row)}
                        >
                          Save scopes
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setScopeTarget(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  {canEditScopes && !row.revoked_at && !isExpired(row.expires_at) && scopeTarget !== row.id && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setScopeTarget(row.id);
                        setScopeDraft([...row.scopes]);
                      }}
                    >
                      Edit scopes
                    </Button>
                  )}
                  {canRevoke && !row.revoked_at && (
                    revokeTarget === row.id ? (
                      <div className="flex shrink-0 flex-col gap-2 sm:w-[260px]">
                        <Input
                          value={revokeReason}
                          onChange={(e) => setRevokeReason(e.target.value)}
                          placeholder="Why is this key being turned off"
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="danger"
                            loading={revoking === row.id}
                            onClick={() => handleRevoke(row)}
                          >
                            Confirm revoke
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRevokeTarget(null);
                              setRevokeReason('');
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setRevokeTarget(row.id);
                          setRevokeReason('');
                        }}
                      >
                        Revoke
                      </Button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// The earliest expiry the database accepts: it must fall after the key's
// creation, so today is already too late.
function tomorrowIso(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const day = String(tomorrow.getDate()).padStart(2, '0');
  return `${tomorrow.getFullYear()}-${month}-${day}`;
}

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
