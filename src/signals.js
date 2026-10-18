// "Why it's a lead": looks at a job in the context of everything else we've seen from that company.
const DAY = 86400000;

export function computeSignals(db, job, now = new Date()) {
  const signals = [];
  let heat = 0;
  const nowMs = now.getTime();
  const firstSeenMs = new Date(job.first_seen).getTime();
  const weekAgo = new Date(nowMs - 7 * DAY).toISOString();

  // 1. Hiring burst: several roles from the same company in the last week.
  const burst = db.prepare(
    `SELECT COUNT(DISTINCT title_key) n FROM jobs WHERE company_key = ? AND first_seen >= ? AND baseline = 0`
  ).get(job.company_key, weekAgo).n;
  if (burst >= 3) { signals.push(`${burst} new roles in 7 days`); heat += 30; }

  // 2. A similar role was already seen a month or more ago: reposted or still unfilled.
  const older = db.prepare(
    `SELECT MIN(first_seen) fs FROM jobs WHERE company_key = ? AND title_key = ? AND id != ? AND first_seen <= ?`
  ).get(job.company_key, job.title_key, job.id, new Date(firstSeenMs - 30 * DAY).toISOString());
  if (older?.fs) {
    const days = Math.round((nowMs - new Date(older.fs).getTime()) / DAY);
    signals.push(`Same role first seen ${days} days ago (reposted or unfilled)`);
    heat += 25;
  }

  // 3. Open a long time: likely struggling to hire.
  const ageFrom = job.posted_at ? Math.min(new Date(job.posted_at).getTime(), firstSeenMs) : firstSeenMs;
  const ageDays = Math.round((nowMs - ageFrom) / DAY);
  if (!job.closed_at && ageDays >= 45) { signals.push(`Open ${ageDays} days`); heat += 20; }

  if (!job.baseline) {
    // 4. First role we've ever seen from this company.
    const earlier = db.prepare(
      `SELECT COUNT(*) n FROM jobs WHERE company_key = ? AND first_seen < ? AND id != ?`
    ).get(job.company_key, job.first_seen, job.id).n;
    if (earlier === 0) { signals.push('First role seen from this company'); heat += 15; }
    else {
      // 5. First role in this area (e.g. their first security hire).
      // Roles that appeared in the same scan are ordered by id, so only one of them is "first".
      const sameCat = db.prepare(
        `SELECT COUNT(*) n FROM jobs WHERE company_key = ? AND category = ? AND id != ?
           AND (first_seen < ? OR (first_seen = ? AND id < ?))`
      ).get(job.company_key, job.category, job.id, job.first_seen, job.first_seen, job.id).n;
      if (sameCat === 0 && job.category !== 'other') {
        signals.push(`First ${CATEGORY_LABEL[job.category] || job.category} role seen there`);
        heat += 15;
      }
    }
  }

  // 6. Seniority.
  if (job.senior) { signals.push('Senior hire'); heat += 15; }

  // Fresh listings matter more for BD.
  const freshDays = (nowMs - firstSeenMs) / DAY;
  if (!job.baseline && freshDays <= 2) heat += 10;

  return { signals, heat: Math.min(100, heat) };
}

export const CATEGORY_LABEL = {
  engineering: 'engineering', security: 'security', bd: 'BD & sales', marketing: 'marketing', ops: 'operations', other: 'other',
};
