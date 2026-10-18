// web3.career's free jobs API. Needs a token from https://web3.career/web3-jobs-api
// Docs: GET https://web3.career/api/v1?token=...&limit=1-100 (&tag=solidity, &remote=true)
// web3.career asks that listings link to their apply_url, so we always use it.
import { getJson } from './http.js';

// The response has historically been an array with metadata entries followed by an array of jobs.
// Rather than rely on an exact position, find the first array whose items look like jobs.
export function extractJobs(data) {
  if (Array.isArray(data) && data.length && typeof data[0] === 'object' && !Array.isArray(data[0]) && looksLikeJob(data[0])) return data;
  if (Array.isArray(data)) {
    for (const part of data) {
      const found = extractJobs(part);
      if (found.length) return found;
    }
    return [];
  }
  if (data && typeof data === 'object') {
    for (const key of ['jobs', 'data', 'results']) if (Array.isArray(data[key])) return extractJobs(data[key]);
  }
  return [];
}

function looksLikeJob(o) {
  return o && typeof o === 'object' && ('title' in o) && ('company' in o || 'company_name' in o);
}

const toIso = (job) => {
  if (job.date_epoch) return new Date(Number(job.date_epoch) * 1000).toISOString();
  const d = new Date(job.date || job.published_at || '');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function fetchWeb3Career({ token, tags = [''], limit = 100 }, opts) {
  if (!token) throw new Error('No WEB3CAREER_TOKEN set (get one free at web3.career/web3-jobs-api)');
  const out = new Map();
  for (const tag of tags) {
    const params = new URLSearchParams({ token, limit: String(limit) });
    if (tag) params.set('tag', tag);
    const data = await getJson(`https://web3.career/api/v1?${params}`, opts);
    for (const j of extractJobs(data)) {
      const id = String(j.id ?? j.apply_url ?? `${j.company}|${j.title}`);
      out.set(id, {
        externalId: id,
        company: j.company || j.company_name || 'Unknown',
        title: j.title || '',
        location: [j.city, j.country].filter(Boolean).join(', ') || j.location || '',
        remote: j.is_remote === true || /remote/i.test(String(j.location || '')),
        department: Array.isArray(j.tags) ? j.tags.join(', ') : '',
        url: j.apply_url || j.url || '',
        postedAt: toIso(j),
      });
    }
  }
  return [...out.values()];
}
