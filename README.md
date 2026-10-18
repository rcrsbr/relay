# Relay: BD lead feed for crypto recruitment

Relay watches crypto job boards and company careers pages, spots hiring signals, shows them in a
password-protected lead feed, and sends Telegram alerts for the hottest leads.

**Phase 1 (this version):** lead feed, hiring signals, Telegram alerts.
**Next:** funding rounds, talent bank from Outlook pitches, outreach sequences (see the design mockup).

---

## Setting it up (one time)

You need four free or cheap accounts. Each step takes a few minutes.

### 1. GitHub: where the code lives
1. Sign up at https://github.com.
2. Create a new **private** repository called `relay` (leave it empty).
3. Claude pushes the code into it.

### 2. Telegram bot: where alerts arrive
1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Pick a name (e.g. "Relay Leads") and a username ending in `bot`.
3. BotFather replies with a **token** like `123456:ABC-...`. Keep it private; you'll paste it into Railway.
4. Once the app is running, open your new bot in Telegram and send it any message.
   Relay links itself to that chat and replies "Relay is connected".

### 3. web3.career API token (free)
1. Go to https://web3.career/web3-jobs-api and sign up.
2. Copy the token they give you.

### 4. Railway: where the app runs (about $5/month)
1. Sign up at https://railway.com with your GitHub account.
2. **New Project → Deploy from GitHub repo →** pick `relay`.
3. In the service, open **Variables** and add:

   | Variable | Value |
   |---|---|
   | `APP_PASSWORD` | a password for the lead feed (any username works when logging in) |
   | `TELEGRAM_BOT_TOKEN` | the token from BotFather |
   | `WEB3CAREER_TOKEN` | the token from web3.career |
   | `DATA_DIR` | `/data` |

4. Right-click the service → **Attach volume**, mount path `/data`. This keeps your data between updates.
5. **Settings → Networking → Generate domain.** That's your lead feed's web address.

The first scan runs a minute after it starts. It records everything currently open as a baseline
(no alerts), then from the next scan on, anything new is a lead.

---

## Everyday changes (no code needed)

- **Watch another company:** add its careers link to `config/watchlist.json`
  (Greenhouse, Lever or Ashby links work, e.g. `https://jobs.ashbyhq.com/acme`).
- **Hide current clients from the feed and alerts:** add their names to `hideCompanies` in `config/settings.json`.
- **Change alert rules:** edit `alerts.rules` in `config/settings.json`. Rule types:
  - `burst`: a company posts `minRoles`+ new roles in a week
  - `keywords`: new roles mentioning any of `keywords` (`seniorOnly` to limit to senior roles)
  - `heat`: any new role with heat of `minHeat` or more
  - `watched`: any new role at a company on the watchlist
- **Scan more or less often:** set `POLL_MINUTES` in Railway (default 15, minimum 5).

---

## Notes for whoever changes the code next

Plain Node.js 22, **no dependencies** (built-in `fetch`, `http`, `node:sqlite`, `node:test`).

```
src/index.js          starts the website and runs a scan every POLL_MINUTES
src/collect.js        one scan: fetch every source, store new jobs, close vanished ones, rescore
src/sources/ats.js    Greenhouse, Lever, Ashby public job APIs (no key needed)
src/sources/web3career.js  web3.career API (needs WEB3CAREER_TOKEN; always link to apply_url)
src/classify.js       title → category (engineering/security/bd/marketing/ops), seniority, normalised keys
src/signals.js        "why it's a lead" reasons + heat score (0–100)
src/alerts.js         alert rules, Telegram sending, Telegram auto-linking
src/web.js            lead feed + sources pages (server-rendered HTML, basic-auth password)
src/db.js             SQLite schema (jobs, source_runs, alerts_sent, kv)
config/               watchlist.json and settings.json (re-read every scan)
scripts/demo.js       runs the feed on fictional sample data: `npm run demo` → http://localhost:3999
test/                 `npm test`, with fake responses shaped like the real APIs
```

Key behaviours to keep:
- **First scan of a source is a baseline:** stored with `baseline = 1`, never alerted.
- **A source that errors never closes jobs.** Only a successful careers-page scan closes missing roles.
  web3.career never closes jobs (its API only returns the latest listings).
- **Alerts are de-duplicated** via `alerts_sent` keys (`job:<company>|<title>`, `burst:<company>:<week>`),
  so the same role on two sources alerts once. More than 8 alerts at once become one digest.
- The feed de-duplicates the same role across sources, preferring the careers-page link.

Data formats were checked against live responses on 18 Oct 2026 (Greenhouse: Coinbase; Ashby: Kraken).
Lever's shape follows its public docs.

### Changelog
- 0.1.0 (18 Oct 2026): Phase 1. Lead feed, signals, Telegram alerts, 13 watched companies + web3.career.
