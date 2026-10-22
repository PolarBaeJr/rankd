"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { Badge, Button, Dialog, Input, Select, Textarea } from "@badminton/ui";
import {
  errorToastText,
  formatPaymentMethod,
  resolvePaymentMethod,
} from "@badminton/shared";
import { useToast } from "@/components/toast-provider";
import {
  describeBulkOutcome,
  useBulkRun,
  type BulkRunResult,
} from "@/components/use-bulk-run";
import {
  attachNamedPayment,
  bulkAddManualFees,
  bulkMarkFeesPaid,
  previewFeePaste,
  removeManualFee,
} from "@/lib/actions";
import type {
  FeePasteCandidate,
  FeePasteNamedMatch,
  FeePasteNotFound,
  FeePastePreview,
} from "@/lib/fee-paste";
import {
  EMPTY_DECISIONS,
  clearDraft,
  loadDraft,
  reapplyDecisions,
  saveDraft,
  sweepDrafts,
  type DraftStorage,
  type FeePasteDraft,
  type PasteDecisions,
  type PasteKeepFields,
} from "@/lib/fee-paste-draft";
import {
  PaymentMethodFields,
  paymentMethodInvalid,
  EMPTY_PAYMENT_METHOD,
  type PaymentMethodState,
} from "./payment-method-fields";

/**
 * The season fee, settled from a pasted list.
 *
 * THE CASE THIS EXISTS FOR is the e-transfer inbox: thirty payments arrive as a
 * list of names and addresses, and the console had one row dialog per person.
 * The list is checked first and nothing is written until the exec has seen who
 * it will mark.
 *
 * THE WRITES ARE THE EXISTING ONES. Members go through bulkMarkFeesPaid, so each
 * is charged their own status rate exactly as the selection bar charges them;
 * people with no account can be kept as named payments through
 * bulkAddManualFees, which is addManualFee per row, so the payment moves onto
 * their account when they sign up with that email (00252). Keeping is off by
 * default: a name that matched nobody is as likely a typo as a stranger.
 *
 * DOUBLE COUNTS ARE DECISIONS, NOT WARNINGS. A line that could be more than one
 * member, or loosely resembles one, is marked only once the exec picks who it
 * is. A named payment that looks like a member is settled from its own row
 * (moved onto them, or removed when their fee is already paid), and until it
 * is, that member stays out of the mark set: marking them as well would record
 * the one payment twice.
 */

type Step = "input" | "preview" | "result";

interface NotMarked {
  label: string;
  reason: string;
}

type NamedOutcome =
  | { kind: "busy" }
  | { kind: "confirm" }
  | { kind: "moved"; playerId: string; playerName: string }
  | { kind: "removed" };

interface DoneSummary {
  marked: number;
  kept: number;
  moved: number;
  removed: number;
}

const MAX_NAME = 80;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

const MICRO =
  "font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]";

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const STATE_TEXT: Record<FeePasteCandidate["state"], string> = {
  will_mark: "Unpaid",
  already_paid: "Already paid",
  waived: "Fee waived",
  not_billable: "Not billed",
};

function StepIndicator({ step }: { step: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "input", label: "Paste" },
    { id: "preview", label: "Review" },
    { id: "result", label: "Done" },
  ];
  const at = steps.findIndex((s) => s.id === step);
  return (
    <ol className="mt-2 flex items-center gap-2" aria-label="Progress">
      {steps.map((s, i) => (
        <li
          key={s.id}
          aria-current={i === at ? "step" : undefined}
          className="flex items-center gap-2"
        >
          {i > 0 && (
            <span aria-hidden className="h-px w-4 sm:w-8 bg-[var(--border)]" />
          )}
          <span
            className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] ${
              i <= at
                ? "bg-[var(--color-accent)] text-white"
                : "border border-[var(--border)] text-[var(--text-muted)]"
            }`}
          >
            {i + 1}
          </span>
          <span
            className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
              i === at ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"
            }`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5">
      <p className={MICRO}>{label}</p>
      <p className="mt-1 font-display text-2xl font-bold leading-none text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  );
}

function SectionHead({
  title,
  count,
  note,
}: {
  title: string;
  count: number;
  note?: string;
}) {
  return (
    <div className="mb-2">
      <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--text-primary)]">
        {title}
        <span className="rounded-full bg-[var(--border-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
          {count}
        </span>
      </h3>
      {note && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{note}</p>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  note,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <SectionHead title={title} count={count} note={note} />
      <ul className="rounded-md border border-[var(--border)] px-3">
        {children}
      </ul>
    </section>
  );
}

function Collapsed({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <details className="group rounded-md border border-[var(--border)]">
      <summary className="flex min-h-[40px] cursor-pointer list-none items-center justify-between gap-2 px-3 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <span className="flex items-center gap-2">
          {title}
          <span className="rounded-full bg-[var(--border-hover)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            {count}
          </span>
        </span>
        <span aria-hidden className="text-[var(--text-muted)] group-open:rotate-90 transition-transform">
          &rsaquo;
        </span>
      </summary>
      <ul className="border-t border-[var(--border)] px-3">{children}</ul>
    </details>
  );
}

/** One row: who, on the left; what happens to them, on the right. */
function Row({
  primary,
  secondary,
  right,
  children,
}: {
  primary: string;
  secondary?: string | null;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const showSecondary =
    secondary != null &&
    secondary.trim() !== "" &&
    secondary.trim().toLowerCase() !== primary.trim().toLowerCase();
  return (
    <li className="border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)]">{primary}</p>
          {showSecondary && (
            <p className="mt-0.5 font-mono text-xs text-[var(--text-muted)]">
              {secondary}
            </p>
          )}
        </div>
        {right && (
          <div className="min-w-0 sm:max-w-[65%] sm:shrink-0 sm:text-right">
            {right}
          </div>
        )}
      </div>
      {children}
    </li>
  );
}

function ChoiceGroup({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | undefined;
  options: Array<{ value: string; title: string; detail?: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-1.5 sm:justify-end"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`min-h-[36px] max-w-full rounded-md border px-2.5 py-1 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
              on
                ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_16%,transparent)] text-[var(--text-primary)]"
                : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <span className="block font-semibold">{o.title}</span>
            {o.detail && (
              <span className="block font-mono text-[10px] text-[var(--text-muted)]">
                {o.detail}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function candidateStateBadge(c: FeePasteCandidate) {
  if (c.state === "will_mark")
    return <Badge variant="success">Will be marked paid</Badge>;
  if (c.state === "already_paid")
    return <Badge variant="neutral">Already paid, nothing to do</Badge>;
  if (c.state === "waived")
    return <Badge variant="neutral">Fee waived, nothing to do</Badge>;
  return (
    <Badge variant="warning" className="whitespace-normal">
      Not billed: {c.reason ?? "not an active member"}
    </Badge>
  );
}

const DUES_TEXT: Record<FeePasteNamedMatch["candidates"][number]["memberDues"], string> = {
  none: "No fee recorded",
  unpaid: "Fee unpaid",
  paid: "Fee paid",
  waived: "Fee waived",
};

/** The preview as it stands once a named payment has been moved onto this member. */
function markMemberPaid(p: FeePastePreview, playerId: string): FeePastePreview {
  const paid = (c: FeePasteCandidate): FeePasteCandidate =>
    c.playerId === playerId && c.state === "will_mark"
      ? { ...c, state: "already_paid" }
      : c;
  return {
    ...p,
    ambiguous: p.ambiguous.map((a) => ({ ...a, candidates: a.candidates.map(paid) })),
    notFound: p.notFound.map((n) => ({
      ...n,
      possibleMembers: n.possibleMembers.map(paid),
    })),
    namedMatches: p.namedMatches.map((m) => ({
      ...m,
      candidates: m.candidates.map((c) =>
        c.playerId === playerId ? { ...c, memberDues: "paid" as const } : c,
      ),
    })),
  };
}

const MATCH_TEXT: Record<FeePasteNamedMatch["candidates"][number]["match"], string> = {
  email: "Same email",
  name: "Same name",
  similar: "Similar name",
};

export function PastePayments({
  seasonId,
  seasonName,
  competitiveFeeCents,
  recreationalFeeCents,
  canKeep,
  canAttach,
  canRemove,
}: {
  seasonId: string;
  seasonName: string;
  competitiveFeeCents: number;
  recreationalFeeCents: number;
  /** addmanual.write on the current season, the same test as Add a name. */
  canKeep: boolean;
  /** addmanual.write: moving a named payment onto a member (markpaid is already why this renders). */
  canAttach: boolean;
  /** removemanual.write: removing a named payment that counts a member twice. */
  canRemove: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { running, progress, run } = useBulkRun();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("input");
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<FeePastePreview | null>(null);
  const [decisions, setDecisions] = useState<PasteDecisions>(EMPTY_DECISIONS);
  const [named, setNamed] = useState<Record<string, NamedOutcome>>({});
  const [batchPrice, setBatchPrice] = useState<
    "" | "competitive" | "recreational"
  >("");
  const [payment, setPayment] =
    useState<PaymentMethodState>(EMPTY_PAYMENT_METHOD);
  const [phase, setPhase] = useState<"marking" | "keeping" | null>(null);
  const [notMarked, setNotMarked] = useState<NotMarked[]>([]);
  const [done, setDone] = useState<DoneSummary | null>(null);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  // Open by default where there is room. On a phone the footer would
  // otherwise take most of the panel and leave little of the list in view.
  const [detailsOpen, setDetailsOpen] = useState(true);

  // ─── THE DRAFT ─────────────────────────────────────────────────────────────
  // See lib/fee-paste-draft.ts for why it exists and why it is bounded to an
  // hour. Closing the dialog keeps it; only a confirmed list or Start over
  // deletes it.

  const draftNow: FeePasteDraft | null =
    open && text.trim() !== "" && step !== "result"
      ? {
          v: 1,
          seasonId,
          savedAt: Date.now(),
          text,
          step: step === "preview" && preview ? "preview" : "input",
          preview: step === "preview" ? preview : null,
          decisions,
          method: payment.method,
          customMethod: payment.customMethod,
          reference: payment.reference,
        }
      : null;
  const draftRef = useRef(draftNow);
  draftRef.current = draftNow;

  // The save below is debounced, so a reload or tab close inside the 500ms
  // would lose the last edit; pagehide flushes it. It reads the ref because
  // this listener is bound once and would otherwise see the first render's draft.
  useEffect(() => {
    sweepDrafts(browserStorage(), Date.now());
    const flush = () => {
      if (draftRef.current)
        saveDraft(browserStorage(), { ...draftRef.current, savedAt: Date.now() });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => {
    if (!open || text.trim() === "" || step === "result") return;
    const t = setTimeout(() => {
      if (draftRef.current)
        saveDraft(browserStorage(), { ...draftRef.current, savedAt: Date.now() });
    }, 500);
    return () => clearTimeout(t);
  }, [open, text, step, preview, decisions, payment]);

  function reset() {
    setStep("input");
    setText("");
    setPreview(null);
    setDecisions(EMPTY_DECISIONS);
    setNamed({});
    setBatchPrice("");
    setPayment(EMPTY_PAYMENT_METHOD);
    setNotMarked([]);
    setDone(null);
    setRestoredAt(null);
  }

  function openDialog() {
    const draft = loadDraft(browserStorage(), seasonId, Date.now());
    setDetailsOpen(window.matchMedia("(min-width: 640px)").matches);
    setOpen(true);
    if (!draft) return;
    setText(draft.text);
    setPayment({
      method: draft.method,
      customMethod: draft.customMethod,
      reference: draft.reference,
    });
    setDecisions(draft.decisions);
    setRestoredAt(draft.savedAt);
    // The saved preview may be stale: someone may have marked people since.
    // Check the text again and carry over only the decisions that still apply.
    if (draft.step === "preview") void check(draft.text, draft.decisions);
  }

  function close() {
    if (running || checking) return;
    if (draftRef.current)
      saveDraft(browserStorage(), { ...draftRef.current, savedAt: Date.now() });
    setOpen(false);
    reset();
  }

  function startOver() {
    if (running || checking) return;
    clearDraft(browserStorage(), seasonId);
    reset();
  }

  async function check(pasted: string, carry: PasteDecisions) {
    setChecking(true);
    try {
      const result = await previewFeePaste({ season_id: seasonId, text: pasted });
      if (!result.ok) {
        toast(
          result.code
            ? `${result.error} (${result.code}.${result.ref})`
            : result.error,
          "error",
        );
        setStep("input");
        return;
      }
      setPreview(result.data);
      setDecisions(reapplyDecisions(result.data, carry));
      setNamed({});
      setStep("preview");
    } catch {
      toast("The list could not be checked. Try again.", "error");
      setStep("input");
    } finally {
      setChecking(false);
    }
  }

  // ─── DERIVED ───────────────────────────────────────────────────────────────

  const hinted = (preview?.notFound ?? []).filter(
    (n) => n.possibleMembers.length > 0,
  );
  const plainNotFound = (preview?.notFound ?? []).filter(
    (n) => n.possibleMembers.length === 0,
  );
  const decisionRows: Array<{
    raw: string;
    reason: string;
    candidates: FeePasteCandidate[];
    notFound: FeePasteNotFound | null;
  }> = [
    ...(preview?.ambiguous ?? []).map((a) => ({
      raw: a.raw,
      reason: a.reason,
      candidates: a.candidates,
      notFound: null,
    })),
    ...hinted.map((n) => ({
      raw: n.raw,
      reason:
        n.possibleMembers.length === 1
          ? "Not an exact match, but close to this member."
          : "Not an exact match, but close to these members.",
      candidates: n.possibleMembers,
      notFound: n,
    })),
  ];

  const choiceOf = (raw: string, hasCandidates: boolean): string | undefined =>
    decisions.choices[raw] ?? (hasCandidates ? undefined : "skip");
  const setChoice = (raw: string, value: string) =>
    setDecisions((d) => ({ ...d, choices: { ...d.choices, [raw]: value } }));

  const keepFieldsOf = (n: FeePasteNotFound): PasteKeepFields =>
    decisions.keep[n.raw] ?? {
      name: (n.name ?? n.email ?? "").slice(0, MAX_NAME),
      email: n.email ?? "",
      amount: n.amountCents != null ? (n.amountCents / 100).toFixed(2) : "",
    };
  const setKeep = (n: FeePasteNotFound, patch: Partial<PasteKeepFields>) =>
    setDecisions((d) => ({
      ...d,
      keep: { ...d.keep, [n.raw]: { ...keepFieldsOf(n), ...patch } },
    }));

  const namedSettled = (feeId: string) => {
    const o = named[feeId];
    return o?.kind === "moved" || o?.kind === "removed";
  };
  const namedOpen = (preview?.namedMatches ?? []).filter(
    (m) => !decisions.dismissed.includes(m.feeId) && !namedSettled(m.feeId),
  );
  // A member a still-open named payment is the same person as (by email or
  // exact name) is held back from marking until that row is settled, and one a
  // payment was moved onto is paid already.
  const heldBack = new Map<string, string>();
  for (const m of namedOpen) {
    for (const c of m.candidates) {
      if (c.match !== "similar") heldBack.set(c.playerId, m.manualName);
    }
  }
  const movedOnto = new Set(
    Object.values(named).flatMap((o) => (o.kind === "moved" ? [o.playerId] : [])),
  );

  const chosen = decisionRows.flatMap((r) => {
    const c = r.candidates.find((x) => x.playerId === choiceOf(r.raw, true));
    return c ? [{ row: r, candidate: c }] : [];
  });
  const markNames = new Map<string, string>();
  for (const w of preview?.willMark ?? []) markNames.set(w.playerId, w.fullName);
  for (const { candidate } of chosen) {
    if (candidate.state === "will_mark")
      markNames.set(candidate.playerId, candidate.name);
  }
  const markIds = [...markNames.keys()].filter(
    (id) => !heldBack.has(id) && !movedOnto.has(id),
  );

  const batchCents =
    batchPrice === "competitive"
      ? competitiveFeeCents
      : batchPrice === "recreational"
        ? recreationalFeeCents
        : null;

  // What each kept row would be recorded at: its own figure if it has one,
  // otherwise the batch price. Null means neither is set yet.
  function amountCentsOf(row: PasteKeepFields): number | null {
    if (row.amount.trim() === "") return batchCents;
    const d = parseFloat(row.amount);
    return Number.isNaN(d) || d <= 0 ? null : Math.round(d * 100);
  }

  const kept = canKeep
    ? (preview?.notFound ?? [])
        .filter((n) => choiceOf(n.raw, n.possibleMembers.length > 0) === "keep")
        .map((n) => keepFieldsOf(n))
    : [];
  const keepInvalid = kept.some(
    (row) =>
      row.name.trim() === "" ||
      row.name.trim().length > MAX_NAME ||
      amountCentsOf(row) == null,
  );
  const needsBatchPrice = kept.some((row) => row.amount.trim() === "");
  const undecided = decisionRows.filter(
    (r) => choiceOf(r.raw, true) === undefined,
  ).length;
  const nothingToDo =
    (preview?.alreadyPaid.length ?? 0) +
    (preview?.waived.length ?? 0) +
    (preview?.alreadyNamed.length ?? 0);

  // ─── CONFIRM ───────────────────────────────────────────────────────────────

  async function handleConfirm() {
    if (!preview) return;
    const method = resolvePaymentMethod(payment.method, payment.customMethod);
    const reference = payment.reference.trim() || undefined;
    const missed: NotMarked[] = [];
    let marked = 0;
    let keptCount = 0;

    const nameOf = (id: string) => markNames.get(id) ?? id;
    if (markIds.length > 0) {
      setPhase("marking");
      const res = await run(markIds, (chunk) =>
        bulkMarkFeesPaid(chunk, seasonId, method, reference),
      );
      reportRun(res, "marked paid", nameOf);
      marked = res.outcome.succeeded;
      for (const f of res.outcome.failures)
        missed.push({ label: nameOf(f.id), reason: f.error });
      if (!res.ok) {
        for (const id of markIds.slice(res.outcome.attempted)) {
          missed.push({
            label: nameOf(id),
            reason: `Not recorded: ${res.error ?? "the request failed"}`,
          });
        }
      }
    }

    // Ids are the kept rows' positions in `kept`, so a failure can be named.
    // Each call numbers its own entries from 0; the wrapper maps them back.
    const payloads = kept.map((row) => ({
      manual_name: row.name.trim(),
      email: row.email.trim() || undefined,
      amount_cents: amountCentsOf(row) ?? undefined,
      method,
      reference,
    }));
    const keptIds = payloads.map((_, i) => String(i));
    const keptName = (id: string) => payloads[Number(id)]?.manual_name ?? id;
    if (keptIds.length > 0) {
      setPhase("keeping");
      const res = await run(keptIds, async (chunk) => {
        const r = await bulkAddManualFees(
          seasonId,
          chunk.map((id) => payloads[Number(id)]),
        );
        if (!r.ok) return r;
        return {
          ok: true as const,
          data: {
            ...r.data,
            failures: r.data.failures.map((f) => ({
              ...f,
              id: chunk[Number(f.id)] ?? f.id,
            })),
          },
        };
      });
      reportRun(res, "kept as named payments", keptName);
      keptCount = res.outcome.succeeded;
      for (const f of res.outcome.failures) {
        missed.push({
          label: keptName(f.id),
          reason: `Could not keep as a named payment: ${f.error}`,
        });
      }
      if (!res.ok) {
        for (const id of keptIds.slice(res.outcome.attempted)) {
          missed.push({
            label: keptName(id),
            reason: `Not kept: ${res.error ?? "the request failed"}`,
          });
        }
      }
    }
    setPhase(null);

    for (const r of decisionRows) {
      const choice = choiceOf(r.raw, true);
      if (choice === undefined) {
        missed.push({ label: r.raw, reason: "No decision made" });
      } else if (choice === "skip") {
        missed.push({
          label: r.raw,
          reason: r.notFound ? "Not found on the roster" : r.reason,
        });
      } else if (choice === "keep" && !canKeep) {
        missed.push({ label: r.raw, reason: "Not found on the roster" });
      }
    }
    for (const { row, candidate } of chosen) {
      if (candidate.state === "not_billable")
        missed.push({
          label: `${candidate.name} (${row.raw})`,
          reason: candidate.reason ?? "Not billed a season fee",
        });
    }
    for (const n of plainNotFound) {
      if (canKeep && choiceOf(n.raw, false) === "keep") continue;
      missed.push({ label: n.raw, reason: "Not found on the roster" });
    }
    for (const [id, name] of markNames) {
      const manualName = heldBack.get(id);
      if (manualName != null && !movedOnto.has(id))
        missed.push({
          label: name,
          reason: `Has a named payment ("${manualName}") that was not settled`,
        });
    }
    for (const b of preview.notBillable)
      missed.push({
        label: b.raw.toLowerCase().includes(b.name.toLowerCase())
          ? b.raw
          : `${b.name} (${b.raw})`,
        reason: b.reason,
      });
    for (const v of preview.invalid)
      missed.push({ label: v.raw, reason: v.reason });

    const outcomes = Object.values(named);
    setDone({
      marked,
      kept: keptCount,
      moved: outcomes.filter((o) => o.kind === "moved").length,
      removed: outcomes.filter((o) => o.kind === "removed").length,
    });
    setNotMarked(missed);
    setStep("result");
    clearDraft(browserStorage(), seasonId);
    if (markIds.length + keptIds.length > 0) router.refresh();
  }

  function reportRun(
    res: BulkRunResult,
    verb: string,
    nameOf: (id: string) => string,
  ) {
    if (!res.ok) {
      const error = res.error ?? "Something went wrong";
      toast(res.code ? `${error} (${res.code}.${res.ref})` : error, "error");
      return;
    }
    const { message, type } = describeBulkOutcome(res.outcome, verb, nameOf);
    toast(message, type);
  }

  // ─── NAMED PAYMENTS ────────────────────────────────────────────────────────

  const setOutcome = (feeId: string, o: NamedOutcome | null) =>
    setNamed((all) => {
      const next = { ...all };
      if (o) next[feeId] = o;
      else delete next[feeId];
      return next;
    });

  async function handleAttach(m: FeePasteNamedMatch, playerId: string) {
    setOutcome(m.feeId, { kind: "busy" });
    try {
      const res = await attachNamedPayment(m.feeId, playerId);
      if (!res.ok) {
        toast(res.code ? `${res.error} (${res.code}.${res.ref})` : res.error, "error");
        setOutcome(m.feeId, null);
        return;
      }
      setOutcome(m.feeId, {
        kind: "moved",
        playerId,
        playerName: res.data.playerName,
      });
      // Their fee is paid now. Every other row that offers them must say so,
      // or it would offer a move the server refuses and hide the Remove.
      setPreview((p) => (p ? markMemberPaid(p, playerId) : p));
      toast(`Moved "${m.manualName}" onto ${res.data.playerName}`, "success");
      router.refresh();
    } catch {
      toast("The payment could not be moved. Try again.", "error");
      setOutcome(m.feeId, null);
    }
  }

  async function handleRemove(m: FeePasteNamedMatch) {
    if (named[m.feeId]?.kind !== "confirm") {
      setOutcome(m.feeId, { kind: "confirm" });
      return;
    }
    setOutcome(m.feeId, { kind: "busy" });
    try {
      await removeManualFee(m.feeId);
      setOutcome(m.feeId, { kind: "removed" });
      toast(`Removed the named payment "${m.manualName}"`, "success");
      router.refresh();
    } catch (err) {
      toast(errorToastText(err, "FEE", "Failed to remove"), "error");
      setOutcome(m.feeId, null);
    }
  }

  const dismiss = (feeId: string) =>
    setDecisions((d) => ({ ...d, dismissed: [...d.dismissed, feeId] }));

  async function handleCopy() {
    const lines = [
      `Not marked paid for ${seasonName} (${notMarked.length}):`,
      ...notMarked.map((m) => `${m.label}: ${m.reason}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("Copied", "success");
    } catch {
      toast("Could not copy. Select the list and copy it by hand.", "error");
    }
  }

  const busy = running
    ? `${phase === "keeping" ? "Keeping" : "Marking"} ${progress?.done ?? 0} of ${progress?.total ?? 0}…`
    : null;
  const namedBusy = Object.values(named).some((o) => o.kind === "busy");
  const paymentSummary =
    [
      formatPaymentMethod(resolvePaymentMethod(payment.method, payment.customMethod)),
      payment.reference.trim() ? `ref ${payment.reference.trim()}` : null,
      canKeep && needsBatchPrice && batchCents == null ? "choose a price" : null,
    ]
      .filter(Boolean)
      .join(", ") || "No method";
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim() !== "").length;

  const restoredLine = restoredAt != null && step !== "result" && (
    <p className="mb-4 text-xs text-[var(--text-muted)]">
      Restored your unsent list from{" "}
      {new Date(restoredAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}
      .{" "}
      <button
        type="button"
        onClick={startOver}
        disabled={running || checking}
        className="underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-50"
      >
        Start over
      </button>
    </p>
  );

  // ─── RENDER: REVIEW ROWS ───────────────────────────────────────────────────

  function keepPanel(n: FeePasteNotFound) {
    const row = keepFieldsOf(n);
    const id = encodeURIComponent(n.raw);
    return (
      <div className="mt-3 grid gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] p-3 sm:grid-cols-3">
        <Input
          id={`keep-name-${id}`}
          label="Name"
          value={row.name}
          maxLength={MAX_NAME}
          onChange={(e) => setKeep(n, { name: e.target.value })}
          disabled={running}
        />
        <Input
          id={`keep-email-${id}`}
          label="Email"
          type="email"
          autoComplete="off"
          value={row.email}
          onChange={(e) => setKeep(n, { email: e.target.value })}
          disabled={running}
        />
        <Input
          id={`keep-amount-${id}`}
          label="Amount $"
          type="number"
          step="0.01"
          min="0"
          value={row.amount}
          onChange={(e) => setKeep(n, { amount: e.target.value })}
          placeholder={
            batchCents != null ? (batchCents / 100).toFixed(2) : "Batch price"
          }
          disabled={running}
        />
        {row.email.trim() === "" && (
          <p className="text-xs text-[var(--text-muted)] sm:col-span-3">
            Without an email this stays a named payment. With one, it moves
            onto their account when they sign up with that email.
          </p>
        )}
      </div>
    );
  }

  function decisionRow(r: (typeof decisionRows)[number]) {
    const choice = choiceOf(r.raw, true);
    const picked = r.candidates.find((c) => c.playerId === choice);
    const options = [
      ...r.candidates.map((c) => ({
        value: c.playerId,
        title: c.name,
        detail: [c.maskedEmail, STATE_TEXT[c.state]].filter(Boolean).join(" · "),
      })),
      ...(r.notFound && canKeep
        ? [{ value: "keep", title: "Someone new", detail: "Keep as a named payment" }]
        : []),
      { value: "skip", title: "Skip" },
    ];
    return (
      <Row
        key={`d-${r.raw}`}
        primary={picked ? picked.name : r.raw}
        secondary={picked ? r.raw : r.reason}
        right={
          <ChoiceGroup
            label={`Who is ${r.raw}?`}
            value={choice}
            options={options}
            onChange={(v) => setChoice(r.raw, v)}
            disabled={running}
          />
        }
      >
        {picked && (
          <div className="mt-2 flex flex-wrap gap-2">
            {candidateStateBadge(picked)}
            {picked.state === "will_mark" && heldBack.has(picked.playerId) && (
              <Badge variant="warning">Has a named payment above</Badge>
            )}
          </div>
        )}
        {choice === "keep" && r.notFound && canKeep && keepPanel(r.notFound)}
      </Row>
    );
  }

  function namedRow(m: FeePasteNamedMatch) {
    const outcome = named[m.feeId];
    const rowBusy = outcome?.kind === "busy";
    const detail = [
      m.amountCents != null ? dollars(m.amountCents) : null,
      m.paidAt ? new Date(m.paidAt).toLocaleDateString() : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (outcome?.kind === "moved" || outcome?.kind === "removed") {
      return (
        <Row
          key={`n-${m.feeId}`}
          primary={m.manualName}
          secondary={detail}
          right={
            <Badge variant="success">
              {outcome.kind === "moved"
                ? `Moved onto ${outcome.playerName}`
                : "Named payment removed"}
            </Badge>
          }
        />
      );
    }
    const anyPaid = m.candidates.some((c) => c.memberDues === "paid");
    return (
      <Row
        key={`n-${m.feeId}`}
        primary={m.manualName}
        secondary={detail ? `Named payment · ${detail}` : "Named payment"}
        right={
          <div className="flex flex-wrap gap-1.5 sm:justify-end">
            {canRemove && anyPaid && (
              <Button
                variant={outcome?.kind === "confirm" ? "danger" : "secondary"}
                size="sm"
                className="h-auto whitespace-normal py-1 text-left"
                onClick={() => handleRemove(m)}
                disabled={running || rowBusy}
              >
                {outcome?.kind === "confirm"
                  ? "Confirm remove"
                  : "Remove named payment (counted twice)"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dismiss(m.feeId)}
              disabled={running || rowBusy}
            >
              Not them
            </Button>
          </div>
        }
      >
        <ul className="mt-2 space-y-1.5">
          {m.candidates.map((c) => {
            const movable =
              canAttach && (c.memberDues === "none" || c.memberDues === "unpaid");
            return (
              <li
                key={c.playerId}
                className="flex flex-col gap-2 rounded-md bg-[var(--bg-surface)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 text-xs">
                  <span className="text-[var(--text-primary)]">{c.name}</span>
                  {c.maskedEmail && (
                    <span className="ml-2 font-mono text-[var(--text-muted)]">
                      {c.maskedEmail}
                    </span>
                  )}
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    <Badge variant={c.match === "similar" ? "neutral" : "info"}>
                      {MATCH_TEXT[c.match]}
                    </Badge>
                    <Badge variant={c.memberDues === "paid" ? "warning" : "neutral"}>
                      {DUES_TEXT[c.memberDues]}
                    </Badge>
                  </span>
                </div>
                {movable && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-auto whitespace-normal py-1 text-left"
                    onClick={() => handleAttach(m, c.playerId)}
                    disabled={running || rowBusy}
                    loading={rowBusy}
                  >
                    Move onto {c.name}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {outcome?.kind === "confirm" && (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            This deletes the named payment. Click Confirm remove to go ahead.
          </p>
        )}
      </Row>
    );
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────

  const footer =
    step === "input" ? (
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={close} disabled={checking}>
          Cancel
        </Button>
        <Button
          onClick={() => check(text, decisions)}
          loading={checking}
          disabled={text.trim() === "" || text.length > 50000}
        >
          Check list
        </Button>
      </div>
    ) : step === "preview" && preview ? (
      <div className="space-y-3">
        <details
          open={detailsOpen}
          onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
          className="group"
        >
          <summary className="flex min-h-[32px] cursor-pointer list-none items-center justify-between gap-2">
            <span className={MICRO}>Payment details</span>
            <span className="min-w-0 truncate text-xs text-[var(--text-muted)]">
              {paymentSummary}
              <span aria-hidden className="ml-2 inline-block transition-transform group-open:rotate-90">
                &rsaquo;
              </span>
            </span>
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 [&_label]:text-xs">
            <PaymentMethodFields
              value={payment}
              onChange={setPayment}
              disabled={running}
            />
            {canKeep && needsBatchPrice && (
              <Select
                label="Price for kept payments with no amount"
                options={[
                  { value: "", label: "Choose a price" },
                  {
                    value: "competitive",
                    label: `Competitive ${dollars(competitiveFeeCents)}`,
                  },
                  {
                    value: "recreational",
                    label: `Recreational ${dollars(recreationalFeeCents)}`,
                  },
                ]}
                value={batchPrice}
                onChange={(e) =>
                  setBatchPrice(e.target.value as typeof batchPrice)
                }
                disabled={running}
              />
            )}
          </div>
        </details>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-[var(--text-muted)]">
            {undecided > 0
              ? `${undecided} still ${undecided === 1 ? "needs" : "need"} a decision`
              : ""}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setStep("input")}
              disabled={running || namedBusy}
            >
              Back
            </Button>
            <Button variant="ghost" onClick={close} disabled={running}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              className="h-auto whitespace-normal py-1.5 text-left"
              disabled={
                running || namedBusy || keepInvalid || paymentMethodInvalid(payment)
              }
            >
              {busy ??
                (markIds.length + kept.length === 0
                  ? "Nothing to record, show the list"
                  : [
                      `Mark ${markIds.length} paid`,
                      ...(kept.length > 0 ? [`keep ${kept.length}`] : []),
                    ].join(", "))}
            </Button>
          </div>
        </div>
      </div>
    ) : (
      <div className="flex flex-wrap justify-end gap-2">
        {notMarked.length > 0 && (
          <Button variant="secondary" onClick={handleCopy}>
            Copy list
          </Button>
        )}
        <Button onClick={close}>Done</Button>
      </div>
    );

  const doneLine = done
    ? [
        `${done.marked} marked paid`,
        ...(done.kept > 0 ? [`${done.kept} kept`] : []),
        ...(done.moved > 0
          ? [`${done.moved} moved onto ${done.moved === 1 ? "a member" : "members"}`]
          : []),
        ...(done.removed > 0
          ? [`${plural(done.removed, "named payment")} removed`]
          : []),
      ].join(", ")
    : "";

  return (
    <>
      <Button
        variant="secondary"
        onClick={openDialog}
        className="border-[var(--border-hover)] text-[var(--text-primary)]"
      >
        <ClipboardList aria-hidden className="w-4 h-4" />
        Paste a list
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Paste a list"
        size="wide"
        header={<StepIndicator step={step} />}
        footer={footer}
      >
        {step === "input" && (
          <div className="space-y-3">
            {restoredLine}
            {checking && restoredAt != null ? (
              <p className="text-sm text-[var(--text-secondary)]">
                Checking your list again against {seasonName}…
              </p>
            ) : (
              <>
                <p className="text-sm text-[var(--text-secondary)]">
                  Paste who paid their fee. Nothing is recorded until you have
                  checked the list.
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={MICRO}>
                    Applies to{" "}
                    <span className="text-[var(--text-primary)]">{seasonName}</span>
                  </span>
                  <span className={MICRO}>{plural(lineCount, "line")}</span>
                </div>
                <Textarea
                  aria-label="Names or emails"
                  rows={12}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    "Jane Doe, jane@sfu.ca, $5\nSam Lee, $5\nalex@sfu.ca"
                  }
                  disabled={checking}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-[var(--text-muted)]">
                  One per line: name, email, amount. The email and the amount
                  can be left out. Rows copied out of a spreadsheet work too. A long list takes
                  a while to record; keep this window open until it finishes.
                </p>
              </>
            )}
          </div>
        )}

        {step === "preview" && preview && (
          <div className="space-y-5">
            {restoredLine}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Will mark" value={markIds.length} />
              <StatTile label="Needs a decision" value={undecided} />
              <StatTile label="Named payments to check" value={namedOpen.length} />
              <StatTile label="Nothing to do" value={nothingToDo} />
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Checked against {seasonName}. Each member is charged their own
              rate, competitive or recreational.
            </p>

            <Section
              title="Needs a decision"
              count={decisionRows.length}
              note="Nobody here is marked until you pick who they are. Rows left undecided are skipped."
            >
              {decisionRows.map(decisionRow)}
            </Section>

            <Section
              title="Named payments that look like a member"
              count={(preview.namedMatches ?? []).filter(
                (m) => !decisions.dismissed.includes(m.feeId),
              ).length}
              note="Recorded by name before this member had an account, so this season may be counting them twice. A member listed here is not marked until the row is settled."
            >
              {preview.namedMatches
                .filter((m) => !decisions.dismissed.includes(m.feeId))
                .map(namedRow)}
            </Section>
            {preview.namedMatches.length > 0 && !canAttach && !canRemove && (
              <p className="text-xs text-[var(--text-muted)]">
                Moving or removing a named payment needs permission to add and
                remove names.
              </p>
            )}

            <Section title="Will be marked paid" count={preview.willMark.length}>
              {preview.willMark.map((w) => (
                <Row
                  key={w.playerId}
                  primary={w.fullName}
                  secondary={w.raw}
                  right={
                    movedOnto.has(w.playerId) ? (
                      <Badge variant="neutral">Paid by the moved payment</Badge>
                    ) : heldBack.has(w.playerId) ? (
                      <Badge variant="warning">Has a named payment above</Badge>
                    ) : (
                      <Badge variant="success">Will be marked paid</Badge>
                    )
                  }
                />
              ))}
            </Section>

            <Section
              title="Not found"
              count={plainNotFound.length}
              note={
                canKeep
                  ? "Nobody on the roster by this name or email. Keep one as a named payment only if they really paid without an account."
                  : "Keeping a name as a named payment needs the current season, and permission to add names."
              }
            >
              {plainNotFound.map((n) => {
                const choice = choiceOf(n.raw, false);
                return (
                  <Row
                    key={`nf-${n.raw}`}
                    primary={n.name ?? n.email ?? n.raw}
                    secondary={n.raw}
                    right={
                      canKeep ? (
                        <ChoiceGroup
                          label={`Keep ${n.raw}?`}
                          value={choice}
                          options={[
                            { value: "keep", title: "Keep as a named payment" },
                            { value: "skip", title: "Skip" },
                          ]}
                          onChange={(v) => setChoice(n.raw, v)}
                          disabled={running}
                        />
                      ) : (
                        <Badge variant="neutral">Not found</Badge>
                      )
                    }
                  >
                    {canKeep && choice === "keep" && keepPanel(n)}
                  </Row>
                );
              })}
            </Section>

            <div className="space-y-2">
              <Collapsed title="Already paid" count={preview.alreadyPaid.length}>
                {preview.alreadyPaid.map((r, i) => (
                  <Row
                    key={`${i}-${r.raw}`}
                    primary={r.name}
                    secondary={r.raw}
                    right={<Badge variant="neutral">Already paid</Badge>}
                  />
                ))}
              </Collapsed>
              <Collapsed title="Waived" count={preview.waived.length}>
                {preview.waived.map((r, i) => (
                  <Row
                    key={`${i}-${r.raw}`}
                    primary={r.name}
                    secondary={r.raw}
                    right={<Badge variant="neutral">Fee waived</Badge>}
                  />
                ))}
              </Collapsed>
              <Collapsed
                title="Already a named payment"
                count={preview.alreadyNamed.length}
              >
                {preview.alreadyNamed.map((r, i) => (
                  <Row
                    key={`${i}-${r.raw}`}
                    primary={r.name}
                    secondary={r.raw}
                    right={
                      r.unpaid ? (
                        <Badge variant="warning">Named, not paid</Badge>
                      ) : (
                        <Badge variant="neutral">Named payment</Badge>
                      )
                    }
                  />
                ))}
              </Collapsed>
              <Collapsed
                title="Found but not billable"
                count={preview.notBillable.length}
              >
                {preview.notBillable.map((r, i) => (
                  <Row
                    key={`${i}-${r.raw}`}
                    primary={r.name}
                    secondary={r.raw}
                    right={
                      <Badge variant="neutral" className="whitespace-normal">
                        {r.reason}
                      </Badge>
                    }
                  />
                ))}
              </Collapsed>
              <Collapsed title="Could not read" count={preview.invalid.length}>
                {preview.invalid.map((v, i) => (
                  <Row
                    key={`${i}-${v.raw}`}
                    primary={v.raw}
                    right={
                      <Badge variant="danger" className="whitespace-normal">
                        {v.reason}
                      </Badge>
                    }
                  />
                ))}
              </Collapsed>
            </div>
          </div>
        )}

        {step === "result" && (
          <div className="space-y-4">
            <p className="font-display text-2xl font-bold leading-tight text-[var(--text-primary)]">
              {doneLine}
            </p>
            <p className="text-sm text-[var(--text-secondary)]">
              {notMarked.length === 0
                ? `Everyone on the list is accounted for in ${seasonName}.`
                : `${notMarked.length} on the list ${notMarked.length === 1 ? "was" : "were"} not marked paid for ${seasonName}.`}
            </p>
            {!canKeep && (preview?.notFound.length ?? 0) > 0 && (
              <p className="text-xs text-[var(--text-muted)]">
                Keeping a name as a named payment needs the current season.
                Switch to it on this page to keep them.
              </p>
            )}
            {notMarked.length > 0 && (
              <ul className="rounded-md border border-[var(--border)] px-3">
                {notMarked.map((m, i) => (
                  <Row
                    key={`${i}-${m.label}`}
                    primary={m.label}
                    right={
                      <Badge
                        variant={
                          m.reason === "No decision made" ? "warning" : "neutral"
                        }
                        className="whitespace-normal"
                      >
                        {m.reason}
                      </Badge>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
