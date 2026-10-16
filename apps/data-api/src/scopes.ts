// A copy of DATA_API_SCOPES in packages/shared/src/utils/data-api-key.ts, which
// is what the console mints with and what the SQL CHECK
// data_api_keys_scope_vocabulary admits (00283). This service compiles only its
// own src/, so it cannot import that file at runtime; __tests__/scopes.test.ts
// asserts the two lists are identical.

export const DATA_API_SCOPES = [
  'players:read',
  'matches:read',
  'ratings:history:read',
  'seasons:read',
  'tournaments:read',
  'schedule:read',
  'predictions:write',
  'registrations:write',
] as const;

export type DataApiScope = (typeof DATA_API_SCOPES)[number];
