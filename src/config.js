// Reads the two config files. Both are plain JSON you can edit.
import fs from 'node:fs';
import path from 'node:path';
import { parseCareersUrl } from './sources/ats.js';

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.cwd(), 'config');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw new Error(`Couldn't read config/${file}: ${err.message}`); }
}

export function loadWatchlist() {
  const raw = readJson('watchlist.json', { companies: [], web3career: { enabled: false } });
  const companies = [];
  const problems = [];
  for (const c of raw.companies || []) {
    if (!c || c.disabled) continue;
    const parsed = c.careers ? parseCareersUrl(c.careers) : (c.ats && c.slug ? { ats: c.ats, slug: c.slug } : null);
    if (!parsed) { problems.push(`${c.name || '(no name)'}: careers link not recognised (${c.careers || 'missing'})`); continue; }
    companies.push({ name: c.name || parsed.slug, ...parsed });
  }
  return { companies, web3career: raw.web3career || { enabled: false }, problems };
}

export function loadSettings() {
  return readJson('settings.json', {});
}
