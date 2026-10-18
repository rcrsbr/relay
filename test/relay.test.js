import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parseCareersUrl, fetchGreenhouse, fetchLever, fetchAshby } from '../src/sources/ats.js';
import { extractJobs, fetchWeb3Career } from '../src/sources/web3career.js';
import { categorize, isSenior, normTitle, normCompany } from '../src/classify.js';
import { buildTargets, collect } from '../src/collect.js';
import { evaluateAlerts, sendAlerts, linkTelegram, telegramChatId } from '../src/alerts.js';
import { renderFeed, renderSources, dedupe, startServer } from '../src/web.js';
import { fakeFetch, greenhouse, lever, ashby, web3career } from './helpers.js';

const DAY = 86400000;
const T0 = new Date('2026-10-01T09:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);
const quiet = () => {};

test('recognises careers links for each system', () => {
  assert.deepEqual(parseCareersUrl('https://boards.greenhouse.io/coinbase'), { ats: 'greenhouse', slug: 'coinbase' });
  assert.deepEqual(parseCareersUrl('https://job-boards.greenhouse.io/ripple/jobs/123'), { ats: 'greenhouse', slug: 'ripple' });
  assert.deepEqual(parseCareersUrl('https://jobs.lever.co/anchorage'), { ats: 'lever', slug: 'anchorage' });
  assert.deepEqual(parseCareersUrl('https://jobs.eu.lever.co/acme'), { ats: 'lever', slug: 'acme', region: 'eu' });
  assert.deepEqual(parseCareersUrl('https://jobs.ashbyhq.com/kraken.com'), { ats: 'ashby', slug: 'kraken.com' });
  assert.equal(parseCareersUrl('https://example.com/careers'), null);
  assert.equal(parseCareersUrl('not a url'), null);
});

test('classifies titles', () => {
  assert.equal(categorize('Senior Solidity Engineer'), 'engineering');
  assert.equal(categorize('Smart Contract Auditor'), 'security');
  assert.equal(categorize('Head of Business Development, APAC'), 'bd');
  assert.equal(categorize('Community Manager'), 'marketing');
  assert.equal(categorize('Compliance Lead'), 'ops');
  assert.equal(isSenior('Staff Backend Engineer'), true);
  assert.equal(isSenior('Backend Engineer'), false);
  assert.equal(normTitle('Senior Rust Engineer (Remote, EU)'), normTitle('Senior Rust Engineer - Remote'));
  assert.equal(normCompany('Uniswap Labs'), normCompany('uniswap'));
});

test('reads each source format into one shape', async () => {
  const f = fakeFetch([
    ['greenhouse.io/v1/boards/coinbase', greenhouse('Coinbase', [[1, 'Senior Rust Engineer', 'Remote - UK', '2026-09-30T10:00:00Z']])],
    ['api.lever.co/v0/postings/anchorage', lever('anchorage', [['l1', 'Protocol Engineer', 'Remote', 1727690000000]])],
    ['posting-api/job-board/kraken.com', ashby('kraken.com', [['a1', 'Security Engineer', 'London', '2026-09-29T09:00:00Z'], ['a2', 'Hidden', 'X', '2026-09-29T09:00:00Z', false]])],
    ['web3.career/api/v1', web3career([[9, 'Solidity Dev', 'DeFi Co', 1727690000]])],
  ]);
  const gh = await fetchGreenhouse({ slug: 'coinbase', name: 'Coinbase' }, { fetchImpl: f });
  assert.equal(gh[0].title, 'Senior Rust Engineer');
  assert.equal(gh[0].location, 'Remote - UK');
  assert.equal(gh[0].postedAt, '2026-09-30T10:00:00.000Z');
  const lv = await fetchLever({ slug: 'anchorage', name: 'Anchorage' }, { fetchImpl: f });
  assert.equal(lv[0].title, 'Protocol Engineer');
  assert.equal(lv[0].remote, true);
  const ab = await fetchAshby({ slug: 'kraken.com', name: 'Kraken' }, { fetchImpl: f });
  assert.equal(ab.length, 1, 'unlisted Ashby jobs are skipped');
  assert.equal(ab[0].url, 'https://jobs.ashbyhq.com/kraken.com/a1');
  const w3 = await fetchWeb3Career({ token: 'x', tags: [''] }, { fetchImpl: f });
  assert.equal(w3[0].company, 'DeFi Co');
  assert.equal(w3[0].url, 'https://web3.career/9');
  assert.ok(f.calls.some((c) => c.url.includes('token=x')));
});

test('web3.career parser copes with different wrappers', () => {
  const job = { id: 1, title: 'A', company: 'B' };
  assert.equal(extractJobs([job]).length, 1);
  assert.equal(extractJobs(['meta', 'x', [job]]).length, 1);
  assert.equal(extractJobs({ jobs: [job] }).length, 1);
  assert.equal(extractJobs({ nope: 1 }).length, 0);
});

test('web3.career without a token fails clearly', async () => {
  await assert.rejects(fetchWeb3Career({ token: '' }), /WEB3CAREER_TOKEN/);
});

function scenario() {
  const db = openDb(':memory:');
  let ghJobs = [[1, 'Backend Engineer', 'NYC', '2026-08-01T00:00:00Z']];
  let ashJobs = [['k1', 'Data Analyst', 'London', '2026-09-01T00:00:00Z']];
  let ghFails = false;
  const f = fakeFetch([
    ['boards/acme/jobs', () => (ghFails ? { __status: 503 } : greenhouse('Acme', ghJobs))],
    ['job-board/dexco', () => ashby('dexco', ashJobs)],
  ]);
  const watch = { companies: [{ name: 'Acme', ats: 'greenhouse', slug: 'acme' }, { name: 'DexCo', ats: 'ashby', slug: 'dexco' }], web3career: { enabled: false } };
  const targets = buildTargets(watch, {});
  return {
    db, f, targets,
    setGh: (j) => { ghJobs = j; }, setAsh: (j) => { ashJobs = j; }, failGh: (v) => { ghFails = v; },
    run: (when) => collect(db, targets, { now: when, fetchImpl: f }),
  };
}

test('first scan is a quiet baseline; later scans report only new roles', async () => {
  const s = scenario();
  const first = await s.run(at(0));
  assert.equal(first.newJobs.length, 0, 'nothing counts as new on the very first scan');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM jobs WHERE baseline = 1').get().n, 2);

  s.setAsh([['k1', 'Data Analyst', 'London', '2026-09-01T00:00:00Z'], ['k2', 'Senior Solidity Engineer', 'Remote', '2026-10-02T00:00:00Z']]);
  const second = await s.run(at(1));
  assert.deepEqual(second.newJobs, ['ashby:k2']);
  const again = await s.run(at(1.1));
  assert.equal(again.newJobs.length, 0, 'a role is only new once');
});

test('roles that disappear are closed, unless the source errored', async () => {
  const s = scenario();
  await s.run(at(0));
  s.failGh(true);
  const r = await s.run(at(1));
  assert.equal(r.results.find((x) => x.key === 'greenhouse:acme').ok, false);
  assert.equal(s.db.prepare("SELECT closed_at FROM jobs WHERE id = 'greenhouse:1'").get().closed_at, null, 'an outage must not close jobs');
  const run = s.db.prepare("SELECT * FROM source_runs WHERE source_key = 'greenhouse:acme'").get();
  assert.match(run.last_error, /503/);
  s.failGh(false);
  s.setGh([]);
  await s.run(at(2));
  assert.ok(s.db.prepare("SELECT closed_at FROM jobs WHERE id = 'greenhouse:1'").get().closed_at, 'removed role is closed');
  assert.equal(s.db.prepare("SELECT last_error FROM source_runs WHERE source_key = 'greenhouse:acme'").get().last_error, null);
});

test('signals: hiring burst, first in category, senior, reposted, long-open', async () => {
  const s = scenario();
  await s.run(at(0));
  s.setAsh([
    ['k1', 'Data Analyst', 'London', '2026-09-01T00:00:00Z'],
    ['k2', 'Senior Solidity Engineer', 'Remote', null],
    ['k3', 'Rust Engineer', 'Remote', null],
    ['k4', 'Security Engineer', 'Remote', null],
  ]);
  await s.run(at(1));
  const k4 = s.db.prepare("SELECT * FROM jobs WHERE id = 'ashby:k4'").get();
  const sig4 = JSON.parse(k4.signals);
  assert.ok(sig4.includes('3 new roles in 7 days'), sig4.join(' | '));
  assert.ok(sig4.includes('First security role seen there'), sig4.join(' | '));
  const k2 = JSON.parse(s.db.prepare("SELECT signals FROM jobs WHERE id = 'ashby:k2'").get().signals);
  assert.ok(k2.includes('Senior hire'));
  assert.ok(k4.heat >= 50, `heat ${k4.heat}`);

  // Same title comes back under a new id 40 days later → reposted.
  s.setAsh([['k9', 'Senior Solidity Engineer (Remote)', 'Remote', null]]);
  await s.run(at(41));
  const k9 = JSON.parse(s.db.prepare("SELECT signals FROM jobs WHERE id = 'ashby:k9'").get().signals);
  assert.ok(k9.some((x) => x.startsWith('Same role first seen 40 days ago')), k9.join(' | '));

  // Baseline Greenhouse job posted in August is still open at day 41 → long-open.
  const gh = JSON.parse(s.db.prepare("SELECT signals FROM jobs WHERE id = 'greenhouse:1'").get().signals);
  assert.ok(gh.some((x) => /^Open \d+ days$/.test(x)), gh.join(' | '));
});

const SETTINGS = {
  alerts: {
    rules: [
      { name: 'Hiring burst', type: 'burst', minRoles: 3 },
      { name: 'Senior smart contract', type: 'keywords', seniorOnly: true, keywords: ['solidity', 'rust'] },
    ],
  },
};

test('alerts fire once, respect rules and hidden clients', async () => {
  const s = scenario();
  await s.run(at(0));
  s.setAsh([
    ['k2', 'Senior Solidity Engineer', 'Remote', null],
    ['k3', 'Rust Engineer', 'Remote', null],
    ['k4', 'Security Engineer', 'Remote', null],
  ]);
  const { newJobs } = await s.run(at(1));
  const alerts = evaluateAlerts(s.db, newJobs, SETTINGS, at(1));
  const keys = alerts.map((a) => a.key);
  assert.ok(keys.some((k) => k.startsWith('burst:dexco:')), keys.join(', '));
  assert.ok(keys.includes(`job:dexco|${normTitle('Senior Solidity Engineer')}`));
  assert.ok(!keys.includes(`job:dexco|${normTitle('Rust Engineer')}`), 'not senior, so no keyword alert');

  const tg = fakeFetch([['api.telegram.org', { ok: true }]]);
  await sendAlerts(s.db, alerts, { env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42' }, fetchImpl: tg, log: quiet });
  assert.equal(tg.calls.length, alerts.length);
  const body = JSON.parse(tg.calls[0].init.body);
  assert.equal(body.chat_id, '42');
  assert.equal(body.parse_mode, 'HTML');

  assert.equal(evaluateAlerts(s.db, newJobs, SETTINGS, at(1)).length, 0, 'already sent');
  assert.equal(evaluateAlerts(s.db, newJobs, { ...SETTINGS, hideCompanies: ['DexCo'] }, at(1)).length, 0);
});

test('a flood of alerts becomes one digest message', async () => {
  const db = openDb(':memory:');
  const alerts = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, text: `Lead ${i}` }));
  const tg = fakeFetch([['api.telegram.org', { ok: true }]]);
  await sendAlerts(db, alerts, { env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }, fetchImpl: tg, log: quiet });
  assert.equal(tg.calls.length, 1);
  assert.match(JSON.parse(tg.calls[0].init.body).text, /12 new leads/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts_sent').get().n, 12);
});

test('Telegram errors surface and nothing is marked as sent', async () => {
  const db = openDb(':memory:');
  const tg = fakeFetch([['api.telegram.org', { __status: 401, description: 'Unauthorized' }]]);
  await assert.rejects(sendAlerts(db, [{ key: 'a', text: 'x' }], { env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }, fetchImpl: tg, log: quiet }), /401/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts_sent').get().n, 0);
});

test('Telegram connects itself when you message the bot', async () => {
  const db = openDb(':memory:');
  const tg = fakeFetch([
    ['getUpdates', { ok: true, result: [{ update_id: 1, message: { chat: { id: 777 }, text: '/start' } }] }],
    ['sendMessage', { ok: true }],
  ]);
  const env = { TELEGRAM_BOT_TOKEN: 't' };
  assert.equal(await linkTelegram(db, { env, fetchImpl: tg, log: quiet }), '777');
  assert.equal(telegramChatId(db, env), '777');
  assert.equal(JSON.parse(tg.calls[1].init.body).chat_id, 777, 'sends a hello');
  assert.equal(await linkTelegram(db, { env, fetchImpl: tg, log: quiet }), null, 'only links once');
  await sendAlerts(db, [{ key: 'z', text: 'hi' }], { env, fetchImpl: tg, log: quiet });
  assert.equal(JSON.parse(tg.calls.at(-1).init.body).chat_id, '777');
});

test('same role on a careers page and web3.career shows once', () => {
  const rows = dedupe([
    { company_key: 'acme', title_key: 'rust engineer', source: 'web3career', first_seen: '2026-10-01', heat: 40 },
    { company_key: 'acme', title_key: 'rust engineer', source: 'ashby', first_seen: '2026-10-02', heat: 20 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'ashby');
  assert.equal(rows[0].first_seen, '2026-10-01');
  assert.equal(rows[0].heat, 40);
});

test('feed page renders, filters and escapes', async () => {
  const s = scenario();
  await s.run(at(0));
  s.setAsh([['k2', 'Senior <script>alert(1)</script> Engineer', 'Remote', null], ['k3', 'Community Manager', 'Remote', null]]);
  await s.run(at(1));
  const html = renderFeed(s.db, new URLSearchParams(), SETTINGS, at(1));
  assert.match(html, /Lead feed/);
  assert.ok(!html.includes('<script>alert(1)'), 'job titles are escaped');
  assert.match(html, /&lt;script&gt;/);
  const eng = renderFeed(s.db, new URLSearchParams('cat=marketing'), SETTINGS, at(1));
  assert.match(eng, /Community Manager/);
  assert.ok(!eng.includes('Data Analyst'));
  assert.match(renderSources(s.db, ['Bad: careers link not recognised'], at(1)), /couldn't be read/);
});

test('website asks for the password and saves Interested / Dismiss', async () => {
  const s = scenario();
  await s.run(at(0));
  const server = startServer({ db: s.db, getSettings: () => SETTINGS, getWatchlistProblems: () => [], port: 0, password: 'pw', log: quiet });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Basic ' + Buffer.from('me:pw').toString('base64') };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: { authorization: 'Basic ' + Buffer.from('me:nope').toString('base64') } })).status, 401);
    const ok = await fetch(`${base}/`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Backend Engineer/);
    const post = await fetch(`${base}/jobs/${encodeURIComponent('greenhouse:1')}/status`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'status=dismissed&back=%2F', redirect: 'manual',
    });
    assert.equal(post.status, 303);
    assert.equal(s.db.prepare("SELECT status FROM jobs WHERE id = 'greenhouse:1'").get().status, 'dismissed');
    const evil = await fetch(`${base}/jobs/x/status`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'status=new&back=%2F%2Fevil.com', redirect: 'manual',
    });
    assert.equal(evil.headers.get('location'), '/', 'no redirects to other sites');
  } finally {
    server.close();
  }
});
