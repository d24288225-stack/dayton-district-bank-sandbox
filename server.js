require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path =require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const BANK_LIMIT = parseFloat(process.env.BANK_LIMIT || '100000000.00');

// helper - generate token
function genToken(user) {
  return jwt.sign({ id: user.id, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '2h' });
}

// auth middleware
async function auth(req,res,next){
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'missing auth' });
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch(e){
    return res.status(401).json({ error: 'invalid token' });
  }
}
function adminOnly(req,res,next){
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
}

// Register (for learning; admin user already seeded in SQL)
app.post('/api/register', async (req,res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id,is_admin', [email,hash]);
    const userId = r.rows[0].id;
    await client.query('INSERT INTO accounts (user_id) VALUES ($1)', [userId]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Login
app.post('/api/login', async (req,res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const r = await pool.query('SELECT id,password_hash,is_admin FROM users WHERE email=$1', [email]);
  if (!r.rowCount) return res.status(401).json({ error: 'invalid credentials' });
  const u = r.rows[0];
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = genToken({ id:u.id, is_admin:u.is_admin });
  res.json({ token });
});

// Get profile + balances
app.get('/api/me', auth, async (req,res) => {
  const r = await pool.query('SELECT u.id,u.email,u.is_admin,a.total_credits,a.spendable_credits FROM users u JOIN accounts a ON a.user_id=u.id WHERE u.id=$1', [req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// User: request transfer -> creates pending transaction only
app.post('/api/transfer', auth, async (req,res) => {
  const { toEmail, amount } = req.body;
  if (!toEmail || !amount) return res.status(400).json({ error: 'toEmail & amount required' });
  const client = await pool.connect();
  try {
    const fromAccount = (await client.query('SELECT id FROM accounts WHERE user_id=$1', [req.user.id])).rows[0];
    const toUser = (await client.query('SELECT id FROM users WHERE email=$1', [toEmail]));
    if (!toUser.rowCount) return res.status(400).json({ error: 'recipient not found' });
    const toAccount = (await client.query('SELECT id FROM accounts WHERE user_id=$1', [toUser.rows[0].id])).rows[0];
    await client.query('INSERT INTO transactions (user_id, txn_type, status, amount, from_account_id, to_account_id) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.id, 'transfer_request', 'pending', amount, fromAccount.id, toAccount.id]);
    res.json({ ok:true });
  } catch(e){
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// User: view transactions
app.get('/api/transactions', auth, async (req,res) => {
  const r = await pool.query('SELECT * FROM transactions WHERE user_id=$1 OR from_account_id IN (SELECT id FROM accounts WHERE user_id=$1) OR to_account_id IN (SELECT id FROM accounts WHERE user_id=$1) ORDER BY created_at DESC', [req.user.id]);
  res.json(r.rows);
});

// Admin: add credit (non-spendable)
app.post('/api/admin/add-credit', auth, adminOnly, async (req,res) => {
  const { userEmail, amount, note } = req.body;
  if (!userEmail || !amount) return res.status(400).json({ error: 'userEmail & amount required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // check bank limit
    const sum = (await client.query('SELECT COALESCE(SUM(total_credits),0) as s FROM accounts')).rows[0].s;
    if (parseFloat(sum) + parseFloat(amount) > BANK_LIMIT) throw new Error('bank limit exceeded');
    const user = (await client.query('SELECT id FROM users WHERE email=$1', [userEmail]));
    if (!user.rowCount) throw new Error('user not found');
    const account = (await client.query('SELECT id FROM accounts WHERE user_id=$1', [user.rows[0].id])).rows[0];
    await client.query('UPDATE accounts SET total_credits = total_credits + $1 WHERE id=$2', [amount, account.id]);
    await client.query('INSERT INTO transactions (user_id, txn_type, status, amount, to_account_id, admin_comment) VALUES ($1,$2,$3,$4,$5,$6)', [null,'admin_credit','completed',amount,account.id,note||null]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e){
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Admin: list pending transfers
app.get('/api/admin/pending-transactions', auth, adminOnly, async (req,res) => {
  const r = await pool.query("SELECT t.*, fu.email as from_email, tu.email as to_email FROM transactions t LEFT JOIN accounts fa ON fa.id=t.from_account_id LEFT JOIN users fu ON fu.id=fa.user_id LEFT JOIN accounts ta ON ta.id=t.to_account_id LEFT JOIN users tu ON tu.id=ta.user_id WHERE t.status='pending' AND t.txn_type='transfer_request' ORDER BY t.created_at");
  res.json(r.rows);
});

// Admin: approve transfer (must check spendable credits)
app.post('/api/admin/transactions/:id/approve', auth, adminOnly, async (req,res) => {
  const txId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txres = await client.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [txId]);
    if (!txres.rowCount) throw new Error('transaction not found');
    const tx = txres.rows[0];
    if (tx.status !== 'pending') throw new Error('transaction not pending');
    const from = (await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [tx.from_account_id])).rows[0];
    const to = (await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [tx.to_account_id])).rows[0];
    if (parseFloat(from.spendable_credits) < parseFloat(tx.amount)) throw new Error('insufficient spendable credits');
    // move balances
    await client.query('UPDATE accounts SET spendable_credits = spendable_credits - $1, total_credits = total_credits - $1 WHERE id=$2', [tx.amount, from.id]);
    await client.query('UPDATE accounts SET spendable_credits = spendable_credits + $1, total_credits = total_credits + $1 WHERE id=$2', [tx.amount, to.id]);
    await client.query("UPDATE transactions SET status='completed', updated_at=now() WHERE id=$1", [txId]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e){
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Admin: reject transfer
app.post('/api/admin/transactions/:id/reject', auth, adminOnly, async (req,res) => {
  const txId = req.params.id;
  await pool.query("UPDATE transactions SET status='rejected', updated_at=now() WHERE id=$1", [txId]);
  res.json({ ok:true });
});

// Admin: make credits spendable (move from total to spendable)
app.post('/api/admin/make-spendable', auth, adminOnly, async (req,res) => {
  const { userEmail, amount } = req.body;
  if (!userEmail || !amount) return res.status(400).json({ error: 'userEmail & amount required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('SELECT id FROM users WHERE email=$1', [userEmail]));
    if (!user.rowCount) throw new Error('user not found');
    const account = (await client.query('SELECT * FROM accounts WHERE user_id=$1 FOR UPDATE', [user.rows[0].id])).rows[0];
    if (parseFloat(account.total_credits) < parseFloat(amount)) throw new Error('not enough total credits');
    // move from total to spendable
    await client.query('UPDATE accounts SET total_credits = total_credits - $1, spendable_credits = spendable_credits + $1 WHERE id=$2', [amount, account.id]);
    await client.query('INSERT INTO transactions (user_id, txn_type, status, amount, to_account_id, admin_comment) VALUES ($1,$2,$3,$4,$5,$6)', [null,'admin_adjustment','completed',amount,account.id,'made spendable']);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e){
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Basic static client for testing (serves files from /client)
app.use('/', express.static(path.join(__dirname, 'client')));

app.get('*', (req, res) => {
res.sendfile(path.join(__dirname, 'client', 'login.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {console.log('Listening on ${port}')});
