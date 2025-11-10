# Dayton District Bank - Sandbox Prototype

**Purpose:** educational sandbox — no real money, no payment integrations.

## What's included
- Node.js + Express backend (`server.js`)
- PostgreSQL migration (`db/1_create_tables.sql`)
- Minimal static frontend (`client/`) with pages for login, user dashboard and admin dashboard.
- Example environment file `example.env`
- Instructions to run locally, push to GitHub, and deploy to Render (see README below).

## Quickstart (local)
1. Install Node.js (v18+ recommended) and PostgreSQL (or use Render Postgres later).
2. Copy `example.env` to `.env` and fill values.
3. Install deps: `npm install`
4. Create DB and run SQL migration: `psql $DATABASE_URL -f db/1_create_tables.sql`
5. Seed admin (see README section "Seeding admin account").
6. Start: `npm run dev` and open `http://localhost:3000`.

## Files
- server.js — main Express app
- package.json — dependencies & scripts
- db/1_create_tables.sql — schema and seed example
- client/ — simple HTML + JS UI to test flows

Read the rest of this README for GitHub + Render deployment steps.
