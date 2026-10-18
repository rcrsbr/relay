// Runs the app on made-up sample data (fictional companies), so the lead feed can be seen
// without internet access or any keys. Usage: npm run demo, then open http://localhost:3999
import { openDb } from '../src/db.js';
import { buildTargets, collect } from '../src/collect.js';
import { evaluateAlerts, sendAlerts } from '../src/alerts.js';
import { startServer } from '../src/web.js';
import { fakeFetch, greenhouse, ashby, lever, web3career } from '../test/helpers.js';

const DAY = 86400000;
const now = Date.now();
const day = (d) => new Date(now + d * DAY);
const iso = (d) => day(d).toISOString();

const db = openDb(':memory:');
const state = {
  northwind: [[101, 'Backend Engineer (Go)', 'New York', iso(-60)], [102, 'Compliance Lead', 'London', iso(-20)]],
  lumen: [['l1', 'Product Designer', 'Remote', now - 10 * DAY]],
  quarry: [['q1', 'Head of Business Development', 'Singapore', iso(-75)], ['q2', 'Community Manager', 'Remote', iso(-5)]],
  web3: [[901, 'Solidity Developer', 'Arcadia Finance', Math.floor((now - 3 * DAY) / 1000)]],
};
const f = fakeFetch([
  ['boards/northwind', () => greenhouse('Northwind Exchange', state.northwind)],
  ['postings/lumen', () => lever('lumen', state.lumen)],
  ['job-board/quarry', () => ashby('quarry', state.quarry)],
  ['web3.career/api', () => web3career(state.web3)],
]);
const watch = {
  companies: [
    { name: 'Northwind Exchange', ats: 'greenhouse', slug: 'northwind' },
    { name: 'Lumen Wallet', ats: 'lever', slug: 'lumen' },
    { name: 'Quarry Protocol', ats: 'ashby', slug: 'quarry' },
  ],
  web3career: { enabled: true, tags: [''] },
};
const targets = buildTargets(watch, { WEB3CAREER_TOKEN: 'demo' });
const settings = {
  hideCompanies: [],
  alerts: { rules: [
    { name: 'Hiring burst', type: 'burst', minRoles: 3 },
    { name: 'Senior Solidity / Rust / smart contract role', type: 'keywords', seniorOnly: true, keywords: ['solidity', 'rust', 'smart contract', 'zk'] },
    { name: 'Hot lead', type: 'heat', minHeat: 50 },
  ] },
};

await collect(db, targets, { now: day(-2), fetchImpl: f });           // first scan: baseline

state.quarry.push(['q3', 'Senior Solidity Engineer', 'Remote (EU)', iso(-1)], ['q4', 'Rust Engineer, Sequencer', 'Remote', iso(-1)], ['q5', 'Security Engineer', 'Remote', iso(-1)]);
state.lumen.push(['l2', 'Staff Smart Contract Engineer', 'Remote', now - DAY]);
state.web3.push(
  [902, 'Senior ZK Researcher', 'Prism Labs', Math.floor((now - 0.5 * DAY) / 1000)],
  [903, 'Senior Solidity Engineer', 'Quarry Protocol', Math.floor((now - DAY) / 1000)],
  [904, 'Developer Relations Lead', 'Halcyon Network', Math.floor((now - 0.2 * DAY) / 1000)],
);
const r = await collect(db, targets, { now: day(-0.05), fetchImpl: f });
state.northwind.push([103, 'Head of Security', 'Remote', iso(0)]);
const r2 = await collect(db, targets, { now: day(0), fetchImpl: f });

const alerts = evaluateAlerts(db, [...r.newJobs, ...r2.newJobs], settings, day(0));
console.log(`\n${alerts.length} alerts would be sent. Example Telegram messages:\n`);
await sendAlerts(db, alerts.slice(0, 3), { env: {} });

startServer({ db, getSettings: () => settings, getWatchlistProblems: () => [], port: Number(process.env.PORT) || 3999, password: '' , log: () => {} });
console.log('Demo lead feed: http://localhost:' + (process.env.PORT || 3999));
