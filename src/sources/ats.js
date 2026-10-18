// Company careers pages hosted on Greenhouse, Lever or Ashby. All three publish open job lists
// without needing a key. Each function returns jobs in one common shape.
import { getJson } from './http.js';

// Work out which system a careers link uses, e.g. https://jobs.lever.co/acme -> { ats: 'lever', slug: 'acme' }
export function parseCareersUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const slug = u.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  if (host.endsWith('greenhouse.io')) return { ats: 'greenhouse', slug };
  if (host === 'jobs.lever.co') return { ats: 'lever', slug };
  if (host === 'jobs.eu.lever.co') return { ats: 'lever', slug, region: 'eu' };
  if (host === 'jobs.ashbyhq.com') return { ats: 'ashby', slug };
  return null;
}

const asDate = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function fetchGreenhouse({ slug, name }, opts) {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`, opts);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j) => ({
    externalId: String(j.id),
    company: name || j.company_name || slug,
    title: j.title || '',
    location: j.location?.name || '',
    department: (j.departments || []).map((d) => d.name).join(', '),
    url: j.absolute_url || '',
    postedAt: asDate(j.first_published || j.updated_at),
  }));
}

export async function fetchLever({ slug, name, region }, opts) {
  const host = region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const data = await getJson(`https://${host}/v0/postings/${encodeURIComponent(slug)}?mode=json`, opts);
  const jobs = Array.isArray(data) ? data : [];
  return jobs.map((j) => ({
    externalId: String(j.id),
    company: name || slug,
    title: j.text || '',
    location: j.categories?.location || (j.categories?.allLocations || []).join(', ') || '',
    remote: j.workplaceType === 'remote',
    department: [j.categories?.department, j.categories?.team].filter(Boolean).join(' / '),
    url: j.hostedUrl || j.applyUrl || '',
    postedAt: asDate(j.createdAt),
  }));
}

export async function fetchAshby({ slug, name }, opts) {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, opts);
  const jobs = (Array.isArray(data?.jobs) ? data.jobs : []).filter((j) => j.isListed !== false);
  return jobs.map((j) => ({
    externalId: String(j.id),
    company: name || slug,
    title: j.title || '',
    location: j.location || '',
    remote: j.isRemote === true || /remote/i.test(j.workplaceType || ''),
    department: [j.department, j.team].filter(Boolean).join(' / '),
    url: j.jobUrl || j.applyUrl || '',
    postedAt: asDate(j.publishedAt),
  }));
}

export const ATS_FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby };
