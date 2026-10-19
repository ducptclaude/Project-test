// Sổ Tài Chính Dự Án — máy chủ Node.js cho Railway.
// Lưu dữ liệu vào PostgreSQL khi có DATABASE_URL, nếu không thì vào tệp JSON trong DATA_DIR.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const makeSample = require('./sample');

const PORT = process.env.PORT || 3000;
const COLS = new Set(['projects', 'transactions']);
const ID_RE = /^[A-Za-z0-9_.~:@+-]{1,100}$/;

/* ---------- storage ---------- */
function postgresStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return {
    kind: 'PostgreSQL',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS records (
        col text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (col, id))`);
    },
    async all(col) {
      const r = await pool.query('SELECT id, data FROM records WHERE col = $1', [col]);
      return r.rows.map(x => ({ id: x.id, ...x.data }));
    },
    async put(col, id, data) {
      await pool.query(`INSERT INTO records (col, id, data) VALUES ($1, $2, $3)
        ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [col, id, data]);
    },
    async putMany(items) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const [col, id, data] of items)
          await c.query(`INSERT INTO records (col, id, data) VALUES ($1, $2, $3)
            ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [col, id, data]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
    async del(col, id) { await pool.query('DELETE FROM records WHERE col = $1 AND id = $2', [col, id]); },
    async delSample() { await pool.query(`DELETE FROM records WHERE col IN ('projects','transactions') AND data->>'sample' = 'true'`); }
  };
}

function fileStore(dir) {
  const file = path.join(dir, 'db.json');
  let db = { projects: {}, transactions: {}, meta: {} };
  let queue = Promise.resolve();
  const save = () => (queue = queue.then(async () => {
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, file);
  }));
  return {
    kind: 'tệp JSON (' + file + ')',
    async init() {
      await fs.promises.mkdir(dir, { recursive: true });
      try { db = { meta: {}, ...JSON.parse(await fs.promises.readFile(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
    async all(col) { return Object.entries(db[col] || {}).map(([id, d]) => ({ id, ...d })); },
    async put(col, id, data) { (db[col] ||= {})[id] = data; await save(); },
    async putMany(items) { for (const [col, id, data] of items) (db[col] ||= {})[id] = data; await save(); },
    async del(col, id) { delete (db[col] || {})[id]; await save(); },
    async delSample() {
      for (const col of COLS) for (const [id, d] of Object.entries(db[col])) if (d.sample) delete db[col][id];
      await save();
    }
  };
}

const store = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));

async function seedOnce() {
  if (process.env.SEED_SAMPLE === 'false') return;
  const meta = await store.all('meta');
  if (meta.some(m => m.id === 'seeded')) return;
  const [p, t] = await Promise.all([store.all('projects'), store.all('transactions')]);
  const items = [];
  if (!p.length && !t.length) {
    const s = makeSample();
    for (const { id, ...d } of s.projects) items.push(['projects', id, d]);
    for (const { id, ...d } of s.txs) items.push(['transactions', id, { ...d, createdAt: 0 }]);
  }
  items.push(['meta', 'seeded', { at: new Date().toISOString() }]);
  await store.putMany(items);
  if (items.length > 1) console.log(`Đã nạp ${items.length - 1} bản ghi dữ liệu ví dụ.`);
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.send('ok'));

// Bảo vệ bằng mật khẩu khi đặt APP_PASSWORD (tên đăng nhập: APP_USER, mặc định "admin")
const PASS = process.env.APP_PASSWORD, USER = process.env.APP_USER || 'admin';
if (PASS) {
  const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  app.use((req, res, next) => {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && token) {
      const raw = Buffer.from(token, 'base64').toString(), i = raw.indexOf(':');
      if (i >= 0 && eq(raw.slice(0, i), USER) && eq(raw.slice(i + 1), PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="So Tai Chinh Du An", charset="UTF-8"').status(401).send('Cần đăng nhập');
  });
}

app.use(express.json({ limit: '100kb' }));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Lỗi máy chủ' }); });

app.get('/api/data', wrap(async (req, res) => {
  const [projects, transactions] = await Promise.all([store.all('projects'), store.all('transactions')]);
  res.set('Cache-Control', 'no-store').json({ projects, transactions });
}));

app.delete('/api/sample', wrap(async (req, res) => { await store.delSample(); res.status(204).end(); }));

function check(req, res) {
  const { col, id } = req.params;
  if (!COLS.has(col) || !ID_RE.test(id)) { res.status(400).json({ error: 'Đường dẫn không hợp lệ' }); return false; }
  return true;
}
function valid(col, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (col === 'projects') return typeof d.name === 'string' && d.name.trim() !== '';
  return typeof d.projectId === 'string' && (d.type === 'in' || d.type === 'out')
    && /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') && Number.isFinite(d.amount) && d.amount > 0;
}

app.put('/api/:col/:id', wrap(async (req, res) => {
  if (!check(req, res)) return;
  if (!valid(req.params.col, req.body)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  await store.put(req.params.col, req.params.id, req.body);
  res.status(204).end();
}));

app.delete('/api/:col/:id', wrap(async (req, res) => {
  if (!check(req, res)) return;
  await store.del(req.params.col, req.params.id);
  res.status(204).end();
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

store.init()
  .then(seedOnce)
  .then(() => app.listen(PORT, () => console.log(`Sổ Tài Chính Dự Án chạy ở cổng ${PORT}, lưu dữ liệu vào ${store.kind}`)))
  .catch(e => { console.error('Không khởi động được:', e); process.exit(1); });
