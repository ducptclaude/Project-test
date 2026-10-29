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
// Chi phí 3 khối (xem CLAUDE.md): mỗi khoản chi có group + category thuộc đúng khối. "Khác" phân biệt nhờ group.
const COST_GROUPS = {
  direct: ['Thầu phụ', 'Vật tư', 'Nhân công', 'MMTB', 'Tổ chức thi công', 'Khác'],
  indirect: ['Lương BCH', 'Điện, nước', 'Ngoại giao', 'Khác'],
  finance: ['Phí bảo lãnh', 'Phí ngân hàng', 'Lãi vay, phạt']
};
// Chuyển hạng mục chi cũ sang khối mới (một lần, meta costGroupsMigrated); hạng mục lạ / trống → Trực tiếp · Khác
const OLD_COST_MAP = {
  'Thầu phụ': ['direct', 'Thầu phụ'], 'Vật tư': ['direct', 'Vật tư'], 'Nhân công': ['direct', 'Nhân công'],
  'Thiết bị / máy móc': ['direct', 'MMTB'], 'Vận chuyển': ['direct', 'Tổ chức thi công'],
  'Chi phí quản lý': ['indirect', 'Khác'], 'Bản quyền / phần mềm': ['indirect', 'Khác'], 'Thuế & phí': ['indirect', 'Khác']
};
const mapOldCost = cat => OLD_COST_MAP[cat] || ['direct', 'Khác'];
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
    // Môi trường mới (không phải production) nạp luôn dự án mẫu đầy đủ DA-M01
    if (ENV_NAME !== 'production') items.push(...richItems());
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
    items.push(['contracts', 'hd' + crypto.randomBytes(6).toString('hex'), { projectId: p.id, kind: 'base', seq: 1, no: '', signDate: '', value: v, vat: null, note: '',
      createdBy: null, createdByName: 'Chuyển từ dữ liệu cũ', createdAt: at, updatedBy: null, updatedByName: 'Chuyển từ dữ liệu cũ', updatedAt: at, ...(p.sample ? { sample: true } : {}) }]);
  }
  items.push(['meta', 'contractsMigrated', { at, count: items.length }]);
  await store.putMany(items);
  if (items.length > 1) console.log(`Đã chuyển giá trị hợp đồng của ${items.length - 1} dự án sang bảng hợp đồng (VAT tạm tính).`);
}

// Dự án mẫu đầy đủ (sample.js → makeRichSample): chỉ các id tiền tố "mau-", mang cờ sample
function richItems() {
  const r = makeSample.rich(), items = [];
  for (const [col, list] of [['projects', r.projects], ['contracts', r.contracts], ['acceptances', r.acceptances], ['loans', r.loans], ['transactions', r.txs]])
    for (const { id, ...d } of list) items.push([col, id, d]);
  return items;
}
// deploy/reset.json "sampleToken": token mới → THÊM dự án mẫu vào môi trường thử (không xóa, không đụng id khác;
// ghi lại chính các id "mau-" nếu đã có). Mỗi token chạy một lần (meta sampleSeed). Production: bỏ qua hoàn toàn.
async function sampleSeed() {
  const token = String(readResetFile()?.sampleToken || '').trim();
  if (!token) return;
  if (ENV_NAME === 'production') return console.log('sampleToken: không nạp dự án mẫu ở môi trường production.');
  const meta = (await store.get('meta', 'sampleSeed')) || {};
  if ((meta.tokens || []).includes(token)) return;
  const items = richItems();
  if (!items.every(([, id]) => id.startsWith('mau-'))) throw new Error('Dự án mẫu chỉ được dùng id tiền tố mau-');
  // Bản ghi "mau-" người dùng đã sửa (không còn cờ sample) là dữ liệu thật: giữ nguyên, không ghi đè.
  // Chỉ ghi bản ghi chưa có hoặc còn cờ sample.
  const write = [], has = {}; let kept = 0;
  for (const it of items) {
    const [col, id] = it, cur = await store.get(col, id);
    if (cur && !cur.sample) { kept++; (has[col] ||= new Set()).add(id); continue; }
    write.push(it);
  }
  // Liên kết phải hợp lệ: dự án / hợp đồng được trỏ tới phải có (sẽ ghi, đã giữ, hoặc đang có trong kho); không thì bỏ bản ghi đó
  for (const [col, id] of write) (has[col] ||= new Set()).add(id);
  const exists = async (col, id) => has[col]?.has(id) || !!(await store.get(col, id));
  const ok = [];
  let dropped = 0;
  for (const it of write) {
    const d = it[2];
    if (d.projectId && !(await exists('projects', d.projectId))) { dropped++; continue; }
    if (d.contractId && !(await exists('contracts', d.contractId))) { dropped++; continue; }
    ok.push(it);
  }
  ok.push(['meta', 'sampleSeed', { tokens: [...(meta.tokens || []), token], at: new Date().toISOString() }]);
  await store.putMany(ok);
  console.log(`sampleToken "${token}": đã thêm / cập nhật dự án mẫu DA-M01 (${ok.length - 1} bản ghi, id tiền tố mau-); giữ nguyên ${kept} bản ghi người dùng đã sửa${dropped ? `; bỏ ${dropped} bản ghi trỏ tới dữ liệu không còn` : ''}.`);
}

// Chuyển khoản chi cũ (chưa có group) sang 3 khối, một lần cho mọi môi trường (kể cả production).
// Chỉ đổi group / category, lưu tên cũ vào oldCategory khi tên đổi; không đổi người sửa, thời điểm sửa hay cờ sample.
async function migrateCostGroups() {
  if (await store.get('meta', 'costGroupsMigrated')) return;
  const items = [];
  for (const { id, ...t } of await store.all('transactions')) {
    if (t.type !== 'out' || COST_GROUPS[t.group]) continue;
    const [group, category] = mapOldCost(t.category);
    const rec = { ...t, group, category };
    if ((t.category || '') !== category) rec.oldCategory = t.category || '';
    items.push(['transactions', id, rec]);
  }
  items.push(['meta', 'costGroupsMigrated', { at: new Date().toISOString(), count: items.length }]);
  await store.putMany(items);
  console.log(`Chi phí 3 khối: đã chuyển ${items.length - 1} khoản chi cũ sang khối / hạng mục mới (tên cũ lưu ở oldCategory).`);
}

// Nhiều hợp đồng trong một dự án (một lần, meta contractGroupsMigrated, mọi môi trường): HĐ gốc seq 0 → 1; phụ lục chưa có
// parentId gắn vào HĐ gốc duy nhất của dự án; quyết toán / nghiệm thu chưa gắn hợp đồng gắn vào HĐ gốc duy nhất.
// Chỉ thêm / đổi trường, không xóa; không đổi người sửa, thời điểm sửa hay cờ sample.
async function migrateContractGroups() {
  if (await store.get('meta', 'contractGroupsMigrated')) return;
  const [cts, accs] = await Promise.all([store.all('contracts'), store.all('acceptances')]);
  const bases = pid => cts.filter(c => c.projectId === pid && c.kind === 'base');
  const items = []; let skipped = 0;
  for (const { id, ...c } of cts) {
    if (c.kind === 'base' && !(+c.seq > 0)) items.push(['contracts', id, { ...c, seq: 1 }]);
    if (c.kind === 'appendix' && !c.parentId) {
      const bs = bases(c.projectId);
      if (bs.length === 1) items.push(['contracts', id, { ...c, parentId: bs[0].id }]); else skipped++;
    }
  }
  for (const { id, ...a } of accs) {
    if (a.contractId) continue;
    const bs = bases(a.projectId);
    if (bs.length === 1) items.push(['acceptances', id, { ...a, contractId: bs[0].id }]); else skipped++;
  }
  items.push(['meta', 'contractGroupsMigrated', { at: new Date().toISOString(), count: items.length, skipped }]);
  await store.putMany(items);
  if (items.length > 1 || skipped) console.log(`Nhiều hợp đồng: đã cập nhật ${items.length - 1} bản ghi hợp đồng / nghiệm thu / quyết toán cũ${skipped ? `; ${skipped} bản ghi chưa gắn được (dự án không có đúng một HĐ gốc)` : ''}.`);
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
// Mọi thao tác xóa phải kèm mã xóa (body {passcode}); gọi sau khi đã kiểm quyền và các ràng buộc dữ liệu
async function passcodeOk(req, res) {
  const bad = await auth.checkDeletePasscode(req, req.body?.passcode);
  if (bad) { res.status(bad.status).json({ error: bad.error }); return false; }
  return true;
}

app.get('/api/data', wrap(async (req, res) => {
  const [projects, transactions, contracts, acceptances, loans] = await Promise.all(['projects', 'transactions', 'contracts', 'acceptances', 'loans'].map(c => store.all(c)));
  res.set('Cache-Control', 'no-store').json({ projects, transactions, contracts, acceptances, loans });
}));

// Xóa dữ liệu ví dụ: xóa giao dịch ví dụ; dự án ví dụ chỉ xóa khi không còn giao dịch hay hợp đồng thật nào.
// Dự án ví dụ đã có giao dịch / hợp đồng thật người dùng nhập vào (hoặc đã sửa) thì giữ lại cùng hợp đồng của nó, bỏ cờ ví dụ.
app.delete('/api/sample', canWrite, wrap(async (req, res) => {
  if (!(await passcodeOk(req, res))) return;
  const [projects, txs, contracts, accs, loans] = await Promise.all(['projects', 'transactions', 'contracts', 'acceptances', 'loans'].map(c => store.all(c)));
  for (const t of txs) if (t.sample) await store.del('transactions', t.id);
  const used = new Set([...txs, ...contracts, ...accs, ...loans].filter(x => !x.sample).map(x => x.projectId));
  for (const p of projects) if (!p.sample) used.add(p.id);
  // Hợp đồng, nghiệm thu / quyết toán ví dụ đi theo dự án của nó: dự án còn giữ thì giữ (bỏ cờ ví dụ), không thì xóa
  for (const [col, list] of [['loans', loans], ['acceptances', accs], ['contracts', contracts]])
    for (const { id, sample, ...d } of list) {
      if (!sample) continue;
      if (used.has(d.projectId)) await store.put(col, id, d);
      else await store.del(col, id);
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
// Một dự án có nhiều hợp đồng: HĐ gốc seq 1..n trong dự án; phụ lục có parentId = HĐ gốc cùng dự án, seq 1..n trong từng HĐ gốc.
app.put('/api/contracts/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const b = req.body || {}, old = await store.get('contracts', id);
  // Sửa: không đổi được dự án, loại, hợp đồng gốc của phụ lục; số thứ tự giữ nguyên
  if (old && ((b.kind !== undefined && b.kind !== old.kind) || (b.projectId !== undefined && b.projectId !== old.projectId) || (b.parentId !== undefined && b.parentId !== old.parentId)))
    return res.status(400).json({ error: 'Không đổi được dự án, loại hay hợp đồng gốc của dòng đã ghi. Xóa và nhập lại.' });
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
    let parentId, seq;
    if (kind === 'base') seq = Math.max(0, ...list.filter(x => x.kind === 'base').map(x => +x.seq || 0)) + 1;
    else {
      parentId = b.parentId;
      if (!(typeof parentId === 'string' && list.some(x => x.id === parentId && x.kind === 'base')))
        return res.status(400).json({ error: 'Phụ lục phải gắn với một hợp đồng gốc của dự án này.' });
      seq = Math.max(0, ...list.filter(x => x.kind === 'appendix' && x.parentId === parentId).map(x => +x.seq || 0)) + 1;
    }
    rec = { projectId, kind, ...(parentId ? { parentId } : {}), seq, ...c.data, createdBy: req.user.id, createdByName: req.user.name || req.user.id, createdAt: now, ...who };
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
    const n = (await store.all('contracts')).filter(x => x.kind === 'appendix' && x.parentId === id).length;
    if (n) return res.status(409).json({ error: `Hợp đồng gốc còn ${n} phụ lục. Xóa các phụ lục trước.` });
  }
  const accs = (await store.all('acceptances')).filter(a => a.contractId === id);
  if (accs.some(a => a.kind === 'quyettoan')) return res.status(409).json({ error: 'Hợp đồng đã quyết toán. Xóa quyết toán trước khi xóa hợp đồng gốc.' });
  if (accs.length) return res.status(409).json({ error: `Hợp đồng còn ${accs.length} đợt nghiệm thu gắn vào. Sửa hoặc xóa các đợt nghiệm thu trước.` });
  // Không xóa hợp đồng còn khoản thu gắn vào (kiểm tra trước mã xóa, như các ràng buộc khác)
  const nIn = (await store.all('transactions')).filter(t => t.contractId === id).length;
  if (nIn) return res.status(409).json({ error: `Hợp đồng còn ${nIn} khoản thu gắn vào. Chuyển các khoản thu sang hợp đồng khác trước.` });
  if (!(await passcodeOk(req, res))) return;
  await store.del('contracts', id);
  res.status(204).end();
}));

/* ---------- nghiệm thu, quyết toán ---------- */
// {projectId, kind: nghiemthu|quyettoan, seq (đợt nghiệm thu 1..n; quyết toán 0), contractId (chỉ nghiệm thu: '' hoặc hợp đồng
// của đúng dự án), no, date, value (trước VAT, > 0), vat (null = tạm tính), note, người tạo / sửa}. Tối đa một quyết toán mỗi dự án.
const ACC_KINDS = new Set(['nghiemthu', 'quyettoan']);
function cleanAcceptance(b, kind) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Dữ liệu không hợp lệ' };
  const no = b.no ?? '', note = b.note ?? '', vat = b.vat ?? null;
  if (typeof no !== 'string' || no.length > 60) return { error: 'Số biên bản / hồ sơ tối đa 60 ký tự.' };
  if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) return { error: kind === 'quyettoan' ? 'Chọn ngày quyết toán.' : 'Chọn ngày nghiệm thu.' };
  if (typeof note !== 'string' || note.length > 500) return { error: 'Ghi chú tối đa 500 ký tự.' };
  if (!Number.isInteger(b.value) || b.value <= 0) return { error: 'Giá trị trước VAT phải là số nguyên đồng lớn hơn 0.' };
  if (vat !== null && !(Number.isInteger(vat) && vat >= 0)) return { error: 'VAT phải là số nguyên đồng, không âm; để trống nếu chưa có (tạm tính).' };
  return { data: { no: no.trim(), date: b.date, value: b.value, vat, note: note.trim() } };
}
app.put('/api/acceptances/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const b = req.body || {}, old = await store.get('acceptances', id);
  if (old && ((b.kind !== undefined && b.kind !== old.kind) || (b.projectId !== undefined && b.projectId !== old.projectId)))
    return res.status(400).json({ error: 'Không đổi được loại hoặc dự án của biên bản đã ghi. Xóa và nhập lại.' });
  if (old?.kind === 'quyettoan' && b.contractId !== undefined && b.contractId !== old.contractId)
    return res.status(400).json({ error: 'Không đổi được hợp đồng của quyết toán đã ghi. Xóa và nhập lại.' });
  const projectId = old ? old.projectId : b.projectId, kind = old ? old.kind : b.kind;
  if (!ACC_KINDS.has(kind)) return res.status(400).json({ error: 'Loại không hợp lệ (nghiệm thu hoặc quyết toán).' });
  if (!old && !(typeof projectId === 'string' && ID_RE.test(projectId) && await store.get('projects', projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  const c = cleanAcceptance(b, kind);
  if (c.error) return res.status(400).json({ error: c.error });
  const cts = (await store.all('contracts')).filter(x => x.projectId === projectId);
  // Nhóm hợp đồng: HĐ gốc và các phụ lục của nó (id HĐ gốc)
  const groupOf = cid => { const x = cts.find(y => y.id === cid); return x ? (x.kind === 'base' ? x.id : x.parentId) : null; };
  if (kind === 'nghiemthu') {
    const cid = b.contractId;
    if (typeof cid !== 'string' || !cts.some(x => x.id === cid)) return res.status(400).json({ error: cid ? 'Hợp đồng không thuộc dự án này.' : 'Chọn hợp đồng (HĐ gốc hoặc phụ lục) của đợt nghiệm thu.' });
    if (old && groupOf(old.contractId) && groupOf(cid) !== groupOf(old.contractId)) return res.status(400).json({ error: 'Không chuyển được đợt nghiệm thu sang hợp đồng khác. Xóa và nhập lại.' });
    c.data.contractId = cid;
  } else {
    if (!cts.some(x => x.kind === 'base')) return res.status(400).json({ error: 'Dự án chưa có hợp đồng gốc, chưa quyết toán được.' });
    const cid = old ? old.contractId : b.contractId;
    if (!cts.some(x => x.id === cid && x.kind === 'base')) return res.status(400).json({ error: 'Quyết toán phải gắn với một hợp đồng gốc của dự án này.' });
    c.data.contractId = cid;
  }
  const now = new Date().toISOString();
  const who = { updatedBy: req.user.id, updatedByName: req.user.name || req.user.id, updatedAt: now };
  let rec;
  if (old) {
    const { id: _, sample, ...o } = old;
    rec = { ...o, ...c.data, ...who };
  } else {
    const list = (await store.all('acceptances')).filter(x => x.projectId === projectId);
    // Mỗi HĐ gốc tối đa một quyết toán; số đợt nghiệm thu đếm theo từng hợp đồng (nhóm HĐ gốc)
    if (kind === 'quyettoan' && list.some(x => x.kind === 'quyettoan' && x.contractId === c.data.contractId)) return res.status(400).json({ error: 'Hợp đồng này đã có quyết toán.' });
    const g = groupOf(c.data.contractId);
    const seq = kind === 'quyettoan' ? 0 : Math.max(0, ...list.filter(x => x.kind === 'nghiemthu' && groupOf(x.contractId) === g).map(x => +x.seq || 0)) + 1;
    rec = { projectId, kind, seq, ...c.data, createdBy: req.user.id, createdByName: req.user.name || req.user.id, createdAt: now, ...who };
  }
  await store.put('acceptances', id, rec);
  res.json({ id, ...rec });
}));
app.delete('/api/acceptances/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  if (!(await store.get('acceptances', id))) return res.status(204).end();
  if (!(await passcodeOk(req, res))) return;
  await store.del('acceptances', id);
  res.status(204).end();
}));

/* ---------- vay và trả nợ gốc ---------- */
// {projectId, kind: vay|tragoc, date, amount (nguyên đồng > 0, không VAT), lender, no, note, người tạo / sửa}.
// Không phải chi phí, không vào Tiền về / Thực chi. Dư nợ của dự án = vay − trả gốc, không được âm. Lãi vay nhập là khoản chi (Tài chính).
const LOAN_KINDS = new Set(['vay', 'tragoc']);
const debtOf = list => list.reduce((a, l) => a + (l.kind === 'vay' ? 1 : -1) * (+l.amount || 0), 0);
app.put('/api/loans/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const b = req.body || {}, old = await store.get('loans', id);
  if (old && ((b.kind !== undefined && b.kind !== old.kind) || (b.projectId !== undefined && b.projectId !== old.projectId)))
    return res.status(400).json({ error: 'Không đổi được loại hoặc dự án của khoản vay đã ghi. Xóa và nhập lại.' });
  const projectId = old ? old.projectId : b.projectId, kind = old ? old.kind : b.kind;
  if (!LOAN_KINDS.has(kind)) return res.status(400).json({ error: 'Loại không hợp lệ (vay hoặc trả gốc).' });
  if (!old && !(typeof projectId === 'string' && ID_RE.test(projectId) && await store.get('projects', projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  const lender = b.lender ?? '', no = b.no ?? '', note = b.note ?? '';
  if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) return res.status(400).json({ error: 'Chọn ngày.' });
  if (!Number.isInteger(b.amount) || b.amount <= 0) return res.status(400).json({ error: 'Số tiền phải là số nguyên đồng lớn hơn 0.' });
  if (typeof lender !== 'string' || lender.length > 120) return res.status(400).json({ error: 'Bên cho vay tối đa 120 ký tự.' });
  if (typeof no !== 'string' || no.length > 60) return res.status(400).json({ error: 'Số khế ước tối đa 60 ký tự.' });
  if (typeof note !== 'string' || note.length > 500) return res.status(400).json({ error: 'Ghi chú tối đa 500 ký tự.' });
  const data = { date: b.date, amount: b.amount, lender: lender.trim(), no: no.trim(), note: note.trim() };
  const others = (await store.all('loans')).filter(l => l.projectId === projectId && l.id !== id);
  if (debtOf([...others, { kind, amount: data.amount }]) < 0)
    return res.status(400).json({ error: kind === 'tragoc' ? 'Trả nợ gốc vượt dư nợ vay.' : 'Số tiền vay nhỏ hơn tổng đã trả gốc: dư nợ sẽ âm.' });
  const now = new Date().toISOString(), who = { updatedBy: req.user.id, updatedByName: req.user.name || req.user.id, updatedAt: now };
  let rec;
  if (old) { const { id: _, sample, ...o } = old; rec = { ...o, ...data, ...who }; }
  else rec = { projectId, kind, ...data, createdBy: req.user.id, createdByName: req.user.name || req.user.id, createdAt: now, ...who };
  await store.put('loans', id, rec);
  res.json({ id, ...rec });
}));
app.delete('/api/loans/:id', canWrite, wrap(async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Đường dẫn không hợp lệ' });
  const l = await store.get('loans', id);
  if (!l) return res.status(204).end();
  if (l.kind === 'vay' && debtOf((await store.all('loans')).filter(x => x.projectId === l.projectId && x.id !== id)) < 0)
    return res.status(409).json({ error: 'Xóa khoản vay này thì dư nợ âm. Xóa các khoản trả gốc tương ứng trước.' });
  if (!(await passcodeOk(req, res))) return;
  await store.del('loans', id);
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

// Giao dịch thu/chi có VAT (xem CLAUDE.md "VAT giao dịch thu/chi"): amount = sau VAT (tên cũ, giữ để đọc được dữ liệu cũ),
// pre = trước VAT, vat = VAT (null = tạm tính). Dữ liệu cũ chỉ có amount: coi là sau VAT, VAT tạm tính.
// Khoản thu: contractId ('' = ngoài hợp đồng) bắt buộc khi dự án đã có hợp đồng. Khoản chi: partner (đối tác).
// Trả về thông báo lỗi, hoặc null nếu hợp lệ (đồng thời chuẩn hóa data).
async function txProblem(data) {
  const isInt = v => Number.isInteger(v);
  if (data.vat === undefined) delete data.vat;
  if (data.pre == null) delete data.pre;
  if (data.vat != null && !(isInt(data.vat) && data.vat >= 0)) return 'VAT phải là số nguyên đồng, không âm; để trống nếu chưa có (tạm tính).';
  if (data.pre != null && !(isInt(data.pre) && data.pre > 0)) return 'Số tiền trước VAT phải là số nguyên đồng lớn hơn 0.';
  if (data.pre == null && data.vat != null) data.pre = data.amount - data.vat;   // chỉ gửi sau VAT + VAT: tự tính trước VAT
  if (data.pre != null && (data.pre <= 0 || data.amount !== data.pre + (data.vat || 0))) return 'Trước VAT + VAT phải bằng Sau VAT.';
  for (const [k, max] of [['invoiceNo', 60], ['partner', 120], ['note', 500], ['category', 120]])
    if (data[k] != null && (typeof data[k] !== 'string' || data[k].length > max)) return 'Dữ liệu không hợp lệ';
  if (data.invoiceDate != null && data.invoiceDate !== '' && !(typeof data.invoiceDate === 'string' && DATE_RE.test(data.invoiceDate))) return 'Ngày hóa đơn không hợp lệ.';
  delete data.oldCategory;   // tên hạng mục cũ chỉ do bước chuyển đổi ghi, không nhận từ người dùng
  if (data.type === 'out') {
    delete data.contractId;
    if (!COST_GROUPS[data.group] || !COST_GROUPS[data.group].includes(data.category)) return 'Hạng mục không thuộc khối chi phí đã chọn.';
    return null;
  }
  delete data.partner; delete data.group;
  const cts = (await store.all('contracts')).filter(c => c.projectId === data.projectId);
  if (data.contractId == null) return cts.length ? 'Chọn hợp đồng hoặc Ngoài hợp đồng.' : null;
  if (typeof data.contractId !== 'string') return 'Dữ liệu không hợp lệ';
  if (data.contractId !== '' && !cts.some(c => c.id === data.contractId)) return 'Hợp đồng không thuộc dự án này.';
  return null;
}

// Dự án (xem CLAUDE.md "Nhập liệu và Báo cáo", "Chi phí kế hoạch theo hạng mục"):
// - bắt buộc mã dự án, tên, chủ đầu tư (client); mã không trùng (không phân biệt hoa thường, bỏ khoảng trắng đầu cuối);
// - budgetPlan {"group|category": đồng, unallocated: đồng}: khóa theo danh mục cố định, số nguyên ≥ 0; có budgetPlan thì
//   budget = Σ budgetPlan (máy chủ tính, bỏ qua budget gửi lên); người lưu kế hoạch / thời điểm do máy chủ ghi;
// - không gửi budgetPlan / budget thì giữ giá trị đang có (form thông tin dự án không còn ô ngân sách).
const PLAN_KEYS = new Set(['unallocated', ...Object.entries(COST_GROUPS).flatMap(([g, cs]) => cs.map(c => g + '|' + c))]);
async function projectProblem(id, data, user) {
  for (const k of ['code', 'client', 'manager', 'status', 'start', 'end'])
    if (data[k] != null && typeof data[k] !== 'string') return [400, 'Dữ liệu không hợp lệ'];
  data.name = data.name.trim();
  data.code = String(data.code || '').trim(); data.client = String(data.client || '').trim();
  if (!data.code) return [400, 'Nhập mã dự án.'];
  if (data.code.length > 30 || data.name.length > 200 || data.client.length > 200) return [400, 'Dữ liệu quá dài.'];
  if (!data.client) return [400, 'Nhập chủ đầu tư.'];
  const all = await store.all('projects'), key = data.code.toLowerCase();
  if (all.some(p => p.id !== id && String(p.code || '').trim().toLowerCase() === key)) return [409, 'Mã dự án đã tồn tại.'];
  const old = all.find(p => p.id === id);
  for (const k of ['budgetPlanBy', 'budgetPlanByName', 'budgetPlanAt']) delete data[k];
  if (data.budgetPlan === undefined && old?.budgetPlan) {
    data.budgetPlan = old.budgetPlan;
    for (const k of ['budgetPlanBy', 'budgetPlanByName', 'budgetPlanAt']) if (old[k] !== undefined) data[k] = old[k];
  } else if (data.budgetPlan != null) {
    const bp = data.budgetPlan;
    if (typeof bp !== 'object' || Array.isArray(bp)) return [400, 'Kế hoạch chi phí không hợp lệ.'];
    for (const [k, v] of Object.entries(bp)) {
      if (!PLAN_KEYS.has(k)) return [400, `Hạng mục kế hoạch không hợp lệ: ${k}`];
      if (!(Number.isInteger(v) && v >= 0)) return [400, 'Kế hoạch mỗi hạng mục phải là số nguyên đồng, không âm.'];
    }
    Object.assign(data, { budgetPlanBy: user.id, budgetPlanByName: user.name || user.id, budgetPlanAt: new Date().toISOString() });
  } else delete data.budgetPlan;
  if (data.budgetPlan) data.budget = Object.values(data.budgetPlan).reduce((a, v) => a + v, 0);
  else if (data.budget === undefined && old) data.budget = +old.budget || 0;
  return null;
}

app.put('/api/:col/:id', canWrite, wrap(async (req, res) => {
  if (!check(req, res)) return;
  if (!valid(req.params.col, req.body)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
  // Bản ghi người dùng ghi (tạo mới hoặc sửa) không còn là dữ liệu ví dụ: Xóa dữ liệu ví dụ sẽ không xóa nó
  const { sample, ...data } = req.body;
  // Giao dịch luôn thuộc một dự án đang tồn tại
  if (req.params.col === 'transactions' && !(ID_RE.test(req.body.projectId) && await store.get('projects', req.body.projectId)))
    return res.status(400).json({ error: 'Dự án không tồn tại.' });
  if (req.params.col === 'projects') {
    const bad = await projectProblem(req.params.id, data, req.user);
    if (bad) return res.status(bad[0]).json({ error: bad[1] });
  }
  if (req.params.col === 'transactions') {
    const old = await store.get('transactions', req.params.id);
    if (old && old.type !== data.type) return res.status(400).json({ error: 'Không đổi được loại thu/chi của khoản đã ghi.' });
    const bad = await txProblem(data);
    if (bad) return res.status(400).json({ error: bad });
    if (old?.oldCategory && data.type === 'out') data.oldCategory = old.oldCategory;   // giữ dấu vết hạng mục trước chuyển đổi
    // Người nhập / người sửa do máy chủ ghi theo tài khoản đăng nhập, bỏ qua giá trị gửi lên.
    // Sửa: giữ nguyên người tạo và thời điểm tạo (giao dịch cũ chưa có thì để trống). createdAt là số mili giây như dữ liệu cũ.
    for (const k of ['createdBy', 'createdByName', 'createdAt', 'updatedBy', 'updatedByName', 'updatedAt']) delete data[k];
    const created = old ? { createdBy: old.createdBy, createdByName: old.createdByName, createdAt: old.createdAt }
      : { createdBy: req.user.id, createdByName: req.user.name || req.user.id, createdAt: Date.now() };
    const rec = { ...data, ...created, updatedBy: req.user.id, updatedByName: req.user.name || req.user.id, updatedAt: new Date().toISOString() };
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    await store.put('transactions', req.params.id, rec);
    return res.json({ id: req.params.id, ...rec });
  }
  await store.put(req.params.col, req.params.id, data);
  res.status(204).end();
}));

app.delete('/api/:col/:id', canWrite, wrap(async (req, res) => {
  if (!check(req, res)) return;
  // Không xóa dự án còn giao dịch tham chiếu, tránh mất dữ liệu
  if (req.params.col === 'projects') {
    const [txs, cts, accs, loans] = await Promise.all(['transactions', 'contracts', 'acceptances', 'loans'].map(c => store.all(c)));
    const nl = loans.filter(l => l.projectId === req.params.id).length;
    if (nl) return res.status(409).json({ error: `Dự án còn ${nl} khoản vay / trả gốc. Xóa các khoản này trước, hoặc đổi trạng thái thành Hoàn thành.` });
    const n = txs.filter(t => t.projectId === req.params.id).length, m = cts.filter(c => c.projectId === req.params.id).length;
    const k = accs.filter(a => a.projectId === req.params.id).length;
    if (k) return res.status(409).json({ error: `Dự án còn ${k} biên bản nghiệm thu / quyết toán. Xóa các biên bản này trước, hoặc đổi trạng thái thành Hoàn thành.` });
    if (n && !m) return res.status(409).json({ error: `Dự án còn ${n} giao dịch. Xóa hoặc chuyển các giao dịch sang dự án khác trước, hoặc đổi trạng thái thành Hoàn thành.` });
    if (m) return res.status(409).json({ error: `Dự án còn ${[n && `${n} giao dịch`, `${m} dòng hợp đồng`].filter(Boolean).join(' và ')}. Xóa các giao dịch và hợp đồng của dự án trước, hoặc đổi trạng thái thành Hoàn thành.` });
  }
  if (!(await passcodeOk(req, res))) return;
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
function readResetFile() {
  try { return JSON.parse(fs.readFileSync(process.env.RESET_FILE || path.join(__dirname, 'deploy', 'reset.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('deploy/reset.json không đọc được:', e.message); return null; }
}
async function factoryReset() {
  const file = readResetFile();
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
  .then(migrateCostGroups)
  .then(migrateContractGroups)
  .then(sampleSeed)
  .then(auth.bootstrap)
  .then(() => app.listen(PORT, () => {
    // Railway tự đặt RAILWAY_GIT_BRANCH / RAILWAY_GIT_COMMIT_SHA: cho biết bản code nào đang chạy
    const src = process.env.RAILWAY_GIT_COMMIT_SHA ? ` · mã nguồn ${process.env.RAILWAY_GIT_BRANCH || '?'}@${process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)}` : '';
    console.log(`Sổ Tài Chính Dự Án [${ENV_NAME}] chạy ở cổng ${PORT}, lưu dữ liệu vào ${store.kind}${src}`);
  }))
  .catch(e => { console.error('Không khởi động được:', e); process.exit(1); });
