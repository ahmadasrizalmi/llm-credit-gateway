PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  daily_credit_limit INTEGER,
  monthly_credit_limit INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_username ON users(organization_id, username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_email ON users(organization_id, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  public_name TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  secret_binding_name TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  input_price_per_million INTEGER NOT NULL,
  output_price_per_million INTEGER NOT NULL,
  cached_input_price_per_million INTEGER NOT NULL DEFAULT 0,
  internal_markup_bps INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 4096,
  supports_streaming INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, public_name),
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS user_model_access (
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_allowed INTEGER NOT NULL DEFAULT 1,
  custom_daily_limit INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, model_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (model_id) REFERENCES models(id)
);

CREATE TABLE IF NOT EXISTS usage_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  is_stream INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_credit INTEGER NOT NULL DEFAULT 0,
  actual_credit INTEGER NOT NULL DEFAULT 0,
  input_price_snapshot INTEGER NOT NULL,
  output_price_snapshot INTEGER NOT NULL,
  cached_input_price_snapshot INTEGER NOT NULL DEFAULT 0,
  markup_bps_snapshot INTEGER NOT NULL DEFAULT 0,
  provider_request_id TEXT,
  http_status INTEGER,
  latency_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  FOREIGN KEY (model_id) REFERENCES models(id),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS credit_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  usage_request_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (usage_request_id) REFERENCES usage_requests(id)
);

CREATE TABLE IF NOT EXISTS usage_daily (
  date TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_credit INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user_id, model_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_org_created ON usage_requests(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_status ON usage_requests(status);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON credit_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON credit_reservations(status, expires_at);

INSERT OR IGNORE INTO organizations (id, name, slug, status, created_at, updated_at)
VALUES ('org_default', 'Default Organization', 'default', 'active', datetime('now'), datetime('now'));
