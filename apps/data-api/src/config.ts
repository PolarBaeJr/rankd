// Startup configuration. Pure: takes an env object, returns a config or throws.
//
// The service reaches the database through PostgREST as the `data_api_reader`
// role, carried by a JWT the owner minted once. It is deliberately never given
// the JWT secret (so it cannot mint a token for any other role) nor the
// service_role key (which bypasses every grant 00241 sets up). The role check
// below is the defence against somebody pasting the service_role key, or the
// anon key, into DATA_API_DB_JWT: it decodes the payload WITHOUT verifying it,
// because the only question is "what does this token claim to be", and
// PostgREST does the verifying.
//
// No error message here ever contains a credential's value.

export const READER_ROLE = 'data_api_reader';

/** How many PostgREST calls may be in flight at once (upstream.ts). */
export const UPSTREAM_CONCURRENCY_ENV = 'DATA_API_UPSTREAM_CONCURRENCY';
export const DEFAULT_UPSTREAM_CONCURRENCY = 16;
export const MAX_UPSTREAM_CONCURRENCY = 1024;

export interface Config {
  supabaseUrl: string;
  anonKey: string;
  dbJwt: string;
  port: number;
  upstreamConcurrency: number;
}

export class ConfigError extends Error {}

export function jwtRole(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && typeof payload === 'object' && 'role' in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === 'string' ? role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DATA_API_DB_JWT'].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment: ${missing.join(', ')}`);
  }

  const rawUrl = env.SUPABASE_URL!.trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError('SUPABASE_URL is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('SUPABASE_URL must be http or https');
  }

  const dbJwt = env.DATA_API_DB_JWT!.trim();
  const role = jwtRole(dbJwt);
  if (role !== READER_ROLE) {
    // The role name is safe to print (it is not the credential) and it is the
    // fastest way for the owner to see which key they pasted.
    throw new ConfigError(
      `DATA_API_DB_JWT must carry role "${READER_ROLE}", got ${role === undefined ? 'no readable role' : `"${role}"`}`,
    );
  }

  const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 1 and 65535');
  }

  const rawConcurrency = env[UPSTREAM_CONCURRENCY_ENV];
  const upstreamConcurrency = rawConcurrency?.trim() ? Number(rawConcurrency) : DEFAULT_UPSTREAM_CONCURRENCY;
  if (
    !Number.isInteger(upstreamConcurrency) ||
    upstreamConcurrency < 1 ||
    upstreamConcurrency > MAX_UPSTREAM_CONCURRENCY
  ) {
    throw new ConfigError(`${UPSTREAM_CONCURRENCY_ENV} must be an integer between 1 and ${MAX_UPSTREAM_CONCURRENCY}`);
  }

  return {
    supabaseUrl: rawUrl.replace(/\/+$/, ''),
    anonKey: env.SUPABASE_ANON_KEY!.trim(),
    dbJwt,
    port,
    upstreamConcurrency,
  };
}
