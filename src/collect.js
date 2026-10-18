// One scan: pull every source, store what's new, mark what's gone, and score everything still open.
import { ATS_FETCHERS } from './sources/ats.js';
import { fetchWeb3Career } from './sources/web3career.js';
import { normCompany, normTitle, isSenior, categorize } from './classify.js';
import { computeSignals } from './signals.js';

export function buildTargets(watchlist, env = process.env) {
  const targets = watchlist.companies.map((c) => ({
    key: `${c.ats}:${c.slug}`,
    label: `${c.name} (${c.ats})`,
    source: c.ats,
    closeMissing: true, // a careers page lists every open role, so a missing role has closed
    run: (opts) => ATS_FETCHERS[c.ats](c, opts),
  }));
  if (watchlist.web3career?.enabled) {
    targets.push({
      key: 'web3career',
      label: 'web3.career',
      source: 'web3career',
      closeMissing: false, // the API only returns the latest listings, so absence means nothing
      run: (opts) => fetchWeb3Career({ token: env.WEB3CAREER_TOKEN, tags: watchlist.web3career.tags || [''] }, opts),
    });
  }
  return targets;
}

export async function collect(db, targets, { now = new Date(), fetchImpl, concurrency = 4 } = {}) {
  const nowIso = now.toISOString();
  const newJobs = [];
  const results = [];

  const getRun = db.prepare('SELECT * FROM source_runs WHERE source_key = ?');
  const upsertRun = db.prepare(`
    INSERT INTO source_runs (source_key, label, last_run, last_ok, last_error, job_count, runs)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(source_key) DO UPDATE SET label = excluded.label, last_run = excluded.last_run,
      last_ok = COALESCE(excluded.last_ok, source_runs.last_ok), last_error = excluded.last_error,
      job_count = CASE WHEN excluded.last_ok IS NULL THEN source_runs.job_count ELSE excluded.job_count END,
      runs = source_runs.runs + 1`);
  const getJob = db.prepare('SELECT id FROM jobs WHERE id = ?');
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, source, source_key, external_id, company, company_key, title, title_key, location, remote,
      department, category, senior, url, posted_at, first_seen, last_seen, baseline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const touchJob = db.prepare(`
    UPDATE jobs SET last_seen = ?, closed_at = NULL, title = ?, title_key = ?, location = ?, remote = ?,
      department = ?, category = ?, senior = ?, url = ? WHERE id = ?`);
  const closeMissing = db.prepare(`UPDATE jobs SET closed_at = ? WHERE source_key = ? AND closed_at IS NULL AND last_seen < ?`);

  // Fetch a few sources at a time so one slow site doesn't hold everything up.
  const queue = [...targets];
  const fetched = [];
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      try { fetched.push({ t, jobs: await t.run({ fetchImpl }) }); }
      catch (err) { fetched.push({ t, error: err.message || String(err) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker));

  for (const { t, jobs, error } of fetched) {
    if (error) {
      upsertRun.run(t.key, t.label, nowIso, null, error, 0);
      results.push({ key: t.key, label: t.label, ok: false, error });
      continue;
    }
    const firstScan = !getRun.get(t.key)?.last_ok;
    let added = 0;
    db.exec('BEGIN');
    try {
      for (const j of jobs) {
        if (!j.title) continue;
        const id = `${t.source}:${j.externalId}`;
        const fields = {
          title: j.title.trim(),
          title_key: normTitle(j.title),
          location: j.location || '',
          remote: j.remote || /remote/i.test(j.location || '') ? 1 : 0,
          department: j.department || '',
          category: categorize(j.title, j.department),
          senior: isSenior(j.title) ? 1 : 0,
          url: j.url || '',
        };
        if (getJob.get(id)) {
          touchJob.run(nowIso, fields.title, fields.title_key, fields.location, fields.remote, fields.department,
            fields.category, fields.senior, fields.url, id);
        } else {
          insertJob.run(id, t.source, t.key, j.externalId, j.company, normCompany(j.company), fields.title, fields.title_key,
            fields.location, fields.remote, fields.department, fields.category, fields.senior, fields.url,
            j.postedAt, nowIso, nowIso, firstScan ? 1 : 0);
          added++;
          if (!firstScan) newJobs.push(id);
        }
      }
      if (t.closeMissing) closeMissing.run(nowIso, t.key, nowIso);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    upsertRun.run(t.key, t.label, nowIso, nowIso, null, jobs.length);
    results.push({ key: t.key, label: t.label, ok: true, count: jobs.length, added, firstScan });
  }

  rescoreOpenJobs(db, now);
  return { newJobs, results };
}

export function rescoreOpenJobs(db, now = new Date()) {
  const open = db.prepare('SELECT * FROM jobs WHERE closed_at IS NULL').all();
  const save = db.prepare('UPDATE jobs SET signals = ?, heat = ? WHERE id = ?');
  db.exec('BEGIN');
  for (const job of open) {
    const { signals, heat } = computeSignals(db, job, now);
    save.run(JSON.stringify(signals), heat, job.id);
  }
  db.exec('COMMIT');
}
