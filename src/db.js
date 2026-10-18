// Storage: one SQLite file. Uses Node's built-in SQLite, so there are no packages to install.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,          -- source:externalId
  source        TEXT NOT NULL,             -- greenhouse | lever | ashby | web3career
  source_key    TEXT NOT NULL,             -- which feed it came from, e.g. lever:acme
  external_id   TEXT NOT NULL,
  company       TEXT NOT NULL,
  company_key   TEXT NOT NULL,             -- normalised company name, used for grouping
  title         TEXT NOT NULL,
  title_key     TEXT NOT NULL,             -- normalised title, used to spot reposts
  location      TEXT,
  remote        INTEGER DEFAULT 0,
  department    TEXT,
  category      TEXT,                      -- engineering | security | bd | marketing | ops | other
  senior        INTEGER DEFAULT 0,
  url           TEXT,
  posted_at     TEXT,                      -- when the source says it was posted (if it says)
  first_seen    TEXT NOT NULL,             -- when Relay first saw it
  last_seen     TEXT NOT NULL,
  closed_at     TEXT,                      -- set when it disappears from its source
  baseline      INTEGER DEFAULT 0,         -- 1 = seen on the very first scan of its source, never alerted
  signals       TEXT DEFAULT '[]',         -- JSON array of "why it's a lead" reasons
  heat          INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'new'         -- new | interested | dismissed
);
CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company_key);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen);

CREATE TABLE IF NOT EXISTS source_runs (
  source_key  TEXT PRIMARY KEY,            -- e.g. greenhouse:consensys or web3career
  label       TEXT,
  last_run    TEXT,
  last_ok     TEXT,
  last_error  TEXT,
  job_count   INTEGER DEFAULT 0,
  runs        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key    TEXT PRIMARY KEY,                 -- small saved settings, e.g. the Telegram chat to message
  value  TEXT
);

CREATE TABLE IF NOT EXISTS alerts_sent (
  key      TEXT PRIMARY KEY,               -- stops the same alert going out twice
  sent_at  TEXT NOT NULL
);
`;

export function openDb(dataDir = process.env.DATA_DIR || './data') {
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'relay.db');
  if (file !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
