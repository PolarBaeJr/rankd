'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Switch, Textarea } from '@badminton/ui';
// Deep import, NOT the '@badminton/shared' barrel — the barrel re-exports the
// mail sender, which drags `resend` and a Supabase client behind it. This is a
// CLIENT component; pulling those into the browser bundle for two constant
// tables is the same mistake lib/permissions.ts documents for the edge
// middleware.
import { EVENT_MULTIPLIERS, FORMAT_WEIGHTS } from '@badminton/shared/src/elo/engine';
import { FORMAT_RULES, derivedFormatWeight } from '@badminton/shared';
import { useToast } from '@/components/toast-provider';
import { updatePlatformSettings } from '@/lib/actions';
import { FIELD_META, type PlatformSetting } from '@/lib/platform-setting-fields';
import { RATINGS_SECTIONS, leftoversFor, type RatingsSectionDef } from '@/lib/ratings-sections';

/**
 * Mirrors REASON_MIN in lib/actions/settings.ts. The server is the boundary;
 * this only decides when Save stops being disabled, so that a reason nobody
 * wrote is never even submittable.
 */
const REASON_MIN = 5;
const enoughReason = (reason: string) => reason.trim().length >= REASON_MIN;

/** Every control in the save bar clears the console's 44px touch floor. */
const TOUCH = 'min-h-[44px]';

const MONO_LABEL = 'font-mono text-[10px] uppercase tracking-[.16em] text-[var(--mute)]';

type FieldValue = string | boolean;
type Edits = Record<string, Record<string, FieldValue>>;

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** The house row: name over explanation on the left, one control on the right. */
function SettingRow({
  name,
  hint,
  edited,
  children,
}: {
  name: string;
  hint?: string;
  edited?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--line)] px-4 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-[var(--ink)]">
          {name}
          {edited && (
            <span className={`${MONO_LABEL} ml-2 text-[var(--color-warning)]`}>Modified</span>
          )}
        </div>
        {hint && (
          <p className="mt-1 max-w-[52ch] text-[13px] leading-[1.5] text-[var(--mute)]">{hint}</p>
        )}
      </div>
      <div className="w-full shrink-0 sm:w-[200px]">{children}</div>
    </div>
  );
}

/** A read-only figure: same row shape, no control. */
function ReferenceRow({ name, hint, value }: { name: string; hint?: string; value: string }) {
  return (
    <SettingRow name={name} hint={hint}>
      <div className="font-mono text-[15px] text-[var(--ink)] sm:text-right">{value}</div>
    </SettingRow>
  );
}

/* ------------------------------------------------------------------ *
 * Match weighting — the reference section
 * ------------------------------------------------------------------ */

const FORMAT_LABELS: Record<string, string> = {
  bo3_21: 'Best of 3 to 21',
  single_21: 'One game to 21',
  single_15: 'One game to 15',
  single_11: 'One game to 11',
};

const EVENT_LABELS: Record<string, string> = {
  rated_challenge: 'Ladder challenge',
  trial: 'Trial match',
  tournament: 'Tournament match',
  admin_entered: 'Entered by an officer',
  casual: 'Casual session match',
};

// Read off the engine rather than retyped, so this table cannot drift from the
// numbers that actually multiply a rating change. The SQL side
// (get_format_weight / get_event_multiplier, 00003) holds the same values and
// is IMMUTABLE — which is exactly why these are shown and not offered as
// fields: there is no platform_settings key behind any of them, and a box that
// saves nowhere would be a lie about what this console controls.
function MatchWeighting() {
  return (
    <>
      <p className="border-t border-[var(--line)] px-4 py-4 text-[13px] leading-[1.5] text-[var(--mute)]">
        Fixed in the engine, not configurable here. A match&rsquo;s rating change is
        multiplied by its format weight and its event multiplier before the
        K-factor is applied. Changing any of these needs a migration, because the
        same numbers are compiled into the database. These weights are the same
        for every season; there is no per-season override.
      </p>
      {/* The panel drew only the enum column and said the SQL side held the
          same values, which is true of the branch it drew and silent about the
          other one. */}
      <p className="border-t border-[var(--line)] px-4 py-4 text-[13px] leading-[1.5] text-[var(--mute)]">
        Two of these have a second value. A match that carries its own
        points-per-game is weighed by formula rather than by this table, so the
        short formats are priced slightly differently depending on how the match
        was created. Both are intentional and the ladder applies whichever
        matches the match; the second figure is shown beside the rows it affects.
      </p>
      {Object.entries(FORMAT_WEIGHTS).map(([format, weight]) => {
        // THE SECOND BRANCH, which this panel used to draw no trace of.
        //
        // trigger_set_match_weights (00031) picks the table only when
        // `points_per_game IS NULL`. A match with a typed shape — every custom
        // challenge, everything knockoutLadder() stamps, every per-round
        // override — is weighed by derivedFormatWeight instead, and the two
        // disagree on the short formats: one game to 15 is 0.75 by table and
        // 0.71 by formula. That is a deliberate 2026-08-17 ruling, locked by a
        // test in engine.test.ts, not a bug to reconcile here. But an officer
        // reading only the table was being told 0.75 about matches the ladder
        // had priced at 0.71, so the panel now shows both where they differ.
        // Object.entries widens the key to string; FORMAT_WEIGHTS and
        // FORMAT_RULES are both keyed by MatchFormat, so the lookup is total.
        const rules = FORMAT_RULES[format as keyof typeof FORMAT_RULES] as
          | { bestOf: number; target: number }
          | undefined;
        const derived = rules ? derivedFormatWeight(rules.bestOf, rules.target) : null;
        const differs = derived !== null && Math.abs(derived - weight) > 0.005;
        return (
          <ReferenceRow
            key={format}
            name={FORMAT_LABELS[format] ?? format}
            hint={
              differs
                ? `${derived.toFixed(4).replace(/0+$/, '')} when the match carries its own points-per-game, which every custom and tournament-round shape does.`
                : undefined
            }
            value={weight.toFixed(2)}
          />
        );
      })}
      {Object.entries(EVENT_MULTIPLIERS).map(([event, multiplier]) => (
        <ReferenceRow
          key={event}
          name={EVENT_LABELS[event] ?? event}
          hint={
            multiplier === 0
              ? 'Zero, so a casual match never moves a rating at all. It still goes on the record.'
              : undefined
          }
          value={multiplier.toFixed(2)}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The rail
 * ------------------------------------------------------------------ */

function SectionRail({ sections, active }: { sections: RatingsSectionDef[]; active: string }) {
  return (
    // `hidden md:flex md:flex-col` is load-bearing: .settings-rail must not set
    // display, or the sticky rail renders on phones over the content beneath.
    <nav
      aria-label="Sections"
      className="settings-rail hidden border-l border-[var(--line)] md:flex md:flex-col md:sticky md:self-start"
    >
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          // -ml-px pulls the 2px active border over the rail's hairline rather
          // than sitting beside it.
          className={`-ml-px font-mono text-[10px] uppercase tracking-[.14em] ${
            s.id === active ? 'active text-[var(--ink)]' : 'text-[var(--mute)]'
          }`}
          aria-current={s.id === active ? 'true' : undefined}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

export function RatingsForm({
  settings,
  canWrite,
  aside,
}: {
  settings: PlatformSetting[];
  /** platform.settings.write. Read-only is a real state here, not a disabled page. */
  canWrite: boolean;
  /** Server-rendered right-hand column — see ratings-aside.tsx. */
  aside: React.ReactNode;
}) {
  const [edits, setEdits] = useState<Edits>({});
  const [jsonEdits, setJsonEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState(RATINGS_SECTIONS[0]!.id);
  // One Edit for the whole page, never one per row: the edits batch under one
  // reason and one Save. Until it is pressed every setting reads as a figure.
  const [editing, setEditing] = useState(false);
  const writable = canWrite && editing;
  const { toast } = useToast();

  const byKey = useMemo(() => {
    const map = new Map<string, PlatformSetting>();
    for (const s of settings) map.set(s.key, s);
    return map;
  }, [settings]);

  const leftovers = useMemo(() => leftoversFor(settings), [settings]);

  // Only render a section whose key is actually present — a club whose
  // tournament_bonuses row was deleted should lose the section, not show nine
  // controls bound to nothing.
  const sections = useMemo(
    () =>
      RATINGS_SECTIONS.filter(
        (s) => s.reference || s.fields.some((f) => byKey.get(f.key)?.value[f.field] !== undefined)
      ),
    [byKey]
  );

  const railSections = useMemo(
    () =>
      leftovers.fields.length > 0 || leftovers.rawKeys.length > 0
        ? [...sections, { id: 'other', label: 'Other settings', fields: [] } as RatingsSectionDef]
        : sections,
    [sections, leftovers]
  );

  const sectionIds = useMemo(() => railSections.map((s) => s.id), [railSections]);

  // Scroll-spy for the rail. rootMargin pins the "current" line just under the
  // sticky console header, where a rail link's scroll-mt lands a section, so a
  // section counts as active once its heading reaches it rather than when it is
  // centred. Read from the same two CSS variables, so the line cannot drift.
  useEffect(() => {
    const nodes = sectionIds
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0) return;
    const css = getComputedStyle(document.documentElement);
    const line =
      (parseFloat(css.getPropertyValue('--console-header-h')) || 0) +
      (parseFloat(css.getPropertyValue('--sticky-gap')) || 0);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { rootMargin: `-${line}px 0px -70% 0px`, threshold: 0 }
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [sectionIds]);

  function setField(key: string, field: string, next: FieldValue, original: FieldValue) {
    setEdits((prev) => {
      const forKey = { ...(prev[key] ?? {}) };
      // Typing the saved value back drops the edit, so the count and the Save
      // button clear without an explicit reset.
      if (next === original) delete forKey[field];
      else forKey[field] = next;
      const nextState = { ...prev };
      if (Object.keys(forKey).length === 0) delete nextState[key];
      else nextState[key] = forKey;
      return nextState;
    });
  }

  const changeCount =
    Object.values(edits).reduce((n, fields) => n + Object.keys(fields).length, 0) +
    Object.keys(jsonEdits).length;
  const hasChanges = changeCount > 0;

  function discard() {
    setEdits({});
    setJsonEdits({});
    setReason('');
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updates: { key: string; value: Record<string, unknown> }[] = [];

      for (const [key, fields] of Object.entries(edits)) {
        // Overlay onto the saved blob so untouched fields survive: the action
        // writes the whole JSONB value per key.
        const value: Record<string, unknown> = { ...(byKey.get(key)?.value ?? {}) };
        for (const [field, raw] of Object.entries(fields)) {
          const meta = FIELD_META[key]?.[field];
          if (meta?.type === 'boolean' || typeof raw === 'boolean') {
            value[field] = raw === true;
            continue;
          }
          // `select` rides with `text` in both places this file asks. This
          // screen's bespoke three-column layout draws no select today — the
          // only one in FIELD_META is signup_settings, which lands on /accounts
          // — but the fallback below is a NUMBER, so a select arriving here
          // without this line would be parsed as one and refused as "must be a
          // number". Cheaper to answer the question now than to leave a trap
          // for whoever adds the second select.
          if (meta && (meta.type === 'text' || meta.type === 'select')) {
            value[field] = raw;
            continue;
          }
          const str = String(raw).trim();
          if (str === '') {
            if (meta?.nullable) {
              value[field] = null;
              continue;
            }
            toast(`${meta?.label ?? field} requires a value`, 'error');
            setSaving(false);
            return;
          }
          const num = Number(str);
          if (!Number.isFinite(num)) {
            toast(`${meta?.label ?? field} must be a number`, 'error');
            setSaving(false);
            return;
          }
          value[field] = num;
        }
        updates.push({ key, value });
      }

      for (const [key, valueStr] of Object.entries(jsonEdits)) {
        try {
          updates.push({ key, value: JSON.parse(valueStr) });
        } catch {
          toast(`Invalid JSON for ${key}`, 'error');
          setSaving(false);
          return;
        }
      }

      await updatePlatformSettings(updates, reason);
      toast('Rating settings saved', 'success');
      discard();
      setEditing(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
    setSaving(false);
  }

  function renderControl(key: string, field: string) {
    const meta = FIELD_META[key]?.[field];
    const raw = byKey.get(key)?.value[field];
    const isBoolean = meta ? meta.type === 'boolean' : typeof raw === 'boolean';

    if (isBoolean) {
      const original = raw === true;
      const checked = (edits[key]?.[field] as boolean | undefined) ?? original;
      return (
        <Switch
          checked={checked}
          disabled={!canWrite}
          label={meta?.label ?? field}
          onChange={(next) => setField(key, field, next, original)}
          className="justify-start sm:justify-end"
        />
      );
    }

    const original = raw == null ? '' : String(raw);
    const current = (edits[key]?.[field] as string | undefined) ?? original;
    return (
      <Input
        type={meta && (meta.type === 'text' || meta.type === 'select') ? 'text' : 'number'}
        value={current}
        min={meta?.min}
        max={meta?.max}
        step={meta?.step}
        disabled={!canWrite}
        aria-label={meta?.label ?? field}
        onChange={(e) => setField(key, field, e.target.value, original)}
        className="font-mono sm:text-right"
      />
    );
  }

  /** The saved value as text, for the read view: On/Off, or "Not set" for nothing. */
  function readValue(key: string, field: string): string {
    const meta = FIELD_META[key]?.[field];
    const raw = byKey.get(key)?.value[field];
    if (meta ? meta.type === 'boolean' : typeof raw === 'boolean') return raw === true ? 'On' : 'Off';
    return raw == null || raw === '' ? 'Not set' : String(raw);
  }

  function renderFieldRow(key: string, field: string) {
    const meta = FIELD_META[key]?.[field];
    if (!writable) {
      return (
        <ReferenceRow
          key={`${key}.${field}`}
          name={meta?.label ?? `${key}.${field}`}
          hint={meta?.hint}
          value={readValue(key, field)}
        />
      );
    }
    return (
      <SettingRow
        key={`${key}.${field}`}
        name={meta?.label ?? `${key}.${field}`}
        hint={meta?.hint}
        edited={field in (edits[key] ?? {})}
      >
        {renderControl(key, field)}
      </SettingRow>
    );
  }

  return (
    <div>
      <div className="grid items-start gap-6 pb-[120px] md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <SectionRail sections={railSections} active={active} />

        <div className="flex min-w-0 flex-col gap-5">
          {!canWrite && (
            <p className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--mute)]">
              You can read these settings but not change them.
            </p>
          )}
          {canWrite && !editing && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
              <p className="text-[13px] text-[var(--mute)]">
                Every change is logged with your name and a reason.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </div>
          )}

          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-[calc(var(--console-header-h)+var(--sticky-gap))] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
            >
              <h2 className={`${MONO_LABEL} px-4 pt-4 pb-3`}>{section.label}</h2>
              {section.reference ? (
                <MatchWeighting />
              ) : (
                section.fields
                  .filter((f) => byKey.get(f.key)?.value[f.field] !== undefined)
                  .map((f) => renderFieldRow(f.key, f.field))
              )}
            </section>
          ))}

          {(leftovers.fields.length > 0 || leftovers.rawKeys.length > 0) && (
            <section
              id="other"
              className="scroll-mt-[calc(var(--console-header-h)+var(--sticky-gap))] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
            >
              <h2 className={`${MONO_LABEL} px-4 pt-4 pb-3`}>Other settings</h2>
              {/* A key or field added by a later migration that nobody wired
                  into the layout above. Rendered generically rather than
                  dropped: a setting that silently disappears from the console
                  is the failure this codebase keeps paying for. */}
              <p className="border-t border-[var(--line)] px-4 py-4 text-[13px] leading-[1.5] text-[var(--mute)]">
                Rating settings this page has no layout for yet. They are still
                saved and still live.
              </p>
              {leftovers.fields.map((f) => renderFieldRow(f.key, f.field))}
              {leftovers.rawKeys.map((key) => {
                const row = byKey.get(key);
                if (!row) return null;
                const current = jsonEdits[key] ?? JSON.stringify(row.value, null, 2);
                return (
                  <SettingRow key={key} name={key} edited={key in jsonEdits}>
                    {!writable ? (
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-[var(--ink)]">
                        {current}
                      </pre>
                    ) : (
                      <Textarea
                        value={current}
                        aria-label={key}
                        onChange={(e) =>
                          setJsonEdits((prev) => ({ ...prev, [key]: e.target.value }))
                        }
                        rows={Math.min(Object.keys(row.value).length + 2, 8)}
                        className="font-mono text-xs"
                      />
                    )}
                  </SettingRow>
                );
              })}
            </section>
          )}
        </div>

        <div className="min-w-0 md:col-span-2 xl:col-span-1">{aside}</div>
      </div>

      {writable && (
        // Bleeds to the shell's edges. The width has to pay for the bleed as
        // well as the margin, or the bar sits a gutter short on the right.
        <div className="sticky bottom-0 z-30 -mx-6 w-[calc(100%+3rem)] border-t border-[var(--line)] bg-[var(--surface-2)] px-6 py-4 lg:-mx-8 lg:w-[calc(100%+4rem)] lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            {/* Input brings its own wrapper div and takes no class for it, so
                the 520px cap lives on a wrapper of ours. */}
            <div className="w-full min-w-0 max-w-[520px] flex-1">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Reason (required)"
                placeholder="Reason (required) — every rating change is logged with your name."
              />
            </div>
            {hasChanges && (
              <span className="font-mono text-[10px] uppercase tracking-[.14em] text-[var(--color-warning)]">
                {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
              </span>
            )}
            <div className="flex-1" />
            <Button
              variant="ghost"
              className={TOUCH}
              disabled={saving}
              onClick={() => {
                discard();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            {/* "Save and recalculate" was the design's label. Nothing in this
                product recalculates a rating, so the button says what it does.
                Disabled until something changed AND a real reason is typed. */}
            <Button
              className={TOUCH}
              loading={saving}
              disabled={!hasChanges || !enoughReason(reason)}
              onClick={handleSave}
            >
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
