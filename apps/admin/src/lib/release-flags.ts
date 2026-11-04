import { cache } from 'react';
import {
  ExpectedError,
  readReleaseFlags,
  releaseFlagOffMessage,
  type ReleaseFlagId,
  type ReleaseFlags,
} from '@badminton/shared';
import { createAdminClient } from './supabase-server';

// THE KILL SWITCHES, WHERE THEY MEET A REQUEST. The rules are in
// packages/shared/src/utils/release-flags.ts. Read once per request through
// react cache() by the pages and the server actions alike, with the service
// client, and never throws: a failed read is every switch on.
//
// Not a 'use server' module, so nothing here is a client-callable action. An
// action asks AFTER its capability check: this is a read, and no read comes
// before the gate.

export const getReleaseFlags = cache(async (): Promise<ReleaseFlags> => readReleaseFlags(createAdminClient()));

export async function releaseFlagOn(id: ReleaseFlagId): Promise<boolean> {
  return (await getReleaseFlags())[id];
}

/** Refuses while the switch is off. */
export async function assertReleaseFlag(id: ReleaseFlagId): Promise<void> {
  if (!(await releaseFlagOn(id))) throw new ExpectedError(releaseFlagOffMessage(id));
}
