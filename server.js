// Sổ Tài Chính Dự Án — máy chủ Node.js cho Railway.
// Lưu dữ liệu vào PostgreSQL khi có DATABASE_URL, nếu không thì vào tệp JSON trong DATA_DIR.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const makeSample = require('./sample');

const PORT = process.env.PORT || 3000;
// Collection ghi qua đường dẫn chung /api/:col/:id. Hợp đồng (contracts) có đường dẫn riêng bên dưới
// vì máy chủ tự gán người nhập, số thứ tự phụ lục và yêu cầu mã xóa.
const COLS = new Set(['projects', 'transactions']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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

// Chuyển dữ liệu cũ (một lần): dự án có contractValue > 0 mà chưa có hợp đồng → tạo một dòng HĐ gốc,
// VAT để trống (tạm tính). Giữ nguyên trường contractValue cũ để không mất dữ liệu.
async function migrateContracts() {
  if (await store.get('meta', 'contractsMigrated')) return;
  const [projects, contracts] = await Promise.all([store.all('projects'), store.all('contracts')]);
  const has = new Set(contracts.map(c => c.projectId)), at = new Date().toISOString(), items = [];
  for (const p of projects) {
    const v = Math.round(Number(p.contractValue) || 0);
    if (v <= 0 || has.has(p.id)) continue;
    items.push(['contracts', 'hd' + crypto.randomBytes(6).toString('hex'), { projectId: p.id, kind: 'base', seq: 0, no: '', signDate: '', value: v, vat: null, note: '',
      createdBy: null, createdByName: 'Chuyển từ dữ liệu cũ', createdAt: at, updatedBy: null, updatedByName: 'Chuyển từ dữ liệu cũ', updatedAt: at, ...(p.sample ? { sample: true } : {}) }]);
  }
  items.push(['meta', 'contractsMigrated', { at, count: items.length }]);
  await store.putMany(items);
  if (items.length > 1) console.log(`Đã chuyển giá trị hợp đồng của ${items.length - 1} dự án sang bảng hợp đồng (VAT tạm tính).`);
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
  const [projects, transactions, contracts] = await Promise.all([store.all('projects'), store.all('transactions'), store.all('contracts')]);
  res.set('Cache-Control', 'no-store').json({ projects, transactions, contracts });
}));

// Xóa dữ liệu ví dụ: xóa giao dịch ví dụ; dự án ví dụ chỉ xóa khi không còn giao dịch hay hợp đồng thật nào.
// Dự án ví dụ đã có giao dịch / hợp đồng thật người dùng nhập vào (hoặc đã sửa) thì giữ lại cùng hợp đồng của nó, bỏ cờ ví dụ.
app.delete('/api/sample', canWrite, wrap(async (req, res) => {
  const [projects, txs, contracts] = await Promise.all([store.all('projects'), store.all('transactions'), store.all('contracts')]);
  for (const t of txs) if (t.sample) await store.del('transactions', t.id);
  const used = new Set([...txs, ...contracts].filter(x => !x.sample).map(x => x.projectId));
  for (const p of projects) if (!p.sample) used.add(p.id);
  for (const { id, sample, ...d } of contracts) {
    if (!sample) continue;
    if (used.has(d.projectId)) await store.put('contracts', id, d);
    else await store.del('contracts', id);
  }
  for (const { id, sample, ...d } of projects) {
    if (!sample) continue;
    if (used.has(id)) await store.put('projects', id, d);
    else await store.del('projects', id);
  }
  res.status(204).end();
}));

/* ---------- hợp đồng với chủ đầu tư ---------- */
// {projectId, kind: base|appendix, seq, no, signDate, value (trước VAT), vat (null = tạm tính), note, người tạo / sửa}
function cleanContract(b, kind) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Dữ liệu không hợp lệ' };
  const no = b.no ?? '', signDate = b.signDate ?? '', note = b.note ?? '', vat = b.vat ?? null;
  if (typeof no !== 'string' || no.length > 60) return { error: 'Số hợp đồng tối đa 60 ký tự.' };
  if (typeof signDate !== 'string' || (signDate && !DATE_RE.test(signDate))) return { error: 'Ngày ký không hợp lệ.' };
  if (typeof note !== 'string' || note.length > 500) return { error: 'Ghi chú tối đa 500 ký tự.' };
  if (!Number.isInteger(b.value)) return { error: 'Giá trị hợp đồng phải là số nguyên đồng.' };
  if (kind === 'base' && b.value <= 0) return { error: 'Giá trị hợp đồng gốc phải lớn hơn 0.' };
  if (kind === 'appendix' && b.value === 0) return { error: 'Giá trị phụ lục phải khác 0.' };
  if (vat !== null && !Number.isInteger(vat)) return { error: 'VAT phải là số nguyên đồng, hoặc để trống nếu chưa có (tạm tính).' };
  if (kind === 'base' && vat < 0) return { error: 'VAT của hợp đồng gốc không được âm.' };
  return { data: { no: no.trim(), signDate, value: b.value, vat, note: note.trim() } };
}
app.put('/api/contracts/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const b = req.body || {}, old = await store.get('contracts', id);
  // Sửa: giữ nguyên dự án, loại và số thứ tự; tạo mới: lấy từ dữ liệu gửi lên
  const projectId = old ? old.projectId : b.projectId, kind = old ? old.kind : b.kind;
  if (kind !== 'base' && kind !== 'appendix') return res.status(400).json({ error: 'Loại hợp đồng không hợp lệ.' });
  if (!old && !(typeof projectId === 'string' && ID_RE.test(projectId) && await store.get('projects', projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  const c = cleanContract(b, kind);
  if (c.error) return res.status(400).json({ error: c.error });
  const now = new Date().toISOString();
  const who = { updatedBy: req.user.id, updatedByName: req.user.name || req.user.id, updatedAt: now };
  let rec;
  if (old) {
    const { id: _, sample, ...o } = old;
    rec = { ...o, ...c.data, ...who };
  } else {
    const list = (await store.all('contracts')).filter(x => x.projectId === projectId);
    if (kind === 'base' && list.some(x => x.kind === 'base')) return res.status(400).json({ error: 'Dự án đã có hợp đồng gốc. Hãy thêm phụ lục.' });
    if (kind === 'appendix' && !list.some(x => x.kind === 'base')) return res.status(400).json({ error: 'Thêm hợp đồng gốc trước khi thêm phụ lục.' });
    const seq = kind === 'base' ? 0 : Math.max(0, ...list.filter(x => x.kind === 'appendix').map(x => +x.seq || 0)) + 1;
    rec = { projectId, kind, seq, ...c.data, createdBy: req.user.id, createdByName: req.user.name || req.user.id, createdAt: now, ...who };
  }
  await store.put('contracts', id, rec);
  res.json({ id, ...rec });
}));
app.delete('/api/contracts/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const c = await store.get('contracts', id);
  if (!c) return res.status(204).end();
  if (c.kind === 'base') {
    const n = (await store.all('contracts')).filter(x => x.projectId === c.projectId && x.kind === 'appendix').length;
    if (n) return res.status(409).json({ error: `Hợp đồng gốc còn ${n} phụ lục. Xóa các phụ lục trước.` });
  }
  const bad = await auth.checkDeletePasscode(req, req.body?.passcode);
  if (bad) return res.status(bad.status).json({ error: bad.error });
  await store.del('contracts', id);
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
  // Bản ghi người dùng ghi (tạo mới hoặc sửa) không còn là dữ liệu ví dụ: Xóa dữ liệu ví dụ sẽ không xóa nó
  const { sample, ...data } = req.body;
  // Giao dịch luôn thuộc một dự án đang tồn tại
  if (req.params.col === 'transactions' && !(ID_RE.test(req.body.projectId) && await store.get('projects', req.body.projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  await store.put(req.params.col, req.params.id, data);
  res.status(204).end();
}));

app.delete('/api/:col/:id', canWrite, wrap(async (req, res) => {
  if (!check(req, res)) return;
  // Không xóa dự án còn giao dịch tham chiếu, tránh mất dữ liệu
  if (req.params.col === 'projects') {
    const [txs, cts] = await Promise.all([store.all('transactions'), store.all('contracts')]);
    const n = txs.filter(t => t.projectId === req.params.id).length, m = cts.filter(c => c.projectId === req.params.id).length;
    if (n && !m) return res.status(409).json({ error: `Dự án còn ${n} giao dịch. Xóa hoặc chuyển các giao dịch sang dự án khác trước, hoặc đổi trạng thái thành Hoàn thành.` });
    if (m) return res.status(409).json({ error: `Dự án còn ${[n && `${n} giao dịch`, `${m} dòng hợp đồng`].filter(Boolean).join(' và ')}. Xóa các giao dịch và hợp đồng của dự án trước, hoặc đổi trạng thái thành Hoàn thành.` });
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
  .then(migrateContracts)
  .then(auth.bootstrap)
  .then(() => app.listen(PORT, () => {
    // Railway tự đặt RAILWAY_GIT_BRANCH / RAILWAY_GIT_COMMIT_SHA: cho biết bản code nào đang chạy
    const src = process.env.RAILWAY_GIT_COMMIT_SHA ? ` · mã nguồn ${process.env.RAILWAY_GIT_BRANCH || '?'}@${process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)}` : '';
    console.log(`Sổ Tài Chính Dự Án [${ENV_NAME}] chạy ở cổng ${PORT}, lưu dữ liệu vào ${store.kind}${src}`);
  }))
  .catch(e => { console.error('Không khởi động được:', e); process.exit(1); });
