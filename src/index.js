// Entry point: starts the website and scans every source on a timer.
import { openDb } from './db.js';
import { loadWatchlist, loadSettings } from './config.js';
import { buildTargets, collect } from './collect.js';
import { evaluateAlerts, sendAlerts, linkTelegram } from './alerts.js';
import { startServer } from './web.js';

const db = openDb();
const once = process.argv.includes('--once');
const pollMinutes = Math.max(5, Number(process.env.POLL_MINUTES) || 15);
let running = false;
let lastProblems = [];

export async function runScan() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const watchlist = loadWatchlist();
    lastProblems = watchlist.problems;
    const settings = loadSettings();
    await linkTelegram(db).catch((err) => console.log('Telegram link check failed:', err.message));
    const targets = buildTargets(watchlist);
    if (!targets.length) { console.log('Nothing to scan: add companies to config/watchlist.json or enable web3.career.'); return; }
    const { newJobs, results } = await collect(db, targets);
    const failed = results.filter((r) => !r.ok);
    console.log(`Scan done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${results.length - failed.length}/${results.length} sources ok, ${newJobs.length} new roles.`);
    for (const f of failed) console.log(`  ✗ ${f.label}: ${f.error}`);
    const alerts = evaluateAlerts(db, newJobs, settings);
    if (alerts.length) {
      const { sent } = await sendAlerts(db, alerts);
      console.log(`  ${sent} alert message(s) sent.`);
    }
  } catch (err) {
    console.error('Scan failed:', err);
  } finally {
    running = false;
  }
}

if (once) {
  await runScan();
  process.exit(0);
} else {
  startServer({ db, getSettings: loadSettings, getWatchlistProblems: () => lastProblems });
  setTimeout(runScan, 5000);
  setInterval(runScan, pollMinutes * 60 * 1000);
  console.log(`Scanning every ${pollMinutes} minutes.`);
}
