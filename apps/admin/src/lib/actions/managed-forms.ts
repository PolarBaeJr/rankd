'use server';

import { z } from 'zod';
import { ExpectedError, parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { updateCapabilityFor } from '../registration-form-binding';
import * as managed from '../managed-forms';

// THE FORMS THE CONSOLE MAKES (00296): the console's buttons.
//
// EVERY EXPORTED PARAMETER BELOW IS A CLIENT-CONTROLLED POST FIELD. Create
// takes a kind and an id, both checked; Check again and Replace take a row id
// and read the kind and target from the stored row. The capability is the one
// that edits the target, as binding a form by hand asks (00283).

const uuid = z.string().uuid();
const kindSchema = z.enum(['club_event', 'tournament']);

export async function createManagedForm(
  kind: 'club_event' | 'tournament',
  targetId: string,
): Promise<ActionResult<{ outcome: string }>> {
  return runAction(async () => {
    const parsedKind = parseOrThrow(kindSchema, kind);
    const id = parseOrThrow(uuid, targetId);
    const actor = await requireCapability(updateCapabilityFor(parsedKind));
    const outcome = await managed.ensureManagedForm(createAdminClient(), actor.id as string, parsedKind, id);
    if (outcome === 'not_configured') throw new ExpectedError('The form maker is not set up for this console.');
    if (outcome === 'skipped') {
      throw new ExpectedError('This already has a Google Form linked by hand, or its club event takes the sign-ups.');
    }
    return { outcome };
  });
}

async function storedRow(rowId: string) {
  const id = parseOrThrow(uuid, rowId);
  const admin = createAdminClient();
  const row = await managed.loadManagedFormRow(admin, id);
  if (!row) throw new ExpectedError('That form no longer exists.');
  const actor = await requireCapability(updateCapabilityFor(row.target_kind));
  return { admin, row, actorId: actor.id as string };
}

export async function recheckManagedForm(rowId: string): Promise<ActionResult<{ outcome: string }>> {
  return runAction(async () => {
    const { admin, row, actorId } = await storedRow(rowId);
    return { outcome: await managed.recheckManagedForm(admin, actorId, row) };
  });
}

export async function replaceManagedForm(rowId: string): Promise<ActionResult<{ outcome: string }>> {
  return runAction(async () => {
    const { admin, row, actorId } = await storedRow(rowId);
    return { outcome: await managed.replaceManagedForm(admin, actorId, row) };
  });
}
