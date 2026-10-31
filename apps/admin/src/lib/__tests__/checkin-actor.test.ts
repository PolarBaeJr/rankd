import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// THE CHECK-IN WINDOW (00276) TELLS A MEMBER FROM THE DESK BY p_actor ALONE.
//
// set_field_entry_status refuses a 'checked_in' outside the window only when
// p_actor is null, because that is how the player app calls it for a member's
// own check-in. An admin call that passed null with 'checked_in' would be gated
// like a member, and the desk would be refused at the door it exists to run.
// So: in the admin app a null actor goes with 'no_show' and nothing else, and
// the player app only ever checks in with a null actor.

const ADMIN_SRC = join(__dirname, '../..');
const PLAYER_SRC = join(__dirname, '../../../../player/src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every call's argument object for one RPC (set_field_entry_status by default), comments stripped. */
function calls(dir: string, rpc = 'set_field_entry_status'): Array<{ file: string; args: string }> {
  const out: Array<{ file: string; args: string }> = [];
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    const marker = `.rpc('${rpc}', {`;
    let at = source.indexOf(marker);
    while (at !== -1) {
      const start = at + marker.length;
      const end = source.indexOf('})', start);
      const args = source.slice(start, end).replace(/\/\/.*$/gm, '');
      out.push({ file: relative(dir, file), args });
      at = source.indexOf(marker, end);
    }
  }
  return out;
}

const field = (args: string, name: string) => new RegExp(String.raw`${name}:\s*([^,\n]+)`).exec(args)?.[1]?.trim();

describe('who set_field_entry_status thinks is checking in', () => {
  it('admin: a null actor is only ever a no-show', () => {
    const admin = calls(ADMIN_SRC);
    expect(admin.length).toBeGreaterThan(0);
    const nullActor = admin.filter((c) => field(c.args, 'p_actor') === 'null');
    expect(nullActor.length).toBeGreaterThan(0);
    for (const c of nullActor) {
      expect(field(c.args, 'p_new_status'), c.file).toBe("'no_show'");
    }
  });

  it('admin: every check-in names the officer', () => {
    for (const c of calls(ADMIN_SRC).filter((x) => field(x.args, 'p_new_status') === "'checked_in'")) {
      expect(field(c.args, 'p_actor'), c.file).not.toBe('null');
    }
  });

  // enter_tournament_event refuses outside the registration window for every
  // caller, so the desk adding somebody must never go through it.
  it('admin: never calls enter_tournament_event', () => {
    for (const file of sourceFiles(ADMIN_SRC)) {
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code.includes('enter_tournament_event'), relative(ADMIN_SRC, file)).toBe(false);
    }
  });

  it('player: every call is a member checking themselves in, with a null actor', () => {
    const player = calls(PLAYER_SRC);
    expect(player.length).toBeGreaterThan(0);
    for (const c of player) {
      expect(field(c.args, 'p_actor'), c.file).toBe('null');
      expect(field(c.args, 'p_new_status'), c.file).toBe("'checked_in'");
    }
  });
});

// 00309's per-person check-in copies the same window gate on p_actor IS NULL,
// so the desk must always name the officer there too.
describe('who set_pair_member_check_in thinks is checking in', () => {
  it('admin: every call names the officer', () => {
    const admin = calls(ADMIN_SRC, 'set_pair_member_check_in');
    expect(admin.length).toBeGreaterThan(0);
    for (const c of admin) {
      expect(field(c.args, 'p_actor'), c.file).not.toBe('null');
      expect(field(c.args, 'p_actor'), c.file).toBeDefined();
    }
  });

  it('player: never calls it, so a member checks in as a whole team', () => {
    expect(calls(PLAYER_SRC, 'set_pair_member_check_in')).toEqual([]);
  });
});
