export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { PageHeader } from '@badminton/ui';
import { sortLegalDocuments, getMissingLegalDocuments, selectAllPages, unwrap } from '@badminton/shared';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { LegalConsole, type DocumentSignatures, type LegalDocumentRow } from './legal-documents-form';
import { EventWaiverTemplateForm } from './event-waiver-template-form';

// Its own section rather than a block inside Settings, because two different
// audiences need it: an admin editing the text, and an exec who needs to read
// what members agreed to — or make everyone re-sign before an event.
//
// legal.read is what opens the section, and an exec holds it. Editing asks for
// legal.documents.write and legal.waivertemplate.write, which no baseline below
// admin holds; requiring a re-signature asks for legal.reacceptance.write, which
// every exec holds.
//
// EVERY FETCH BELOW IS GATED ON THE CAPABILITY ITS DATA NEEDS, not on the page
// key and not on "is this person an admin". The signature panel is the reason
// this matters: it reads the ROSTER — names, photos, who has not signed — which
// is players.read, a different key from the one that opened this section. A
// conditional render over an unconditional query does not withhold anything;
// the rows still ship inside the RSC payload and are readable with devtools.
// So the query itself is skipped, and the panel renders a sentence saying so.
export default async function LegalPage() {
  const viewer = await requireCapability('legal.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const canEdit = permits(level, permissions, 'legal.documents.write');
  // Forcing the whole club to re-sign is the loudest thing this page does, and
  // it is a separate capability from editing the text and from reading it.
  const canRequireReacceptance = permits(level, permissions, 'legal.reacceptance.write');
  // Editing the event-waiver template is its own capability, not a second
  // reading of canEdit: they sit in the same baseline today, and nothing but
  // this line would keep them apart the day one is handed out alone.
  const canEditWaiverTemplate = permits(level, permissions, 'legal.waivertemplate.write');
  // The roster key, held by execs and trainers. NOT legal.page: somebody can be
  // given the documents to read without being given the membership list.
  const canReadRoster = permits(level, permissions, 'players.read');

  const adminClient = createAdminClient();
  // reacceptance_required_since is selected because getMissingLegalDocuments
  // reads it — without it every forced re-signature would look satisfied.
  const { data: legalDocuments } = await adminClient
    .from('legal_documents')
    .select('document, version, content, updated_at, reacceptance_required_since');
  const documents: LegalDocumentRow[] = sortLegalDocuments(legalDocuments ?? []);

  // Event-waiver templates are per season (00074) and are NOT legal_documents
  // rows — that table is the list of things every member must accept, and a
  // fifth row in it would block the whole club out of the player app.
  // Newest season first: the one being drafted for is almost always the target.
  const [{ data: seasons }, { data: waiverTemplates }] = await Promise.all([
    adminClient
      .from('seasons')
      .select('id, name, active_flag')
      .order('year', { ascending: false })
      .order('term', { ascending: false }),
    adminClient.from('event_waiver_templates').select('season_id, content, updated_at'),
  ]);

  // WHO HAS SIGNED WHAT. Gated on players.read and skipped entirely without it.
  //
  // active_flag = true is the population the player app actually gates: account
  // deletion clears the flag (00012) and the row is later anonymised, so
  // counting every players row would put deleted members into the sentence
  // "N members are gated until they sign again" — the loudest number here, and
  // the one that must not be inflated.
  let signatures: Record<string, DocumentSignatures> | null = null;
  let activeMemberCount: number | null = null;
  if (canReadRoster) {
    // PAGED, and a failed read throws. activeMemberCount is counted from these
    // rows and is the number in "all N active members are gated", the loudest
    // sentence on the screen, so it must not be silently cut at db-max-rows
    // (1,000) or turned into 0 by a read that failed.
    const members = unwrap(
      await selectAllPages((from, to) =>
        adminClient
          .from('players')
          .select('id, full_name, avatar_url, waiver_reset_at, waiver_acceptances(document, version, accepted_at)')
          .eq('active_flag', true)
          // 00132. A stub created at first sign-in is active_flag = TRUE and has no
          // acceptances, so without this it would land in activeMemberCount AND in
          // the non-compliant list, inflating the denominator of "all N active
          // members are gated" with people who have not been asked to sign anything
          // yet. Onboarding is where the waiver is collected; somebody who has not
          // reached the end of it is not out of compliance.
          .or('onboarding_completed.is.true,user_id.is.null')
          .order('full_name')
          .order('id')
          .range(from, to),
      ),
    );
    activeMemberCount = members.length;
    const now = new Date();
    signatures = {};

    for (const doc of documents) {
      const outstanding: DocumentSignatures['members'] = [];
      let signed = 0;

      for (const member of members) {
        const acceptances = (member.waiver_acceptances ?? []) as {
          document: string;
          version: string;
          accepted_at: string;
        }[];
        // The SHARED helper, one document at a time, rather than re-deriving
        // "has signed" here. It carries three rules this panel would otherwise
        // have to duplicate and would eventually contradict: the waiver expires
        // after a year, a forced re-acceptance invalidates anything older than
        // its stamp, and waiver_reset_at does the same for one member. The
        // player app's gate calls the same function, so a member listed as
        // outstanding here is exactly a member who will be stopped there.
        const missing = getMissingLegalDocuments([doc], acceptances, now, member.waiver_reset_at);
        if (missing.length === 0) {
          signed++;
          continue;
        }

        // What they last signed, whatever version that was. This is the pair of
        // facts the console could not show anywhere until now — the roster's
        // Waiver column reduces all of it to a tick — and it is what turns "12
        // outstanding" into something an exec can act on: a member sitting on
        // v2 needs a nudge, a member who never signed at all is a different
        // conversation.
        const forDoc = acceptances.filter((a) => a.document === doc.document);
        const latest = forDoc.reduce<(typeof forDoc)[number] | null>(
          (best, a) =>
            best === null || new Date(a.accepted_at) > new Date(best.accepted_at) ? a : best,
          null
        );

        outstanding.push({
          id: member.id,
          full_name: member.full_name,
          avatar_url: member.avatar_url,
          last_signed_version: latest?.version ?? null,
          last_signed_at: latest?.accepted_at ?? null,
        });
      }

      signatures[doc.document] = { signed, members: outstanding };
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={`DOCUMENTS · ${documents.length} LIVE`}
        title="Legal"
        sub="What members agree to, and when they agreed to it."
        watermark="L"
      />

      {canReadRoster && (
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          <Link href="/legal/signatures" className="underline hover:text-[var(--color-accent)]">
            See which version every member last signed
          </Link>
        </p>
      )}

      <LegalConsole
        documents={documents}
        signatures={signatures}
        activeMemberCount={activeMemberCount}
        canEdit={canEdit}
        canRequireReacceptance={canRequireReacceptance}
      />

      {/* Its own card, below the documents, because it is a different kind of
          thing: nobody accepts this text as-is. It is the wording a
          tournament's own event waiver starts from. */}
      {/* Card chrome from tokens rather than `.card-base`: that class is
          declared only in the player app's globals.css, so in the console it
          styles nothing at all. See the note in ./legal-documents-form.tsx. */}
      <div className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5">
        <p className="settings-section-desc">
          The event waiver a tournament starts from, kept per season so each term&rsquo;s
          venue and club terms can differ.{' '}
          {canEditWaiverTemplate
            ? 'Execs pull it into an event when they create a tournament.'
            : 'Only an admin can change this text. You can use it when you create a tournament.'}
        </p>
        <EventWaiverTemplateForm
          seasons={seasons ?? []}
          templates={waiverTemplates ?? []}
          canEdit={canEditWaiverTemplate}
        />
      </div>
    </div>
  );
}
