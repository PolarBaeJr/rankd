import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  PLATFORM_ONLY,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  accessLevelFor,
  atLeast,
  effectiveCapabilities,
  isAdminRole,
  isSuperAdminRole,
  permits,
  resolvePermissions,
  type Capability,
} from '../access-level';

// 00321: A SUPER ADMIN HOLDS EVERYTHING, AN ADMIN EVERYTHING BUT PLATFORM_ONLY,
// AND NO ROLE OR GRANT REACHES A PLATFORM_ONLY CAPABILITY.

describe('PLATFORM_ONLY', () => {
  it('is the platform settings and the data API keys', () => {
    expect([...PLATFORM_ONLY].sort()).toEqual([
      'accounts.apikey.mint.write',
      'accounts.apikey.read',
      'accounts.apikey.revoke.write',
      'platform.page',
      'platform.settings.write',
    ]);
    for (const cap of PLATFORM_ONLY) expect(CAPABILITIES).toContain(cap);
  });
});

describe('the two top levels', () => {
  it('gives a super admin every capability', () => {
    const held = effectiveCapabilities('super_admin', UNRESTRICTED);
    expect(held.size).toBe(CAPABILITIES.length);
    for (const cap of CAPABILITIES) expect(held.has(cap)).toBe(true);
  });

  it('gives an admin every capability except PLATFORM_ONLY', () => {
    const held = effectiveCapabilities('admin', UNRESTRICTED);
    expect(held.size).toBe(CAPABILITIES.length - PLATFORM_ONLY.length);
    for (const cap of PLATFORM_ONLY) expect(permits('admin', UNRESTRICTED, cap)).toBe(false);
    for (const cap of CAPABILITIES.filter((c) => !PLATFORM_ONLY.includes(c))) {
      expect(held.has(cap)).toBe(true);
    }
  });

  it('ranks a super admin above an admin', () => {
    expect(atLeast('super_admin', 'admin')).toBe(true);
    expect(atLeast('admin', 'super_admin')).toBe(false);
  });

  it('resolves role super_admin to the super_admin level', () => {
    expect(accessLevelFor({ role: 'super_admin' })).toBe('super_admin');
    expect(accessLevelFor({ role: 'admin' })).toBe('admin');
    expect(isAdminRole('super_admin')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('player')).toBe(false);
    expect(isSuperAdminRole('super_admin')).toBe(true);
    expect(isSuperAdminRole('admin')).toBe(false);
  });
});

describe('nothing grants a PLATFORM_ONLY capability', () => {
  it('is never offered or assignable', () => {
    for (const cap of PLATFORM_ONLY) {
      expect(EDITOR_OFFERABLE).not.toContain(cap);
      expect(EXEC_ASSIGNABLE).not.toContain(cap);
      for (const caps of Object.values(ROLE_DEFAULTS)) expect(caps as readonly Capability[]).not.toContain(cap);
    }
  });

  it('is dropped from a stored grant on an exec or a trainer', () => {
    for (const level of ['exec', 'trainer'] as const) {
      const permissions = resolvePermissions(level, 'custom', [...PLATFORM_ONLY], []);
      for (const cap of PLATFORM_ONLY) expect(permits(level, permissions, cap)).toBe(false);
    }
  });
});
