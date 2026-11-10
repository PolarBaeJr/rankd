import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileRules, emailDomainAllowed, formatFinding, lineHits, literalHit, parsePatterns, scan } from '../lib/leaks.mjs';

const config = JSON.parse(readFileSync(new URL('../leak-rules.json', import.meta.url), 'utf8'));
const FORMAT = /^[^:]+:\d+: \[[a-z-]+\] rule [\w-]+$/;

test('every shipped rule compiles, has an id, and is never global', () => {
  const compiled = compileRules(config);
  for (const rule of compiled.rules) {
    assert.ok(rule.id && rule.category && rule.level);
    assert.ok(!rule.re.global, rule.id);
  }
  for (const e of config.exceptions) assert.ok(e.path && e.rule && e.reason);
});

test('a rule scoped by paths or exclude fires only where it applies', () => {
  const compiled = compileRules({
    rules: [
      { id: 'w', category: 'infra', level: 'warn', pattern: 'the box', exclude: ['db/**'] },
      { id: 'f', category: 'infra', level: 'fail', pattern: 'the box', paths: ['db/**'] },
    ],
  });
  assert.deepEqual(lineHits(compiled, 'docs/a.md', 'on the box').map((h) => h.id), ['w']);
  assert.deepEqual(lineHits(compiled, 'db/1.sql', 'on the box').map((h) => h.id), ['f']);
});

test('the Pi and the Mac mini fail in migrations and only warn elsewhere', () => {
  const compiled = compileRules(config);
  for (const line of ['-- runs on the Pi nightly', "-- the Pi's disk", '-- copied to the Mac mini']) {
    const inMigration = lineHits(compiled, 'supabase/migrations/00001_x.sql', line);
    assert.ok(inMigration.some((h) => h.level === 'fail'), line);
    const inDocs = lineHits(compiled, 'docs/releases/1.0.0.md', line);
    assert.ok(inDocs.length > 0 && inDocs.every((h) => h.level === 'warn'), line);
  }
});

test('the iOS Info.plist is excused from the launchd plist rule, nothing else is', () => {
  const compiled = compileRules(config);
  const infoPlist = 'apps/mobile/ios/ClubLadder/Info.plist';
  assert.deepEqual(lineHits(compiled, infoPlist, infoPlist), []);
  assert.ok(lineHits(compiled, 'apps/mobile/ios/README.md', 'load com.example.job.plist').some((h) => h.id === 'plist'));
  assert.ok(lineHits(compiled, 'scripts/a.sh', 'cp Info.plist x').some((h) => h.id === 'plist'));
});

test('infrastructure names and key shapes fail', () => {
  const compiled = compileRules(config);
  assert.ok(lineHits(compiled, 'a.ts', 'see https://app.polardev.org').some((h) => h.id === 'polardev'));
  assert.ok(lineHits(compiled, 'a.ts', 'ssh pi-remote uptime').some((h) => h.id === 'ssh-alias'));
  assert.ok(lineHits(compiled, 'a.ts', `token ghp_${'a'.repeat(36)}`).some((h) => h.level === 'fail'));
  assert.deepEqual(lineHits(compiled, 'a.ts', 'const x = 1;'), []);
});

test('emails fail unless the domain is reserved for examples', () => {
  const compiled = compileRules(config);
  assert.ok(lineHits(compiled, 'a.ts', 'jane@mail.club.internal').some((h) => h.id === 'email-domain'));
  assert.deepEqual(lineHits(compiled, 'a.ts', 'jane@example.org'), []);
  assert.ok(emailDomainAllowed('club.example', config.emailAllow));
  assert.ok(emailDomainAllowed('a.test', config.emailAllow));
  assert.ok(emailDomainAllowed('sub.example.com', config.emailAllow));
  assert.ok(emailDomainAllowed('mail.club.test', ['club.test']));
  assert.ok(!emailDomainAllowed('notclub.test', ['club.test']));
});

test('an exception is per path, per rule, and per matching line', () => {
  const compiled = compileRules({
    rules: [{ id: 'h', category: 'infra', level: 'fail', pattern: 'secret-host' }],
    exceptions: [{ path: 'docs/a.md', rule: 'h', match: 'reviewed', reason: 'test' }],
  });
  assert.deepEqual(lineHits(compiled, 'docs/a.md', 'secret-host reviewed'), []);
  assert.equal(lineHits(compiled, 'docs/a.md', 'secret-host').length, 1);
  assert.equal(lineHits(compiled, 'docs/b.md', 'secret-host reviewed').length, 1);
});

test('personal patterns are case-insensitive literals reported by position only', () => {
  const compiled = compileRules({ rules: [] }, parsePatterns('  Jordan Avery \n\nRiver Example\n'));
  const files = new Map([['notes/river example.md', { text: 'ok\nmet JORDAN AVERY\n' }]]);
  const findings = scan(compiled, files);
  const lines = findings.map(formatFinding);
  assert.deepEqual(lines, ['notes/river example.md:0: [personal] rule personal-2', 'notes/river example.md:2: [personal] rule personal-1']);
  for (const line of lines) {
    assert.match(line, FORMAT);
    assert.ok(!/jordan|avery/i.test(line));
  }
});

test('a report line never echoes the matched value', () => {
  const compiled = compileRules(config);
  const files = new Map([['a.ts', { text: 'x\nmail jane@mail.club.internal at app.polardev.org\n' }]]);
  const lines = scan(compiled, files).map(formatFinding);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.match(line, FORMAT);
    assert.ok(!line.includes('jane') && !line.includes('app.polardev'));
  }
});

test('binaries pass only when generated or reviewed', () => {
  const compiled = compileRules({ rules: [] });
  const files = new Map([
    ['a.png', { binary: true }],
    ['b.png', { binary: true, generated: true }],
    ['fonts/c.woff2', { binary: true }],
  ]);
  const findings = scan(compiled, files, ['fonts/**']);
  assert.deepEqual(findings.map(formatFinding), ['a.png:0: [binary] rule unreviewed-binary']);
});

test('blank and whitespace-only pattern text parses to nothing', () => {
  assert.deepEqual(parsePatterns(undefined), []);
  assert.deepEqual(parsePatterns(''), []);
  assert.deepEqual(parsePatterns(' \n\t\n'), []);
});

test('a personal literal fires only where it stands as a word', () => {
  const hit = (line, literal) => literalHit(line, line.toLowerCase(), literal);
  // The 1.2.0 false positive: a name spelled across two words of an identifier.
  assert.equal(hit('closesWithLastEvent(status)', 'steven'), false);
  assert.equal(hit('closeTournamentAfterLastEvent', 'steven'), false);
  assert.equal(hit('the forest event', 'steven'), false);
  // Real uses still fire: on its own, in an address, at a camelCase seam, at the ends.
  assert.equal(hit('met Steven at the desk', 'steven'), true);
  assert.equal(hit('STEVEN', 'steven'), true);
  assert.equal(hit('steven.example@example.org', 'steven'), true);
  assert.equal(hit('const stevenSmith = 1', 'steven'), true);
  assert.equal(hit('askedSteven()', 'steven'), true);
  assert.equal(hit('steven_2', 'steven'), true);
  assert.equal(hit('steven2@example.org', 'steven'), true);
  // A literal that is an address or has punctuation at its edges.
  assert.equal(hit('mail jo.example@example.org now', 'jo.example@example.org'), true);
  assert.equal(hit('see @handle1', '@handle1'), true);
  // A second occurrence that is a word still fires after one that is not.
  assert.equal(hit('LastEvent then Steven', 'steven'), true);
});
