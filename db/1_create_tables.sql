-- Dayton District Bank sandbox schema
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_credits NUMERIC(18,2) DEFAULT 0,
  spendable_credits NUMERIC(18,2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE IF NOT EXISTS txn_type AS ENUM ('admin_credit','transfer_request','transfer_completed','transfer_rejected','admin_adjustment');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE IF NOT EXISTS txn_status AS ENUM ('pending','approved','rejected','completed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  txn_type txn_type NOT NULL,
  status txn_status NOT NULL DEFAULT 'pending',
  amount NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  from_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  admin_comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Seed admin user (password: change_me)
INSERT INTO users (email, password_hash, is_admin)
VALUES ('owner@dayton.local', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8m1GzFQd2eK/0k5YVxvVqT7wQ6G2e', true)
ON CONFLICT (email) DO NOTHING;

-- Create account for admin if missing
INSERT INTO accounts (user_id)
SELECT id FROM users WHERE email='owner@dayton.local'
ON CONFLICT (user_id) DO NOTHING;
