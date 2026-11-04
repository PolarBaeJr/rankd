import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 00319, READ OFF DISK. pg_cron's own run history is purged nightly. The job
// must only ever touch cron.job_run_details, keep two weeks, and be safe to
// re-run.

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');
const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('00319_'));
const sql = name ? readFileSync(join(MIGRATIONS_DIR, name), 'utf8') : '';

describe('00319 cron history purge', () => {
  it('exists under its release number', () => {
    expect(name).toBe('00319_pg_cron_forgets_old_runs.sql');
  });

  it('deletes only pg_cron history older than 14 days', () => {
    const deletes = sql.match(/DELETE FROM [a-z_.]+/g) ?? [];
    expect(deletes.every((d) => d === 'DELETE FROM cron.job_run_details')).toBe(true);
    expect(deletes.length).toBeGreaterThan(0);
    expect(sql).toContain("WHERE start_time < now() - interval '14 days'");
  });

  it('is re-runnable and verified', () => {
    expect(sql).toContain("PERFORM cron.unschedule('cron-history-purge')");
    expect(sql).toContain("RAISE EXCEPTION '00319: cron-history-purge is not scheduled as written'");
  });

  it('has no top-level COMMIT and no em dash', () => {
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
    expect(sql).not.toContain('—');
  });
});
