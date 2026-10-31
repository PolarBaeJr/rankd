// WHO IS AT THE COURT (00310). Server side only, and NOT 'use server': the
// signed-in console user with their level and permissions, for the court
// helper page and its result action.
//
// Its own module so a test can mock this one seam. Many suites mock
// ./supabase-server with only the exports they need, and a results.ts that
// reached getAuthenticatedConsoleUser directly would break every one of them.

import { getAuthenticatedConsoleUser } from './supabase-server';
import { accessLevelFor, permissionsOf } from './permissions';

export async function requireConsoleUser() {
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(level, viewer);
  return { viewer, level, permissions };
}
