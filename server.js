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
    async get(col, id) {
      const r = await pool.query('SELECT data FROM records WHERE col = $1 AND id = $2', [col, id]);
      return r.rows[0] ? { id, ...r.rows[0].data } : null;
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
    async wipe() { await pool.query('DELETE FROM records'); }
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
    async get(col, id) { const d = (db[col] || {})[id]; return d ? { id, ...d } : null; },
    async all(col) { return Object.entries(db[col] || {}).map(([id, d]) => ({ id, ...d })); },
    async put(col, id, data) { (db[col] ||= {})[id] = data; await save(); },
    async putMany(items) { for (const [col, id, data] of items) (db[col] ||= {})[id] = data; await save(); },
    async del(col, id) { delete (db[col] || {})[id]; await save(); },
    async wipe() { db = { projects: {}, transactions: {}, meta: {} }; await save(); }
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

app.use(express.json({ limit: '100kb' }));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'Lỗi máy chủ' }); });

// Trang đăng nhập, logo và tài khoản (xem auth.js); mọi đường dẫn sau đây đều cần đăng nhập
const auth = require('./auth')(store, wrap);
app.set('trust proxy', 1);

// Tên môi trường: Railway tự đặt RAILWAY_ENVIRONMENT_NAME (production, staging…); APP_ENV ghi đè nếu cần.
// Không cần đăng nhập, để trang đăng nhập cũng hiện dải môi trường thử nghiệm.
const ENV_NAME = process.env.APP_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || 'local';
app.get('/api/info', (req, res) => res.set('Cache-Control', 'no-store').json({ env: ENV_NAME }));

app.use(auth.router);
app.use(auth.requireLogin);
const canWrite = auth.requireRole('editor');

app.get('/api/data', wrap(async (req, res) => {
  const [projects, transactions] = await Promise.all([store.all('projects'), store.all('transactions')]);
  res.set('Cache-Control', 'no-store').json({ projects, transactions });
}));

// Xóa dữ liệu ví dụ: xóa giao dịch ví dụ; dự án ví dụ chỉ xóa khi không còn giao dịch nào.
// Dự án ví dụ đã có giao dịch thật người dùng nhập vào thì giữ lại (bỏ cờ ví dụ) để không mất dữ liệu.
app.delete('/api/sample', canWrite, wrap(async (req, res) => {
  const [projects, txs] = await Promise.all([store.all('projects'), store.all('transactions')]);
  for (const t of txs) if (t.sample) await store.del('transactions', t.id);
  const used = new Set(txs.filter(t => !t.sample).map(t => t.projectId));
  for (const { id, sample, ...d } of projects) {
    if (!sample) continue;
    if (used.has(id)) await store.put('projects', id, d);
    else await store.del('projects', id);
  }
  res.status(204).end();
}));

function check(req, res) {
  const { col, id } = req.params;
  if (!COLS.has(col) || !ID_RE.test(id)) { res.status(400).json({ error: 'Đường dẫn không hợp lệ' }); return false; }
  return true;
}
// Tiền lưu theo số nguyên đồng (không số lẻ). Giá trị hợp đồng / ngân sách có thể bỏ trống (coi là 0).
const wholeMoney = v => v == null || (Number.isInteger(v) && v >= 0);
function valid(col, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (col === 'projects') return typeof d.name === 'string' && d.name.trim() !== '' && wholeMoney(d.contractValue) && wholeMoney(d.budget);
  return typeof d.projectId === 'string' && (d.type === 'in' || d.type === 'out')
    && /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') && Number.isInteger(d.amount) && d.amount > 0;
}

app.put('/api/:col/:id', canWrite, wrap(async (req, res) => {
  if (!check(req, res)) return;
  if (!valid(req.params.col, req.body)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  // Giao dịch luôn thuộc một dự án đang tồn tại
  if (req.params.col === 'transactions' && !(ID_RE.test(req.body.projectId) && await store.get('projects', req.body.projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  await store.put(req.params.col, req.params.id, req.body);
  res.status(204).end();
}));

app.delete('/api/:col/:id', canWrite, wrap(async (req, res) => {
  if (!check(req, res)) return;
  // Không xóa dự án còn giao dịch tham chiếu, tránh mất dữ liệu
  if (req.params.col === 'projects') {
    const n = (await store.all('transactions')).filter(t => t.projectId === req.params.id).length;
    if (n) return res.status(409).json({ error: `Dự án còn ${n} giao dịch. Xóa hoặc chuyển các giao dịch sang dự án khác trước, hoặc đổi trạng thái thành Hoàn thành.` });
  }
  await store.del(req.params.col, req.params.id);
  res.status(204).end();
}));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', index: 'index.html' }));

// Xóa sạch dữ liệu (dự án, giao dịch, tài khoản) rồi khởi động như lần đầu, đúng một lần cho mỗi token. Token lấy từ:
// - biến FACTORY_RESET=<chuỗi bất kỳ>;
// - tệp deploy/reset.json {token, scope, productionAccountsToken, admin:{username, name, passHash}}: sau khi xóa, tạo sẵn quản trị viên đó
//   (bắt buộc đổi mật khẩu khi đăng nhập), để khởi tạo lại môi trường thử nghiệm chỉ bằng một lần đẩy code.
//   scope "accounts": chỉ xóa tài khoản, giữ nguyên dự án và giao dịch; mặc định "all" xóa tất cả.
// Các token đã chạy được ghi lại nên để nguyên biến/tệp cũng không xóa lại. Không bao giờ chạy ở production.
async function factoryReset() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(process.env.RESET_FILE || path.join(__dirname, 'deploy', 'reset.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error('deploy/reset.json không đọc được:', e.message); }
  const tokens = [String(process.env.FACTORY_RESET || '').trim(), String(file?.token || '').trim()].filter(Boolean);
  if (!tokens.length) return;
  if (ENV_NAME === 'production') {
    // Production không bao giờ bị xóa. Chỉ khi production chưa có tài khoản nào thì tạo quản trị viên từ tệp
    // (lần đầu chuyển sang đăng nhập bằng tài khoản); đã có tài khoản thì bỏ qua hoàn toàn.
    console.log('FACTORY_RESET / deploy/reset.json: không xóa dữ liệu ở môi trường production.');
    const a = file?.admin, valid = a?.username && /^scrypt\$/.test(a.passHash || '');
    // productionAccountsToken mới: xóa MỌI tài khoản production (dự án, giao dịch giữ nguyên) rồi tạo lại quản trị viên; một lần mỗi token
    const pt = String(file?.productionAccountsToken || '').trim();
    const pmeta = (await store.all('meta')).find(m => m.id === 'productionAccountsReset') || {};
    if (valid && pt && !(pmeta.tokens || []).includes(pt)) {
      let removed = 0;
      for (const u of await store.all('users')) { await store.del('users', u.id); removed++; }
      await store.put('meta', 'productionAccountsReset', { tokens: [...(pmeta.tokens || []), pt], at: new Date().toISOString() });
      console.warn(`Production: đã xóa ${removed} tài khoản (dự án, giao dịch giữ nguyên) theo mã "${pt}".`);
    }
    if (valid && !(await store.all('users')).length) {
      await store.put('users', String(a.username).toLowerCase(), { name: a.name || a.username, role: 'admin', active: true, ver: 0,
        passHash: a.passHash, mustChange: true, createdAt: new Date().toISOString() });
      console.warn(`Production chưa có tài khoản: đã tạo quản trị viên "${a.username}" từ deploy/reset.json (phải đổi mật khẩu ở lần đăng nhập đầu).`);
    }
    return;
  }
  const meta = (await store.all('meta')).find(m => m.id === 'factoryReset') || {};
  const done = new Set(meta.tokens || (meta.token ? [meta.token] : []));
  const pending = tokens.filter(t => !done.has(t));
  if (!pending.length) return console.log(`Xóa dữ liệu theo mã ${tokens.map(t => `"${t}"`).join(', ')} đã chạy trước đó; không xóa lại.`);
  const fileToken = String(file?.token || '').trim();
  const accountsOnly = pending.every(t => t === fileToken) && file.scope === 'accounts';
  if (accountsOnly) for (const u of await store.all('users')) await store.del('users', u.id);
  else await store.wipe();
  tokens.forEach(t => done.add(t));
  await store.put('meta', 'factoryReset', { tokens: [...done], at: new Date().toISOString() });
  console.warn(`FACTORY_RESET: đã xóa ${accountsOnly ? 'mọi tài khoản (giữ nguyên dự án và giao dịch)' : 'toàn bộ dữ liệu và tài khoản'} (mã ${pending.map(t => `"${t}"`).join(', ')}).`);
  const a = file?.admin;
  if (file && pending.includes(fileToken) && a?.username && /^scrypt\$/.test(a.passHash || '')) {
    await store.put('users', String(a.username).toLowerCase(), { name: a.name || a.username, role: 'admin', active: true, ver: 0,
      passHash: a.passHash, mustChange: true, createdAt: new Date().toISOString() });
    console.warn(`FACTORY_RESET: đã tạo quản trị viên "${a.username}" từ deploy/reset.json (phải đổi mật khẩu ở lần đăng nhập đầu).`);
  }
}

store.init()
  .then(factoryReset)
  .then(seedOnce)
  .then(auth.bootstrap)
  .then(() => app.listen(PORT, () => {
    // Railway tự đặt RAILWAY_GIT_BRANCH / RAILWAY_GIT_COMMIT_SHA: cho biết bản code nào đang chạy
    const src = process.env.RAILWAY_GIT_COMMIT_SHA ? ` · mã nguồn ${process.env.RAILWAY_GIT_BRANCH || '?'}@${process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)}` : '';
    console.log(`Sổ Tài Chính Dự Án [${ENV_NAME}] chạy ở cổng ${PORT}, lưu dữ liệu vào ${store.kind}${src}`);
  }))
  .catch(e => { console.error('Không khởi động được:', e); process.exit(1); });
