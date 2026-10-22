'use client';

import { useState } from 'react';
import {
  Button,
  DetailList,
  DetailRow,
  EditableSectionContent,
  EditableSectionProvider,
  EditableSectionToggle,
  Input,
  Select,
  Textarea,
  useEditableSection,
} from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { updatePlatformSettings } from '@/lib/actions';
// IMPORTED, NOT REDECLARED. /ratings and /seasons each copied this number into
// their own file and the console now has three literal 5s that have to be kept
// in step by hand; this is the shared one, and it is a plain module with no
// 'use server' so a client component may read it.
import { REASON_MIN } from '@/lib/audit-reason';
// Labels, descriptions and field metadata moved to lib/ so that /ratings, which
// draws the same JSONB rows in its own layout, cannot describe a field
// differently from the way this form describes it.
import {
  FIELD_META,
  SETTING_DESCRIPTIONS,
  SETTING_LABELS,
  type FieldMeta,
  type PlatformSetting,
} from '@/lib/platform-setting-fields';
import { ADORNMENT_PREFIX, joinAdorned, splitAdorned } from '@/lib/prefixed-url';
import { SettingTile } from '@/components/setting-tile';

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isStructured(s: PlatformSetting): boolean {
  const keyMeta = FIELD_META[s.key];
  return (
    !!keyMeta && Object.entries(s.value).every(([field, v]) => keyMeta[field] && isScalar(v))
  );
}

function fieldsOf(s: PlatformSetting): [string, FieldMeta][] {
  const keyMeta = FIELD_META[s.key] ?? {};
  return Object.entries(keyMeta).filter(([field]) => field in s.value);
}

/** A saved value as text: On/Off for a switch, a select's label, '' for nothing. */
function displayValue(raw: unknown, fm: FieldMeta): string {
  if (fm.type === 'boolean') return raw === true ? 'On' : 'Off';
  if (raw == null) return '';
  const text = String(raw);
  if (fm.type === 'select') return fm.options?.find((o) => o.value === text)?.label ?? text;
  return text;
}

/* Pill settings toggle, hairline track;
   ON = red knob on red-tinted track, OFF = gray knob on dark track. */
function SettingsToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
        checked
          ? 'border-[var(--red-border)] bg-[var(--red-wash)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full transition-transform ${
          checked
            ? 'translate-x-[22px] bg-[var(--color-accent)]'
            : 'translate-x-1 bg-[var(--text-muted)]'
        }`}
      />
    </button>
  );
}

type FieldValue = string | boolean;

/**
 * How the rows are drawn. Saving is the same in every one: edits batch, and
 * one reason and one Save cover them all.
 *
 *   rows     label and hint left, control right (the default)
 *   tiles    a grid of switches with a summary each (Member pages)
 *   grouped  a sub-nav of the groups beside every group's rows (Account rules)
 *   links    labelled inputs in a two-column grid, URL prefixes drawn (Club links)
 */
export type PlatformSettingsLayout = 'rows' | 'tiles' | 'grouped' | 'links';

// Renders whichever platform_settings rows it is handed — the caller decides
// which section owns which key (see lib/platform-setting-sections.ts). It knows
// the labels and field metadata for all of them, so the same component serves
// both Ratings and Accounts.
//
// Each instance reads as text until its own Edit is pressed. The editor is
// mounted only while editing, so Cancel drops every unsaved edit with it.
export function PlatformSettingsForm({
  settings,
  layout = 'rows',
}: {
  settings: PlatformSetting[];
  layout?: PlatformSettingsLayout;
}) {
  return (
    <EditableSectionProvider>
      <EditableSectionContent
        read={<PlatformSettingsSummary settings={settings} />}
        form={<PlatformSettingsEditor settings={settings} layout={layout} />}
      />
    </EditableSectionProvider>
  );
}

function PlatformSettingsSummary({ settings }: { settings: PlatformSetting[] }) {
  return (
    <div>
      <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-4">
        <p className="settings-section-desc !mb-0">
          Changes apply to every player immediately and are recorded in the audit log.
        </p>
        <EditableSectionToggle />
      </div>
      <div className="mt-5 flex flex-col gap-6">
        {settings.map((s) => (
          <div key={s.key}>
            <div className="settings-group-heading">{SETTING_LABELS[s.key] || s.key}</div>
            {isStructured(s) ? (
              <DetailList className="mt-3">
                {fieldsOf(s).map(([field, fm]) => (
                  <DetailRow key={field} label={fm.label} value={displayValue(s.value[field], fm)} />
                ))}
              </DetailList>
            ) : (
              <pre className="mt-3 whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3 font-mono text-xs text-[var(--text-secondary)]">
                {JSON.stringify(s.value, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformSettingsEditor({
  settings,
  layout,
}: {
  settings: PlatformSetting[];
  layout: PlatformSettingsLayout;
}) {
  const { close } = useEditableSection();
  const [fieldEdits, setFieldEdits] = useState<Record<string, Record<string, FieldValue>>>({});
  const [jsonEdits, setJsonEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  /**
   * Mirrors the floor updatePlatformSettings enforces. The server is the
   * boundary; this only decides when Save stops being disabled, so a reason
   * nobody wrote is never even submittable.
   */
  const enoughReason = reason.trim().length >= REASON_MIN;

  function handleFieldChange(key: string, field: string, next: FieldValue, original: FieldValue) {
    setFieldEdits((prev) => {
      const forKey = { ...(prev[key] ?? {}) };
      // Reverting to the saved value drops the edit so the Modified badge
      // and Save button clear without an explicit reset.
      if (next === original) {
        delete forKey[field];
      } else {
        forKey[field] = next;
      }
      const nextState = { ...prev };
      if (Object.keys(forKey).length === 0) delete nextState[key];
      else nextState[key] = forKey;
      return nextState;
    });
  }

  async function handleSave() {
    setLoading(true);
    try {
      const updates: { key: string; value: Record<string, unknown> }[] = [];

      for (const [key, fields] of Object.entries(fieldEdits)) {
        const setting = settings.find((s) => s.key === key);
        // Overlay edits on the saved blob so untouched fields survive and the
        // server action still receives the full JSONB value per key.
        const value: Record<string, unknown> = { ...(setting?.value ?? {}) };
        for (const [field, raw] of Object.entries(fields)) {
          const meta = FIELD_META[key]?.[field];
          // A select saves the string it was given, exactly as text does — the
          // control is what restricts the vocabulary, not this.
          if (!meta || meta.type === 'text' || meta.type === 'select') {
            value[field] = raw;
            continue;
          }
          if (meta.type === 'boolean') {
            value[field] = raw === true;
            continue;
          }
          const str = String(raw).trim();
          if (str === '') {
            if (meta.nullable) {
              value[field] = null;
              continue;
            }
            toast(`${meta.label} requires a value`, 'error');
            setLoading(false);
            return;
          }
          const num = Number(str);
          if (!Number.isFinite(num)) {
            toast(`${meta.label} must be a number`, 'error');
            setLoading(false);
            return;
          }
          value[field] = num;
        }
        updates.push({ key, value });
      }

      for (const [key, valueStr] of Object.entries(jsonEdits)) {
        try {
          const parsed = JSON.parse(valueStr);
          updates.push({ key, value: parsed });
        } catch {
          toast(`Invalid JSON for ${key}`, 'error');
          setLoading(false);
          return;
        }
      }

      if (updates.length === 0) {
        toast('No changes to save', 'info');
        setLoading(false);
        return;
      }

      await updatePlatformSettings(updates, reason);
      toast('Settings saved', 'success');
      setLoading(false);
      close();
      return;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
    setLoading(false);
  }

  const hasChanges = Object.keys(fieldEdits).length > 0 || Object.keys(jsonEdits).length > 0;

  function isEdited(key: string, field: string): boolean {
    return field in (fieldEdits[key] ?? {});
  }

  function booleanState(
    s: PlatformSetting,
    field: string,
  ): { original: boolean; checked: boolean } {
    const original = s.value[field] === true;
    return {
      original,
      checked: (fieldEdits[s.key]?.[field] as boolean | undefined) ?? original,
    };
  }

  function textState(s: PlatformSetting, field: string): { original: string; current: string } {
    const raw = s.value[field];
    const original = raw == null ? '' : String(raw);
    return {
      original,
      current: (fieldEdits[s.key]?.[field] as string | undefined) ?? original,
    };
  }

  // `wide` fills the control's column instead of sizing to the value.
  function renderControl(
    s: PlatformSetting,
    field: string,
    fm: FieldMeta,
    wide = false,
  ): React.ReactNode {
    if (fm.type === 'boolean') {
      const { original, checked } = booleanState(s, field);
      return (
        <SettingsToggle
          checked={checked}
          label={fm.label}
          onChange={(next) => handleFieldChange(s.key, field, next, original)}
        />
      );
    }
    const { original, current } = textState(s, field);
    if (fm.type === 'select' && fm.options) {
      // A VALUE THE OPTIONS DO NOT COVER IS SHOWN, NOT SWALLOWED. A
      // <select> whose value matches no <option> renders as blank,
      // which would present a setting the database is actively
      // warning about as if nothing were set at all. The stored value
      // gets its own option so an officer can see what is there and
      // pick their way out of it.
      const known = fm.options.some((o) => o.value === current);
      return (
        <Select
          variant="bare"
          value={current}
          onChange={(e) => handleFieldChange(s.key, field, e.target.value, original)}
          aria-label={fm.label}
          options={[
            ...(!known ? [{ value: current, label: current || 'not set' }] : []),
            ...fm.options,
          ]}
          className={`settings-input ${wide ? 'w-full' : 'w-56'}`}
        />
      );
    }
    return (
      <input
        type={fm.type === 'number' ? 'number' : 'text'}
        value={current}
        min={fm.min}
        max={fm.max}
        step={fm.step}
        onChange={(e) => handleFieldChange(s.key, field, e.target.value, original)}
        aria-label={fm.label}
        className={`settings-input ${fm.type === 'number' ? 'font-mono' : ''} ${
          wide ? 'w-full' : fm.type === 'number' ? 'w-28' : 'w-56'
        }`}
      />
    );
  }

  // A text field with a fixed prefix drawn beside it (lib/prefixed-url.ts).
  // THE MODE COMES FROM THE SAVED VALUE, not the edited one: deciding it per
  // keystroke would swap the input for a plain one mid-word (a `/` typed into
  // the Instagram handle is not canonical), and the swap drops focus.
  function renderAdornedInput(s: PlatformSetting, field: string, fm: FieldMeta): React.ReactNode {
    const kind = fm.adornment!;
    const { original, current } = textState(s, field);
    if (splitAdorned(kind, original).mode === 'plain') {
      return renderControl(s, field, fm, true);
    }
    const split = splitAdorned(kind, current);
    const shown =
      split.mode === 'adorned'
        ? split.rest
        : current.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '');
    return (
      <div className="settings-adorned">
        <span className="settings-adorned-prefix">{ADORNMENT_PREFIX[kind]}</span>
        <input
          type="text"
          value={shown}
          onChange={(e) =>
            handleFieldChange(s.key, field, joinAdorned(kind, e.target.value), original)
          }
          aria-label={fm.label}
          className="settings-adorned-input"
        />
      </div>
    );
  }

  function modifiedMarker(edited: boolean) {
    return edited && <span className="ml-2 text-[var(--color-accent)]">Modified</span>;
  }

  // Unknown key or non-scalar fields: raw JSON so nothing becomes uneditable.
  function renderJsonRow(s: PlatformSetting) {
    const currentValue = jsonEdits[s.key] ?? JSON.stringify(s.value, null, 2);
    return (
      <div key={s.key} className="settings-row !items-start">
        <div className="md:w-[220px] flex-shrink-0">
          <div className="settings-row-label">
            {SETTING_LABELS[s.key] || s.key}
            {modifiedMarker(s.key in jsonEdits)}
          </div>
          <div className="settings-row-hint">{SETTING_DESCRIPTIONS[s.key] || ''}</div>
        </div>
        <div className="settings-row-control wide">
          <Textarea
            value={currentValue}
            onChange={(e) => setJsonEdits((prev) => ({ ...prev, [s.key]: e.target.value }))}
            rows={Math.min(Object.keys(s.value).length + 2, 8)}
            className="font-mono text-xs"
          />
        </div>
      </div>
    );
  }

  function renderRows() {
    return settings.map((s) => {
      if (!isStructured(s)) return renderJsonRow(s);
      return (
        <div key={s.key} className="mt-8">
          <div className="settings-group-heading">{SETTING_LABELS[s.key] || s.key}</div>
          {fieldsOf(s).map(([field, fm]) => (
            <div key={field} className="settings-row">
              <div>
                <div className="settings-row-label">
                  {fm.label}
                  {modifiedMarker(isEdited(s.key, field))}
                </div>
                <div className="settings-row-hint">{fm.hint}</div>
              </div>
              <div className="settings-row-control">{renderControl(s, field, fm)}</div>
            </div>
          ))}
        </div>
      );
    });
  }

  function renderTiles() {
    return settings.map((s) => {
      if (!isStructured(s)) return renderJsonRow(s);
      return (
        <div key={s.key} className="settings-cq">
          <div className="setting-tiles">
            {fieldsOf(s).map(([field, fm]) => (
              <SettingTile
                key={field}
                label={fm.label}
                summary={fm.summary}
                on={fm.type === 'boolean' ? booleanState(s, field).checked : undefined}
                modified={isEdited(s.key, field)}
                control={renderControl(s, field, fm)}
                warning={fm.warning}
                detail={fm.detail ?? fm.hint}
              />
            ))}
          </div>
        </div>
      );
    });
  }

  function renderGrouped() {
    return (
      <div className="settings-cq">
        <div className="settings-grouped">
          {/* Anchors, not tabs: every group is on the page, so a search or a
            scroll finds a rule without knowing which group holds it. */}
          <nav className="settings-grouped-nav">
            {settings.map((s, index) => (
              <a
                key={s.key}
                href={`#rule-${s.key}`}
                className={`rounded-[8px] px-3 py-2 text-[14px] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)] ${
                  index === 0
                    ? 'bg-[var(--surface-2)] font-semibold text-[var(--ink)]'
                    : 'text-[var(--ink-2)]'
                }`}
              >
                {SETTING_LABELS[s.key] || s.key}
              </a>
            ))}
          </nav>
          <div className="flex min-w-0 flex-col gap-8">
            {settings.map((s) => (
              <section key={s.key} id={`rule-${s.key}`} className="scroll-mt-32">
                {isStructured(s) ? (
                  <>
                    <div className="settings-group-heading">{SETTING_LABELS[s.key] || s.key}</div>
                    {fieldsOf(s).map(([field, fm]) => (
                      <div key={field} className="settings-grid-row">
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold text-[var(--ink)]">
                            {fm.label}
                            {modifiedMarker(isEdited(s.key, field))}
                          </div>
                          <div className="mt-1 text-[13px] text-[var(--mute)]">{fm.hint}</div>
                        </div>
                        <div className={fm.type === 'boolean' ? 'justify-self-end' : undefined}>
                          {renderControl(s, field, fm, true)}
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  renderJsonRow(s)
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderLinks() {
    const structured = settings.filter(isStructured);
    return (
      <>
        <div className="settings-cq">
          <div className="settings-links">
            {structured.flatMap((s) =>
              fieldsOf(s).map(([field, fm]) =>
                fm.type === 'boolean' ? (
                  <div
                    key={`${s.key}.${field}`}
                    className="flex items-center gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--bg-primary)] px-4 py-3.5 settings-links-wide"
                  >
                    <div className="flex min-w-0 flex-grow flex-col gap-1">
                      <span className="text-[14px] font-semibold text-[var(--ink)]">
                        {fm.label}
                        {modifiedMarker(isEdited(s.key, field))}
                      </span>
                      <span className="text-[12px] text-[var(--mute)]">{fm.hint}</span>
                    </div>
                    {renderControl(s, field, fm)}
                  </div>
                ) : (
                  <div
                    key={`${s.key}.${field}`}
                    className={`flex min-w-0 flex-col gap-2 ${fm.adornment === 'https' ? 'settings-links-wide' : ''}`}
                  >
                    <span className="text-[14px] font-semibold text-[var(--ink)]">
                      {fm.label}
                      {modifiedMarker(isEdited(s.key, field))}
                    </span>
                    {fm.adornment
                      ? renderAdornedInput(s, field, fm)
                      : renderControl(s, field, fm, true)}
                    <span className="text-[12px] text-[var(--mute)]">{fm.hint}</span>
                  </div>
                ),
              ),
            )}
          </div>
        </div>
        {settings.filter((s) => !isStructured(s)).map(renderJsonRow)}
      </>
    );
  }

  return (
    <div>
      {/* The page title now lives in its PageHeader; this row is just the
          standing warning and the Save button, which needs the form's state. */}
      <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-4">
        <p className="settings-section-desc !mb-0">
          Changes apply to every player immediately and are recorded in the audit log.
        </p>
        {/* THE REASON BOX APPEARS WITH THE SAVE BUTTON, not before it. There is
            nothing to explain until something has been changed, and a box
            standing on an untouched page reads as a field somebody forgot to
            fill in. Save stays disabled until it holds real text — the same
            rule /ratings' save bar follows, and the same rule the server
            enforces for anyone who gets past this. */}
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          {hasChanges && (
            <div className="w-full min-w-0 sm:w-[320px]">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Reason (required)"
                placeholder="Reason (required), logged with your name."
              />
            </div>
          )}
          <Button variant="ghost" onClick={close} disabled={loading}>
            Cancel
          </Button>
          {hasChanges && (
            <Button onClick={handleSave} loading={loading} disabled={!enoughReason}>
              Save Changes
            </Button>
          )}
        </div>
      </div>

      <div className={layout === 'rows' ? undefined : 'mt-5'}>
        {layout === 'tiles'
          ? renderTiles()
          : layout === 'grouped'
            ? renderGrouped()
            : layout === 'links'
              ? renderLinks()
              : renderRows()}
      </div>
    </div>
  );
}
