import { cache } from 'react';
import {
  ALL_RELEASE_FLAGS_ON,
  ExpectedError,
  readReleaseFlags,
  releaseFlagOffMessage,
  type ReleaseFlagId,
  type ReleaseFlags,
} from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';

// THE KILL SWITCHES, ON THE MEMBERS' SIDE. The rules are in
// packages/shared/src/utils/release-flags.ts and the console's reader is
// apps/admin/src/lib/release-flags.ts; this is the same read, once per request
// through react cache(), with the service client. Never throws: a failed read,
// or a client that cannot be built, is every switch on.
//
// Not a 'use server' module, so nothing here is a client-callable action.

export const getReleaseFlags = cache(async (): Promise<ReleaseFlags> => {
  try {
    return await readReleaseFlags(createServiceRoleClient());
  } catch (err) {
    console.error('[release-flags] could not build the settings client, using all on:', err);
    return { ...ALL_RELEASE_FLAGS_ON };
  }
});

export async function releaseFlagOn(id: ReleaseFlagId): Promise<boolean> {
  return (await getReleaseFlags())[id];
}

/** Refuses while the switch is off. */
export async function assertReleaseFlag(id: ReleaseFlagId): Promise<void> {
  if (!(await releaseFlagOn(id))) throw new ExpectedError(releaseFlagOffMessage(id));
}
