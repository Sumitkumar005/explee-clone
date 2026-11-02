'use strict';
const path = require('node:path');
const fs = require('node:fs');
process.removeAllListeners('warning'); // silence node:sqlite experimental warning
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 500,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  description TEXT,
  industry TEXT,
  tags TEXT,              -- JSON array
  technologies TEXT,      -- JSON array
  country TEXT,
  city TEXT,
  employees INTEGER,
  revenue_usd INTEGER,
  funding_stage TEXT,
  funding_total_usd INTEGER,
  last_funding_date TEXT,
  founded_year INTEGER,
  business_model TEXT,    -- B2B / B2C / B2B2C / Marketplace
  remote_policy TEXT,     -- Remote / Hybrid / Onsite
  hiring_open_roles INTEGER,
  linkedin_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_companies_industry ON companies(industry);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name TEXT, last_name TEXT,
  title TEXT, seniority TEXT, department TEXT,
  email TEXT, email_status TEXT,  -- verified / risky / unknown
  phone TEXT,
  linkedin_url TEXT,
  country TEXT, city TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,         -- companies / people / lookalike
  query TEXT,
  filters TEXT,               -- JSON
  criteria TEXT,              -- JSON array of AI criteria strings
  result_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS criteria_results (
  search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL,
  criterion_idx INTEGER NOT NULL,
  verdict TEXT NOT NULL,      -- yes / no / unsure
  reason TEXT,
  PRIMARY KEY (search_id, company_id, criterion_idx)
);
CREATE TABLE IF NOT EXISTS reveals (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, person_id)
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,         -- companies / people
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, entity_id)
);
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gtm_campaigns (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website TEXT NOT NULL,
  product_summary TEXT,
  value_props TEXT,           -- JSON
  competitors TEXT,           -- JSON
  sender_name TEXT,
  sender_title TEXT,
  meeting_link TEXT,
  language TEXT DEFAULT 'English',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft / running / paused
  auto_approve INTEGER NOT NULL DEFAULT 0, -- 0 = every email needs human approval
  daily_limit INTEGER NOT NULL DEFAULT 50,
  budget_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gtm_segments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rationale TEXT,
  fit_score INTEGER,
  search_query TEXT,
  filters TEXT,               -- JSON
  target_titles TEXT,         -- JSON
  status TEXT NOT NULL DEFAULT 'proposed' -- proposed / working / scaling / paused
);
CREATE TABLE IF NOT EXISTS gtm_inboxes (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  warmup_score INTEGER NOT NULL DEFAULT 95,
  sent_today INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gtm_prospects (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES gtm_campaigns(id) ON DELETE CASCADE,
  segment_id INTEGER NOT NULL REFERENCES gtm_segments(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  inbox_id INTEGER REFERENCES gtm_inboxes(id),
  stage TEXT NOT NULL DEFAULT 'pending_approval',
    -- pending_approval / approved / sent / replied / meeting / rejected / bounced
  lead_temp TEXT,             -- hot / warm / cold / not_interested
  UNIQUE (campaign_id, person_id)
);
CREATE TABLE IF NOT EXISTS gtm_messages (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES gtm_prospects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,    -- out / in
  step INTEGER NOT NULL DEFAULT 1,
  subject TEXT, body TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft / scheduled / sent / received
  classification TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
`);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, tx, DB_PATH };
