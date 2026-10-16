import { describe, expect, it } from 'vitest';
import { ConfigError, jwtRole, loadConfig } from '../config.js';

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

const READER = jwt({ role: 'data_api_reader', iss: 'supabase' });
const base = { SUPABASE_URL: 'http://kong:8000/', SUPABASE_ANON_KEY: 'anon', DATA_API_DB_JWT: READER };

describe('loadConfig', () => {
  it('accepts a reader JWT and defaults the port', () => {
    const config = loadConfig(base);
    expect(config).toEqual({
      supabaseUrl: 'http://kong:8000',
      anonKey: 'anon',
      dbJwt: READER,
      port: 8080,
      upstreamConcurrency: 16,
    });
    expect(loadConfig({ ...base, PORT: '9000' }).port).toBe(9000);
  });

  it.each(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DATA_API_DB_JWT'])('refuses to start without %s', (name) => {
    expect(() => loadConfig({ ...base, [name]: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [name]: '  ' })).toThrow(new RegExp(name));
  });

  it.each(['service_role', 'anon', 'authenticated'])('refuses a JWT whose role is %s', (role) => {
    const token = jwt({ role, iss: 'supabase' });
    expect(() => loadConfig({ ...base, DATA_API_DB_JWT: token })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, DATA_API_DB_JWT: token });
    } catch (err) {
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('refuses something that is not a JWT at all', () => {
    expect(() => loadConfig({ ...base, DATA_API_DB_JWT: 'sb_secret_abc' })).toThrow(/no readable role/);
    expect(() => loadConfig({ ...base, DATA_API_DB_JWT: jwt({ iss: 'supabase' }) })).toThrow(ConfigError);
  });

  it('refuses a bad URL or port', () => {
    expect(() => loadConfig({ ...base, SUPABASE_URL: 'kong' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: 'eighty' })).toThrow(ConfigError);
  });

  it('reads DATA_API_UPSTREAM_CONCURRENCY, 16 when unset or blank', () => {
    expect(loadConfig({ ...base, DATA_API_UPSTREAM_CONCURRENCY: '4' }).upstreamConcurrency).toBe(4);
    expect(loadConfig({ ...base, DATA_API_UPSTREAM_CONCURRENCY: ' 1024 ' }).upstreamConcurrency).toBe(1024);
    expect(loadConfig({ ...base, DATA_API_UPSTREAM_CONCURRENCY: '  ' }).upstreamConcurrency).toBe(16);
    expect(loadConfig({ ...base, DATA_API_UPSTREAM_CONCURRENCY: '0x10' }).upstreamConcurrency).toBe(16);
  });

  it.each(['0', '-1', '1025', '2.5', 'many', '1e9'])('refuses DATA_API_UPSTREAM_CONCURRENCY=%s', (value) => {
    expect(() => loadConfig({ ...base, DATA_API_UPSTREAM_CONCURRENCY: value })).toThrow(
      new ConfigError('DATA_API_UPSTREAM_CONCURRENCY must be an integer between 1 and 1024'),
    );
  });
});

describe('jwtRole', () => {
  it('reads the role claim without verifying', () => {
    expect(jwtRole(READER)).toBe('data_api_reader');
    expect(jwtRole('a.b')).toBeUndefined();
    expect(jwtRole('a.!!!.c')).toBeUndefined();
  });
});
