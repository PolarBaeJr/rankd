'use client';

import { useState } from 'react';
import { Button, Select, useConfirm } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { updateEventWaiverTemplate } from '@/lib/actions';
import { AutoGrowTextarea } from './auto-grow-textarea';

interface SeasonRow {
  id: string;
  name: string;
  active_flag: boolean;
}

interface TemplateRow {
  season_id: string;
  content: string;
  updated_at: string;
}

/**
 * The per-season starting text for a tournament's event waiver (00074).
 *
 * A season picker rather than "the active season only" because the template is
 * written BEFORE the term it belongs to — an exec drafts Fall's wording in
 * August, while Summer is still the active season. Restricting the editor to
 * the active season would make next term's template unwritable until the term
 * had already started.
 *
 * Same admin/exec split as the four legal documents: an admin edits the text,
 * an exec reads it (and copies it into an event from /tournaments). There is no
 * "require re-signature" here — nobody accepts a template; participants accept
 * the copy that lives on their tournament.
 */
export function EventWaiverTemplateForm({
  seasons,
  templates,
  canEdit,
}: {
  seasons: SeasonRow[];
  templates: TemplateRow[];
  // Mirrors LegalDocumentsForm: this only decides which controls are offered.
  // updateEventWaiverTemplate() is the boundary, and it is admin-only.
  canEdit: boolean;
}) {
  const [seasonId, setSeasonId] = useState(
    () => seasons.find((s) => s.active_flag)?.id ?? seasons[0]?.id ?? ''
  );
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Read until Edit, as the four documents are. Leaving edit mode drops the draft.
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  const saved = templates.find((t) => t.season_id === seasonId);
  const season = seasons.find((s) => s.id === seasonId);
  // A season with no row yet edits from blank — only the active season at
  // migration time was seeded, and later seasons start empty.
  const currentValue = edits[seasonId] ?? saved?.content ?? '';
  const isEdited = seasonId in edits && edits[seasonId] !== (saved?.content ?? '');

  function closeEditor() {
    setEdits({});
    setEditing(false);
  }

  async function switchSeason(next: string) {
    if (isEdited) {
      const discard = await confirm({
        title: 'Discard your changes?',
        message: `Your edit to ${season?.name ?? 'this season'}'s template is in this browser only.`,
        confirmLabel: 'Discard changes',
        danger: true,
      });
      if (!discard) return;
    }
    closeEditor();
    setSeasonId(next);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateEventWaiverTemplate({ season_id: seasonId, content: currentValue });
      toast(`Template saved for ${season?.name ?? 'this season'}`, 'success');
      closeEditor();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save template', 'error');
    }
    setSaving(false);
  }

  if (seasons.length === 0) {
    return (
      <p className="settings-section-desc">
        No seasons yet. Create a season before writing an event waiver template.
      </p>
    );
  }

  return (
    <div className="settings-row !items-start">
      <div className="md:w-[220px] flex-shrink-0">
        <div className="settings-row-label">
          Event Waiver Template
          {isEdited && <span className="ml-2 text-[var(--color-accent)]">Modified</span>}
        </div>
        <div className="settings-row-hint">
          The starting text for a tournament&rsquo;s optional event waiver. Execs pull it
          into an event from Tournaments instead of retyping it — editing it here never
          changes a waiver anyone has already accepted. Markdown: ## headings, - lists,
          **bold**.
        </div>
        <div className="mt-3">
          <Select
            label="Season"
            value={seasonId}
            onChange={(e) => void switchSeason(e.target.value)}
            options={seasons.map((s) => ({
              value: s.id,
              label: s.active_flag ? `${s.name} (active)` : s.name,
            }))}
          />
        </div>
        <p className="font-mono text-xs text-[var(--text-muted)] mt-2">
          {saved
            ? `updated ${new Date(saved.updated_at).toLocaleDateString()}`
            : 'no template yet'}
        </p>
      </div>
      <div className="settings-row-control wide">
        {canEdit && editing ? (
          <>
            {/* Said out loud in the UI as well as the migration header: the
                seeded text is a fill-in-the-blanks skeleton, not wording anyone
                has had reviewed. */}
            <p className="settings-section-desc mb-2">
              A drafting aid, not reviewed legal text — replace the [BRACKETED]
              placeholders and have the exec team check the wording each term.
            </p>
            <AutoGrowTextarea
              value={currentValue}
              onChange={(e) => setEdits((prev) => ({ ...prev, [seasonId]: e.target.value }))}
              rows={18}
              className="font-mono text-xs"
              placeholder="No template for this season yet — write one here."
            />
          </>
        ) : saved ? (
          /* Read-only for execs and, until Edit, for an admin, matching the four documents. No max-height:
             the page scrolls, not the box. */
          <pre className="font-mono text-xs whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3 text-[var(--text-secondary)]">
            {saved.content}
          </pre>
        ) : (
          <p className="settings-section-desc">
            No template for {season?.name ?? 'this season'} yet.{canEdit ? '' : ' An admin can add one.'}
          </p>
        )}
        {canEdit && !editing && (
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}
        {canEdit && editing && (
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button variant="ghost" onClick={closeEditor} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={handleSave}
              loading={saving}
              disabled={saving || currentValue.trim().length === 0}
            >
              Save template
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
