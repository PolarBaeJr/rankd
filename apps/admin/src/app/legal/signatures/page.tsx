export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { buildMemberSignatureRows, matchesSignatureSearch, type SignatureMemberInput } from '@/lib/legal-signatures';
import { Badge, Input, PageHeader } from '@badminton/ui';
import { clubDate, LEGAL_DOCUMENT_SHORT_LABELS, selectAllPages, sortLegalDocuments, unwrap, type WaiverDocument } from '@badminton/shared';

// WHICH VERSION OF EACH DOCUMENT EVERY ACTIVE MEMBER LAST SIGNED. Read-only.
//
// legal.page opens it, as it opens /legal/guests; SECTION_CAPABILITY matches
// the longest prefix, so this page inherits it with no map entry.
//
// The members list is the roster, so it is players.read, and like /legal the
// FETCH is skipped without it rather than the rows hidden after the fact: a
// conditional render over an unconditional query still ships the rows in the
// RSC payload.

const TH =
  'px-5 pb-2 pt-4 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]';

export default async function MemberSignaturesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const viewer = await requireCapability('legal.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const canReadRoster = permits(level, permissions, 'players.read');
  const q = ((await searchParams).q ?? '').trim().slice(0, 100);

  const admin = createAdminClient();
  const [documentsRead, membersRead] = await Promise.all([
    admin.from('legal_documents').select('document, version, reacceptance_required_since'),
    canReadRoster
      ? // PAGED: a single request is cut at db-max-rows (1,000) without an
        // error, so a long roster would quietly lose its tail.
        selectAllPages((from, to) =>
          admin
            .from('players')
            .select('id, full_name, waiver_reset_at, waiver_acceptances(document, version, accepted_at)')
            .eq('active_flag', true)
            // Same population as the signature panel on /legal: a stub that has
            // not finished onboarding has not been asked to sign anything yet.
            .or('onboarding_completed.is.true,user_id.is.null')
            .order('full_name')
            .order('id')
            .range(from, to),
        )
      : Promise.resolve({ data: [], error: null }),
  ]);
  // A failed PostgREST read arrives as an empty list unless it is looked at,
  // and "nobody has signed" is exactly the wrong thing to show instead.
  if (documentsRead.error)
    console.error('[legal/signatures] could not read the documents:', documentsRead.error.message);
  // A failed members read throws: paged, it would still hand back the rows
  // read before the failure, and the header would count a partial roster.
  const members = unwrap(membersRead);
  const errors = [documentsRead.error].filter((e) => e !== null);

  const docs = sortLegalDocuments(documentsRead.data ?? []);
  // Filtered in memory rather than in the query: a version filter on the
  // embedded waiver_acceptances would drop the embedded rows it did not match
  // and corrupt "last signed". The whole roster is read, a page at a time.
  const rows = buildMemberSignatureRows(docs, members as SignatureMemberInput[], new Date()).filter(
    (r) => matchesSignatureSearch(r, q)
  );

  return (
    <div>
      <PageHeader
        eyebrow={`MEMBER SIGNATURES · ${rows.length}`}
        title="Member signatures"
        sub="Which version of each legal document every active member last signed, and whether it still counts."
        watermark="S"
      />

      <form method="get" className="mb-4 flex max-w-md gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search by name or version"
          aria-label="Search by name or version"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-[var(--line)] px-4 text-sm text-[var(--text-primary)]"
        >
          Search
        </button>
      </form>

      {/* Card chrome from tokens rather than `.card-base`, which only the
          player app declares. Same note as ../page.tsx. Without the roster
          there are no rows at all, so the card would only say "No active
          members yet", which is false. */}
      {!canReadRoster ? (
        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Members are hidden because you cannot view the roster.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--surface)]">
          {errors.length > 0 ? (
            <p role="alert" className="p-5 text-sm text-[var(--color-accent)]">
              The signatures could not be loaded: {errors.map((e) => e.message).join('; ')}
            </p>
          ) : rows.length === 0 ? (
            <p className="p-5 text-sm text-[var(--text-muted)]">
              {q ? `No members match "${q}".` : 'No active members yet.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH}>Name</th>
                  {docs.map((doc) => (
                    <th key={doc.document} className={TH}>
                      {LEGAL_DOCUMENT_SHORT_LABELS[doc.document as WaiverDocument] ?? doc.document}
                    </th>
                  ))}
                  <th className={TH}>Last signed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--line)]">
                    <td className="px-5 py-3 text-[var(--text-primary)]">
                      <Link href={`/players/${row.id}`} className="hover:text-[var(--color-accent)]">
                        {row.name}
                      </Link>
                    </td>
                    {row.documents.map((d) => (
                      <td key={d.document} className="whitespace-nowrap px-5 py-3">
                        {d.lastVersion && <span className="mr-2 font-mono text-xs">{d.lastVersion}</span>}
                        {d.status === 'current' ? (
                          <Badge variant="success">Current</Badge>
                        ) : d.status === 'outdated' ? (
                          <Badge variant="warning">Outdated</Badge>
                        ) : (
                          <Badge variant="neutral">Not signed</Badge>
                        )}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-5 py-3 text-[var(--text-secondary)]">
                      {row.lastSignedAt ? clubDate(row.lastSignedAt) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
