// Decides which new jobs deserve a ping, and sends them to Telegram.
import { normCompany } from './classify.js';

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - y) / 86400000 + 1) / 7)}`;
}

function jobLine(j) {
  const where = j.location ? ` · ${esc(j.location)}` : '';
  return `<b>${esc(j.company)}</b>: ${j.url ? `<a href="${esc(j.url)}">${esc(j.title)}</a>` : esc(j.title)}${where}`;
}

// Returns [{ key, text }] for alerts that haven't been sent before.
export function evaluateAlerts(db, newJobIds, settings = {}, now = new Date()) {
  if (!newJobIds.length) return [];
  const rules = settings.alerts?.rules || [];
  const hidden = new Set((settings.hideCompanies || []).map(normCompany));
  const sent = db.prepare('SELECT 1 FROM alerts_sent WHERE key = ?');
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const newJobs = newJobIds.map((id) => getJob.get(id)).filter((j) => j && !hidden.has(j.company_key));
  const out = [];
  const queued = new Set();
  const push = (key, text) => {
    if (queued.has(key) || sent.get(key)) return;
    queued.add(key);
    out.push({ key, text });
  };

  for (const rule of rules) {
    if (rule.enabled === false) continue;

    if (rule.type === 'burst') {
      const min = rule.minRoles || 3;
      const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
      for (const companyKey of new Set(newJobs.map((j) => j.company_key))) {
        const roles = db.prepare(
          `SELECT * FROM jobs WHERE company_key = ? AND first_seen >= ? AND baseline = 0 AND closed_at IS NULL
           GROUP BY title_key ORDER BY first_seen DESC`
        ).all(companyKey, weekAgo);
        if (roles.length < min) continue;
        push(`burst:${companyKey}:${isoWeek(now)}`,
          `🔥 <b>${esc(roles[0].company)}</b> has posted ${roles.length} new roles this week\n` +
          roles.slice(0, 8).map((r) => `• ${r.url ? `<a href="${esc(r.url)}">${esc(r.title)}</a>` : esc(r.title)}`).join('\n'));
      }
    }

    if (rule.type === 'keywords') {
      const words = (rule.keywords || []).map((w) => w.toLowerCase());
      for (const j of newJobs) {
        if (rule.seniorOnly && !j.senior) continue;
        const text = `${j.title} ${j.department}`.toLowerCase();
        if (words.length && !words.some((w) => text.includes(w))) continue;
        if (rule.categories && !rule.categories.includes(j.category)) continue;
        push(`job:${j.company_key}|${j.title_key}`, `🎯 ${esc(rule.name || 'Matching role')}\n${jobLine(j)}${signalLine(j)}`);
      }
    }

    if (rule.type === 'watched') {
      for (const j of newJobs.filter((x) => x.source !== 'web3career')) {
        push(`job:${j.company_key}|${j.title_key}`, `👀 New role at a watched company\n${jobLine(j)}${signalLine(j)}`);
      }
    }

    if (rule.type === 'heat') {
      const min = rule.minHeat || 50;
      for (const j of newJobs) {
        if (j.heat < min) continue;
        push(`job:${j.company_key}|${j.title_key}`, `⚡ Hot lead (heat ${j.heat})\n${jobLine(j)}${signalLine(j)}`);
      }
    }
  }
  return out;
}

function signalLine(j) {
  let s = [];
  try { s = JSON.parse(j.signals || '[]'); } catch {}
  return s.length ? `\n<i>${esc(s.join(' · '))}</i>` : '';
}

// The chat to send to: TELEGRAM_CHAT_ID if set, otherwise the one saved by linkTelegram().
export function telegramChatId(db, env = process.env) {
  return env.TELEGRAM_CHAT_ID || db.prepare("SELECT value FROM kv WHERE key = 'telegram_chat_id'").get()?.value || '';
}

// Lets the user connect Telegram by simply messaging their bot: we read the bot's latest
// incoming message and remember which chat it came from, then say hello.
export async function linkTelegram(db, { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || telegramChatId(db, env)) return null;
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?limit=20`);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: HTTP ${res.status}`);
  const data = await res.json();
  const msgs = (data.result || []).map((u) => u.message || u.my_chat_member).filter(Boolean);
  const chat = msgs.length ? msgs[msgs.length - 1].chat : null;
  if (!chat?.id) return null;
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('telegram_chat_id', ?)").run(String(chat.id));
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat.id, text: '✅ Relay is connected. New lead alerts will arrive here.' }),
  });
  log(`Telegram linked to chat ${chat.id}.`);
  return String(chat.id);
}

export async function sendAlerts(db, alerts, { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  if (!alerts.length) return { sent: 0 };
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = telegramChatId(db, env);
  const mark = db.prepare('INSERT OR IGNORE INTO alerts_sent (key, sent_at) VALUES (?, ?)');

  // Lots at once (e.g. after a pause) → one digest message instead of a flood.
  const messages = alerts.length > 8
    ? [`📬 <b>${alerts.length} new leads</b>\n\n` + alerts.slice(0, 15).map((a) => a.text).join('\n\n') +
       (alerts.length > 15 ? `\n\n…and ${alerts.length - 15} more in the lead feed.` : '')]
    : alerts.map((a) => a.text);

  let sent = 0;
  for (const text of messages) {
    if (!token || !chatId) { log(`[alert, Telegram not set up]\n${text.replace(/<[^>]+>/g, '')}\n`); sent++; continue; }
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram refused the message: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    sent++;
  }
  const now = new Date().toISOString();
  for (const a of alerts) mark.run(a.key, now);
  return { sent };
}
