// EVERY WRITE TO THE EVENT FIELD GOES THROUGH A FENCED RPC, OR IT IS NOT FENCED.
//
// Migration 00201 put every database function that writes tournament_participants
// or tournament_pairs behind ONE advisory key. That closed nothing on its own,
// because the apps were also writing those tables directly over PostgREST — nine
// call sites taking no lock of any kind, which is why four rounds of review kept
// finding the same class of race in functions that were individually correct.
//
// THIS TEST EXISTS BECAUSE A GREP DID NOT FIND THEM ALL. The worst of the nine
// wrote through a VARIABLE table name:
//
//   const table = isPair ? 'tournament_pairs' : 'tournament_participants';
//   await adminClient.from(table).update({ status })
//
// No search for either table name matches that line, so it survived four
// reviews — and a tenth site in results.ts survived the per-file sweep that
// found the other nine. A census that resolves the variable is the only shape
// that catches them, so that is what this does, and it is the application-side
// half of the pg_proc census in 00201's verification block.
//
// THE RULE
//   - No DELETE or INSERT on a field table from application code. Membership is
//     remove_field_entry's and the entry RPCs' business.
//   - No UPDATE that writes `status`. That is set_field_entry_status,
//     mark_field_entries_no_show, or one of the older fenced RPCs.
//   - UPDATEs that write only ordering or scoring columns are allowed and are
//     listed below. They do not add, remove, or move anybody in or out of the
//     field, which is what the fence protects; they are the application-side
//     counterpart of 00201's allowlist of rating-only database functions.
//
// A NEW write to these tables fails this test until somebody classifies it.
// That is the point: the classification is the review.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const FIELD_TABLES = ['tournament_participants', 'tournament_pairs', 'tournament_event_waitlist'];

/**
 * Columns an application write may set on a field table without a fence, and
 * the ONLY files allowed to set them.
 *
 * Ordering and scoring only. None of these moves anybody in or out of the
 * field, which is what the fence protects — but "the column is harmless" was
 * too weak a rule and 00209 is why. seeding.ts wrote seed_number and
 * group_number from six unfenced call sites, four of them through a runtime
 * `table` variable, and passed this test on the strength of the column names
 * alone. Seeds are the draw's INPUT: a seed landing between the generator
 * building a bracket and publish_event_draw accepting it publishes a bracket
 * whose seeding no longer matches the rows. Those six now go through
 * set_field_entry_seed / auto_seed_field_by_rating / clear_field_seeds /
 * set_field_groups / set_field_entry_group, which take the field key.
 *
 * So the allowance is per FILE as well as per column, and each entry has to
 * say what makes that particular site safe:
 *
 *   brackets.ts   — seed_number and group_number, written INSIDE a generation
 *                   that ends in publish_event_draw. That publication is
 *                   fenced, re-reads the field under the lock, and refuses on
 *                   a mismatched entrant set or a moved group digest (00202),
 *                   so these writes are checked by the step that consumes
 *                   them. They are not free-standing edits the way seeding.ts's
 *                   were.
 *   stages.ts     - seed_number only, and only when stage 1 is drawn from the
 *                   field (a later stage cannot be). The same shape as
 *                   brackets.ts: the generation ends in publish_stage_draw,
 *                   which at stage 1 re-reads the field under the lock and
 *                   refuses on 00202's digest, seed included (00272).
 *   finalize.ts   — final_position and points, written from an event that is
 *                   already over. Nothing downstream draws from them, and the
 *                   flip to completed is itself fenced (00209).
 *   team_category - a staged team's category (00272), which only sets the
 *                   head starts of its matches. It moves nobody in or out of
 *                   the field and is not in 00202's digest. entry-core.ts
 *                   writes it once, on the pair it has just created;
 *                   team-category.ts writes it on one pair and re-snapshots
 *                   that pair's unplayed matches, until the pair has played
 *                   with head starts. After that a change is a request, and
 *                   approve_pair_category_request (00279) writes it under
 *                   the event field key, not this file.
 *
 * A write of one of these columns from ANY OTHER file fails, because the
 * reasoning above is about those two flows and does not transfer.
 */
const UNFENCED_COLUMNS = new Map<string, readonly string[]>([
  ['seed_number', [
    'apps/admin/src/lib/tournament-actions/brackets.ts',
    'apps/admin/src/lib/tournament-actions/stages.ts',
  ]],
  ['group_number', ['apps/admin/src/lib/tournament-actions/brackets.ts']],
  ['team_category', [
    // The pair add's category write, moved with the add into the entry core.
    'apps/admin/src/lib/tournament-actions/entry-core.ts',
    'apps/admin/src/lib/tournament-actions/team-category.ts',
  ]],
  // final_position and points USED TO BE CLASSIFIED HERE, for finalize.ts's
  // writePlacements. 00215 was the last of the four fences and it removed that
  // function: finalisation writes through complete_event_under_field_lock and
  // the corrective recompute writes through
  // rewrite_event_placings_under_field_lock, so finalize.ts now issues no
  // `.update()` at all. A classification for a write that no longer exists is
  // a standing permission for the next one, so it is gone rather than left.
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Other branches' checkouts live under .claude/worktrees and are not this
    // branch's code; scanning them would fail on work that is not here.
    if (['node_modules', '.next', '.claude', '.git', 'dist'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * KNOWN GAPS in this census, named by codex round 11 and left in deliberately.
 * Codex found no current illegal application write through any of them; they
 * are blind spots in a regression guard, not live holes. Recorded here rather
 * than closed because closing them properly means parsing TypeScript, and an
 * AST pass is a bigger and more fragile thing than what it would protect.
 *
 *   1. A VARIABLE update payload defeats it. `.update(patch)` yields no
 *      object literal, objectKeys() returns [], and an empty column list
 *      satisfies every downstream assertion silently — it fails OPEN, not
 *      closed. A new fenced write must therefore pass its columns inline.
 *   2. Indirect aliases are only partly resolved. tableAliases() below matches
 *      a single-quoted table name in the SAME file on the SAME assignment; a
 *      name reaching `.from()` through an import, an object property, or a
 *      template string is invisible.
 *   3. The scan covers apps/ only. A field write added outside apps/ would not
 *      be seen at all.
 *
 * If you add a field-table write, the guard protects you only if it is a
 * literal `.from('...')` with a literal object payload, inside apps/.
 */

/**
 * Identifiers assigned a field-table name anywhere in this file.
 *
 * Deliberately file-wide and not scope-aware: over-collecting a name means a
 * write gets CHECKED that might not have needed it, which fails safe. Missing
 * one means a write goes unchecked, which is the bug this test is about.
 */
function tableAliases(src: string): Set<string> {
  const aliases = new Set<string>();
  const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?'(tournament_participants|tournament_pairs)'/g;
  for (const m of src.matchAll(assign)) {
    if (m[1]) aliases.add(m[1]);
  }
  return aliases;
}

/**
 * Keys of the object literal starting at the head of `src`, and no further.
 *
 * Brace-counted rather than character-windowed: several of these writes are
 * followed by a logAudit call whose own keys would otherwise be attributed to
 * the table write. Nested objects are skipped — a nested key is not a column.
 */
function objectKeys(src: string): string[] {
  if (!src.startsWith('{')) return [];
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      // Only at a key position: preceded by the opening brace or a comma.
      const atKey = /[{,]\s*$/.test(src.slice(0, i));
      if (!atKey) continue;

      // SHORTHAND COUNTS — the terminator is `:` OR `,` OR `}`. Requiring a
      // colon meant `.update({ status })` yielded NO columns at all, so every
      // column-based assertion below passed it vacuously: the status check at
      // "no unfenced write touches status" is precisely the one it defeated,
      // and that is the exact case this census exists to catch.
      const m = /^([A-Za-z_$][\w$]*)\s*(:|,|\}|$)/.exec(src.slice(i));
      if (m?.[1]) {
        keys.push(m[1]);
        // Consume only the identifier: for shorthand the terminator is the next
        // key's delimiter, and swallowing it would hide the key after it.
        i += m[1].length - 1;
        continue;
      }

      // A SPREAD MAKES THE COLUMN LIST UNKNOWABLE, and an unknowable list read
      // as the empty list is the same vacuity in a different costume. Naming it
      // fails the classified-columns assertion instead of passing silently.
      if (/^\.\.\./.test(src.slice(i))) {
        keys.push('...spread');
        i += 2;
      }
    }
  }
  return keys;
}

// A FIXED LOOKAHEAD WINDOW UNDER-REPORTS, AND IT DID. The scan used to slice a
// flat 600 characters after `.from()` and look for the verb inside it, so a long
// explanatory comment between the two pushed the verb out of the window and the
// writer was dropped from the census entirely — silently, because an unclassified
// write is indistinguishable here from no write at all. Measured on the tree that
// shipped it: all three `.from('tournament_participants')` sites in
// apps/player/src/lib/tournament-checkin.ts sat 2226, 651 and -6718 characters
// from their verb, so every one of them went unseen, including a live
// `status: 'checked_in'` write. The guard was reporting coverage it did not have.
//
// Two fixes, because the window had two independent leaks. Comments are blanked
// first — in place, preserving both length and newlines so every offset and line
// number below stays valid — which removes the prose that pushed verbs out of
// range and also stops a `;` inside a comment from reading as a statement end.
// Then the lookahead is bounded by the statement itself rather than by a byte
// count: scan to the `;` that closes the expression, tracking nesting, so a
// builder chain is followed however long it runs and a verb in the NEXT
// statement is still correctly refused.
function blankComments(src: string): string {
  const out = src.split('');
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      // Newlines are kept so that reported line numbers survive the blanking.
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    // Inside a string literal: only the matching quote (unescaped) ends it.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    i++;
  }
  return out.join('');
}

// Everything from `start` to the end of the statement that begins there. Depth
// tracks (), [] and {} so a `;` inside an arrow body or an object literal does
// not end the statement early, and a closing bracket that takes depth below zero
// ends it — that is the enclosing call finishing, e.g. `await foo(sb.from(t))`.
function statementTail(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return src.slice(start, i);
    } else if (c === ';' && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

interface Site {
  file: string;
  line: number;
  verb: string;
  columns: string[];
}

function fieldWrites(file: string, rawSrc: string): Site[] {
  const src = blankComments(rawSrc);
  const aliases = tableAliases(src);
  const sites: Site[] = [];

  // Every `.from(<arg>)` whose argument names a field table, directly or through
  // a ternary, or through an identifier assigned one above.
  const fromCall = /\.from\(\s*([^)]*)\)/g;
  for (const m of src.matchAll(fromCall)) {
    const arg = m[1] ?? '';
    const namesField =
      FIELD_TABLES.some((t) => arg.includes(`'${t}'`) || arg.includes(`"${t}"`)) ||
      [...aliases].some((a) => new RegExp(`^\\s*${a}\\s*$`).test(arg));
    if (!namesField) continue;

    // The write verb, if any, before this statement ends. PostgREST builders
    // chain, so the verb follows the .from() within the same expression — and
    // the expression, not a byte count, is what bounds the search.
    const tail = statementTail(src, m.index! + m[0].length);
    const verbMatch = tail.match(/^[\s\S]*?\.(update|delete|insert|upsert)\(/);
    if (!verbMatch) continue;

    const verb = verbMatch[1] ?? '';
    const afterVerb = tail.slice(verbMatch[0].length);
    // ONLY the update's own object literal. A fixed character window ran past
    // the closing brace and collected field names from the logAudit call that
    // follows several of these writes, which reported columns that are not
    // written to this table at all.
    const columns = objectKeys(afterVerb);

    sites.push({
      file: relative(repoRoot, file),
      line: src.slice(0, m.index!).split('\n').length,
      verb,
      columns,
    });
  }
  return sites;
}

describe('field writes are fenced', () => {
  const files = [join(repoRoot, 'apps')].flatMap((d) => sourceFiles(d));

  const sites = files.flatMap((f) => fieldWrites(f, readFileSync(f, 'utf8')));

  it('finds the field writes at all (a census that matches nothing proves nothing)', () => {
    // The allowed ordering/scoring writes are real and are not going away, so a
    // census returning none of them has stopped working rather than passed.
    //
    // The floor was 8, then 6 when 00209 took seeding.ts's six sites behind
    // fenced RPCs, and is 4 now that 00215 took finalize.ts's placement writes
    // behind the last one — deliberately lowered each time rather than left
    // slack, so that the next unfenced write is a change to this number and
    // therefore a decision somebody has to write down.
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('never deletes or inserts a field row from application code', () => {
    const bad = sites.filter((s) => s.verb === 'delete' || s.verb === 'insert' || s.verb === 'upsert');
    expect(
      bad.map((s) => `${s.file}:${s.line} ${s.verb}()`),
      'Membership changes must go through remove_field_entry or an entry RPC (00201), which take the shared field key. A direct delete/insert takes no lock and can drop or add an entrant a draw was generated from.',
    ).toEqual([]);
  });

  it('never writes an entry status from application code', () => {
    const bad = sites.filter((s) => s.columns.includes('status'));
    expect(
      bad.map((s) => `${s.file}:${s.line} update({ status })`),
      'Entry status must go through set_field_entry_status or mark_field_entries_no_show (00201). Writing it directly takes no lock, so a status can move between publication reading the field and publication committing the draw.',
    ).toEqual([]);
  });

  it('writes only classified columns, and only from the files classified for them', () => {
    const bad = sites
      .flatMap((s) => s.columns.map((c) => ({ ...s, column: c })))
      .filter((s) => {
        const allowed = UNFENCED_COLUMNS.get(s.column);
        // Windows separators would make every path miss, which fails OPEN.
        return !allowed?.includes(s.file.split('\\').join('/'));
      });
    expect(
      bad.map((s) => `${s.file}:${s.line} ${s.column}`),
      'An unfenced write to a field table from a file not classified for that column. Decide whether it can move the field: if it can — and every ordering column can, because ordering is what the draw is built from — it belongs behind a fenced RPC. If the flow it sits in genuinely makes it safe, add the file to UNFENCED_COLUMNS with the reason that makes it safe.',
    ).toEqual([]);
  });
});
