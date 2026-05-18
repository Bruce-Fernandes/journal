// Trading Journal - Express + SQLite backend
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const db = new Database(path.join(DATA_DIR, 'journal.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY(user_id, key)
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,           -- 'long' | 'short'
  entry_time TEXT NOT NULL,          -- ISO
  exit_time TEXT,
  entry_price REAL NOT NULL,
  exit_price REAL,
  quantity REAL NOT NULL DEFAULT 1,
  stop_loss REAL,
  take_profit REAL,
  fees REAL DEFAULT 0,
  pnl REAL,                          -- net pnl (computed if null)
  rr REAL,                           -- realized R multiple
  risk_amount REAL,                  -- $ risked
  strategy TEXT,
  setup TEXT,
  tags TEXT,                         -- comma separated
  emotion TEXT,
  mistakes TEXT,
  notes TEXT,
  screenshot TEXT,
  status TEXT DEFAULT 'closed',      -- 'open' | 'closed'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_entry ON trades(entry_time);
`);
// migrate: add user_id column to trades if missing (existing single-user data)
try { db.exec('ALTER TABLE trades ADD COLUMN user_id INTEGER'); } catch(_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id)'); } catch(_) {}

// legacy single-user settings (kept for migration path, unused in auth mode)
const getSetting = (k, def) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  return r ? r.value : def;
};
// per-user settings
const getSettingU = (userId, k, def) => {
  const r = db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId, k);
  return r ? r.value : def;
};
const setSettingU = (userId, k, v) => {
  db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value').run(userId, k, String(v));
};

// ---------- helpers ----------
function sessionOf(iso) {
  // session by UTC hour: Asia 0-7, London 7-13, NY 13-21, Off 21-24
  const h = new Date(iso).getUTCHours();
  if (h >= 0 && h < 7) return 'Asia';
  if (h >= 7 && h < 13) return 'London';
  if (h >= 13 && h < 21) return 'New York';
  return 'Off-Hours';
}
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function computePnl(t) {
  if (t.pnl != null && t.pnl !== '') return Number(t.pnl);
  if (t.exit_price == null || t.entry_price == null) return null;
  const dir = t.direction === 'short' ? -1 : 1;
  const gross = (Number(t.exit_price) - Number(t.entry_price)) * Number(t.quantity || 1) * dir;
  return gross - Number(t.fees || 0);
}
function computeR(t, pnl) {
  if (t.rr != null && t.rr !== '') return Number(t.rr);
  if (t.risk_amount && Number(t.risk_amount) > 0 && pnl != null) return pnl / Number(t.risk_amount);
  if (t.stop_loss && t.entry_price && t.exit_price) {
    const risk = Math.abs(Number(t.entry_price) - Number(t.stop_loss)) * Number(t.quantity || 1);
    if (risk > 0) {
      const dir = t.direction === 'short' ? -1 : 1;
      const reward = (Number(t.exit_price) - Number(t.entry_price)) * Number(t.quantity || 1) * dir;
      return reward / risk;
    }
  }
  return null;
}

// ---------- middleware ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'tj-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const base = path.basename(file.originalname).replace(/[^a-z0-9.\-_]/gi, '_');
      cb(null, Date.now() + '-' + base);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  }
});

// ---------- auth routes ----------
app.post('/api/auth/register', (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim())) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const r = db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(String(username).trim(), email ? String(email).trim() : null, hash);
  // set default starting balance for new user
  setSettingU(r.lastInsertRowid, 'starting_balance', 10000);
  req.session.userId = r.lastInsertRowid;
  req.session.username = String(username).trim();
  res.json({ id: r.lastInsertRowid, username: req.session.username });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username });
});

// ---------- auth guard ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---------- validation ----------
const VALID_DIRECTIONS = ['long', 'short'];
const VALID_STATUSES = ['open', 'closed'];
const ALLOWED_SETTINGS_KEYS = ['starting_balance', 'account_currency', 'daily_loss_limit_pct', 'max_loss_limit_pct', 'profit_target_pct'];

function validateTrade(b, isUpdate = false) {
  const errors = [];
  if (!isUpdate) {
    if (!b.symbol || !String(b.symbol).trim()) errors.push('symbol is required');
    if (!b.entry_time) errors.push('entry_time is required');
    if (b.entry_price == null || isNaN(Number(b.entry_price))) errors.push('entry_price must be a number');
  }
  if (b.direction !== undefined && !VALID_DIRECTIONS.includes(b.direction)) errors.push('direction must be long or short');
  if (b.status !== undefined && !VALID_STATUSES.includes(b.status)) errors.push('status must be open or closed');
  if (b.entry_price !== undefined && b.entry_price !== '' && !isFinite(Number(b.entry_price))) errors.push('entry_price must be finite');
  if (b.exit_price !== undefined && b.exit_price !== '' && !isFinite(Number(b.exit_price))) errors.push('exit_price must be finite');
  if (b.quantity !== undefined && b.quantity !== '' && Number(b.quantity) <= 0) errors.push('quantity must be positive');
  return errors;
}

// ---------- API ----------

// settings
app.get('/api/settings', requireAuth, (req, res) => {
  const uid = req.session.userId;
  res.json({
    starting_balance: Number(getSettingU(uid, 'starting_balance', 10000)),
    account_currency: getSettingU(uid, 'account_currency', 'USD'),
    daily_loss_limit_pct: Number(getSettingU(uid, 'daily_loss_limit_pct', 5)),
    max_loss_limit_pct: Number(getSettingU(uid, 'max_loss_limit_pct', 10)),
    profit_target_pct: Number(getSettingU(uid, 'profit_target_pct', 8)),
  });
});
app.post('/api/settings', requireAuth, (req, res) => {
  const uid = req.session.userId;
  for (const [k, v] of Object.entries(req.body || {})) {
    if (ALLOWED_SETTINGS_KEYS.includes(k)) setSettingU(uid, k, v);
  }
  res.json({ ok: true });
});

// list trades
app.get('/api/trades', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM trades WHERE user_id=? ORDER BY entry_time DESC').all(req.session.userId);
  res.json(rows);
});

// create
app.post('/api/trades', requireAuth, upload.single('screenshot'), (req, res) => {
  const errs = validateTrade(req.body, false);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const b = req.body;
  const t = {
    symbol: (b.symbol || '').toUpperCase(),
    direction: b.direction || 'long',
    entry_time: b.entry_time,
    exit_time: b.exit_time || null,
    entry_price: Number(b.entry_price),
    exit_price: b.exit_price ? Number(b.exit_price) : null,
    quantity: Number(b.quantity || 1),
    stop_loss: b.stop_loss ? Number(b.stop_loss) : null,
    take_profit: b.take_profit ? Number(b.take_profit) : null,
    fees: Number(b.fees || 0),
    pnl: b.pnl ? Number(b.pnl) : null,
    rr: b.rr ? Number(b.rr) : null,
    risk_amount: b.risk_amount ? Number(b.risk_amount) : null,
    strategy: b.strategy || null,
    setup: b.setup || null,
    tags: b.tags || null,
    emotion: b.emotion || null,
    mistakes: b.mistakes || null,
    notes: b.notes || null,
    screenshot: req.file ? '/uploads/' + req.file.filename : (b.screenshot || null),
    status: b.exit_price ? 'closed' : (b.status || 'open'),
    user_id: req.session.userId,
  };
  const pnl = computePnl(t);
  const rr = computeR(t, pnl);
  t.pnl = pnl;
  t.rr = rr;
  const stmt = db.prepare(`INSERT INTO trades
    (symbol,direction,entry_time,exit_time,entry_price,exit_price,quantity,stop_loss,take_profit,fees,pnl,rr,risk_amount,strategy,setup,tags,emotion,mistakes,notes,screenshot,status,user_id)
    VALUES (@symbol,@direction,@entry_time,@exit_time,@entry_price,@exit_price,@quantity,@stop_loss,@take_profit,@fees,@pnl,@rr,@risk_amount,@strategy,@setup,@tags,@emotion,@mistakes,@notes,@screenshot,@status,@user_id)`);
  const r = stmt.run(t);
  res.json({ id: r.lastInsertRowid });
});

// update
app.put('/api/trades/:id', requireAuth, upload.single('screenshot'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const errs = validateTrade(req.body, true);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const existing = db.prepare('SELECT * FROM trades WHERE id=? AND user_id=?').get(id, req.session.userId);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = { ...existing, ...req.body };
  if (req.file) b.screenshot = '/uploads/' + req.file.filename;
  b.pnl = computePnl(b);
  b.rr = computeR(b, b.pnl);
  b.status = b.exit_price ? 'closed' : 'open';
  db.prepare(`UPDATE trades SET
    symbol=@symbol,direction=@direction,entry_time=@entry_time,exit_time=@exit_time,
    entry_price=@entry_price,exit_price=@exit_price,quantity=@quantity,stop_loss=@stop_loss,
    take_profit=@take_profit,fees=@fees,pnl=@pnl,rr=@rr,risk_amount=@risk_amount,
    strategy=@strategy,setup=@setup,tags=@tags,emotion=@emotion,mistakes=@mistakes,
    notes=@notes,screenshot=@screenshot,status=@status WHERE id=@id`).run({ ...b, id });
  res.json({ ok: true });
});

// delete
app.delete('/api/trades/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const trade = db.prepare('SELECT screenshot FROM trades WHERE id=? AND user_id=?').get(id, req.session.userId);
  if (trade && trade.screenshot) {
    const filename = path.basename(trade.screenshot);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (filePath.startsWith(UPLOAD_DIR + path.sep)) {
      fs.unlink(filePath, () => {});
    }
  }
  if (!trade) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM trades WHERE id=? AND user_id=?').run(id, req.session.userId);
  res.json({ ok: true });
});

// analytics
app.get('/api/analytics', requireAuth, (req, res) => {
  const uid = req.session.userId;
  const trades = db.prepare("SELECT * FROM trades WHERE user_id=? AND status='closed' AND pnl IS NOT NULL ORDER BY entry_time ASC").all(uid);
  const start = Number(getSettingU(uid, 'starting_balance', 10000));
  let bal = start;
  let peak = start;
  let maxDD = 0;
  let maxDDPct = 0;
  const equity = [{ t: trades[0]?.entry_time || new Date().toISOString(), v: start }];
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
  let bestTrade = -Infinity, worstTrade = Infinity;
  let curStreak = 0, bestWinStreak = 0, bestLossStreak = 0, lastSign = 0;
  const bySession = {}, byDow = {}, byHour = {}, bySymbol = {}, byTag = {}, byStrategy = {}, byDay = {};
  const rrList = [];

  const bump = (obj, k, pnl) => {
    if (!obj[k]) obj[k] = { trades: 0, wins: 0, pnl: 0 };
    obj[k].trades++;
    obj[k].pnl += pnl;
    if (pnl > 0) obj[k].wins++;
  };

  for (const t of trades) {
    const pnl = Number(t.pnl);
    bal += pnl;
    equity.push({ t: t.exit_time || t.entry_time, v: bal });
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDD) { maxDD = dd; maxDDPct = (dd / peak) * 100; }
    if (pnl > 0) { wins++; grossWin += pnl; } else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
    if (pnl > bestTrade) bestTrade = pnl;
    if (pnl < worstTrade) worstTrade = pnl;
    const sign = pnl > 0 ? 1 : pnl < 0 ? -1 : 0;
    if (sign !== 0) {
      if (sign === lastSign) curStreak++; else curStreak = 1;
      lastSign = sign;
      if (sign > 0 && curStreak > bestWinStreak) bestWinStreak = curStreak;
      if (sign < 0 && curStreak > bestLossStreak) bestLossStreak = curStreak;
    }
    if (t.rr != null) rrList.push(Number(t.rr));

    bump(bySession, sessionOf(t.entry_time), pnl);
    bump(byDow, DOW[new Date(t.entry_time).getDay()], pnl);
    bump(byHour, String(new Date(t.entry_time).getUTCHours()).padStart(2, '0'), pnl);
    bump(bySymbol, t.symbol, pnl);
    if (t.strategy) bump(byStrategy, t.strategy, pnl);
    if (t.tags) t.tags.split(',').map(s => s.trim()).filter(Boolean).forEach(tg => bump(byTag, tg, pnl));
    const day = (t.entry_time || '').slice(0, 10);
    bump(byDay, day, pnl);
  }

  const total = trades.length;
  const winRate = total ? (wins / total) * 100 : 0;
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  const profitFactor = grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : 0);
  const expectancy = total ? (grossWin - grossLoss) / total : 0;
  const avgRR = rrList.length ? rrList.reduce((a, b) => a + b, 0) / rrList.length : 0;

  res.json({
    starting_balance: start,
    current_balance: bal,
    net_pnl: bal - start,
    return_pct: ((bal - start) / start) * 100,
    total_trades: total,
    wins, losses,
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    profit_factor: profitFactor === Infinity ? null : profitFactor,
    expectancy,
    avg_rr: avgRR,
    best_trade: bestTrade === -Infinity ? 0 : bestTrade,
    worst_trade: worstTrade === Infinity ? 0 : worstTrade,
    best_win_streak: bestWinStreak,
    best_loss_streak: bestLossStreak,
    max_drawdown: maxDD,
    max_drawdown_pct: maxDDPct,
    equity,
    by_session: bySession,
    by_dow: byDow,
    by_hour: byHour,
    by_symbol: bySymbol,
    by_tag: byTag,
    by_strategy: byStrategy,
    by_day: byDay,
  });
});

// CSV export
app.get('/api/export.csv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM trades WHERE user_id=? ORDER BY entry_time ASC').all(req.session.userId);
  const cols = ['id','symbol','direction','entry_time','exit_time','entry_price','exit_price','quantity','stop_loss','take_profit','fees','pnl','rr','risk_amount','strategy','setup','tags','emotion','mistakes','notes','status'];
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trades.csv"');
  res.send(csv);
});

// CSV import (simple: same columns)
app.post('/api/import', requireAuth, express.text({ limit: '10mb', type: '*/*' }), (req, res) => {
  const text = req.body || '';
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return res.json({ inserted: 0 });
  const header = lines.shift().split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const insert = db.prepare(`INSERT INTO trades (symbol,direction,entry_time,exit_time,entry_price,exit_price,quantity,stop_loss,take_profit,fees,pnl,rr,risk_amount,strategy,setup,tags,emotion,mistakes,notes,status,user_id)
    VALUES (@symbol,@direction,@entry_time,@exit_time,@entry_price,@exit_price,@quantity,@stop_loss,@take_profit,@fees,@pnl,@rr,@risk_amount,@strategy,@setup,@tags,@emotion,@mistakes,@notes,@status,@user_id)`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = !q;
        else if (c === ',' && !q) { parts.push(cur); cur = ''; }
        else cur += c;
      }
      parts.push(cur);
      const obj = {};
      header.forEach((h, i) => obj[h] = parts[i]);
      const t = {
        symbol: (obj.symbol || '').toUpperCase(),
        direction: obj.direction || 'long',
        entry_time: obj.entry_time,
        exit_time: obj.exit_time || null,
        entry_price: Number(obj.entry_price),
        exit_price: obj.exit_price ? Number(obj.exit_price) : null,
        quantity: Number(obj.quantity || 1),
        stop_loss: obj.stop_loss ? Number(obj.stop_loss) : null,
        take_profit: obj.take_profit ? Number(obj.take_profit) : null,
        fees: Number(obj.fees || 0),
        pnl: obj.pnl ? Number(obj.pnl) : null,
        rr: obj.rr ? Number(obj.rr) : null,
        risk_amount: obj.risk_amount ? Number(obj.risk_amount) : null,
        strategy: obj.strategy || null,
        setup: obj.setup || null,
        tags: obj.tags || null,
        emotion: obj.emotion || null,
        mistakes: obj.mistakes || null,
        notes: obj.notes || null,
        status: obj.status || (obj.exit_price ? 'closed' : 'open'),
        user_id: req.session.userId,
      };
      t.pnl = computePnl(t);
      t.rr = computeR(t, t.pnl);
      insert.run(t);
      n++;
    }
  });
  try { tx(); res.json({ inserted: n }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// multer & general error handler
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Bad request' });
  next();
});

app.listen(PORT, () => console.log(`Trading Journal running: http://localhost:${PORT}`));
