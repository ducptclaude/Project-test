// Tài khoản đăng nhập: trang /login, phiên bằng cookie ký HMAC, phân quyền và quản lý người dùng.
// Vai trò: viewer (chỉ xem) < editor (nhập liệu) < admin (nhập liệu + quản lý tài khoản).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const ROLES = { viewer: 1, editor: 2, admin: 3 };
const COOKIE = 'stc_session';
// Phiên trượt: hết hạn sau IDLE_MIN phút không hoạt động; mỗi yêu cầu do người dùng thao tác gia hạn lại.
// Yêu cầu chạy ngầm (trang tự cập nhật số liệu, gửi kèm X-Background: 1) không tính là hoạt động.
const IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES) || 60;
const IDLE_MS = IDLE_MIN * 60e3, RENEW_MS = Math.min(60e3, IDLE_MS / 4);
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Khóa ký phiên: SESSION_SECRET nếu có, không thì tạo một lần và lưu trong cơ sở dữ liệu (bootstrap),
// để deploy lại hay khởi động lại máy chủ cũng không đăng xuất mọi người.
let SECRET = String(process.env.SESSION_SECRET || '').trim() || null;

/* ---------- mật khẩu ---------- */
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => e ? no(e) : ok(k)));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex');
}
async function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = await scrypt(pw, Buffer.from(salt, 'hex')), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const passwordProblem = pw => typeof pw !== 'string' || pw.length < 8 ? 'Mật khẩu cần ít nhất 8 ký tự.' : null;

/* ---------- phiên đăng nhập ---------- */
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(user) {
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ u: user.id, v: user.ver || 0, i: now, e: now + IDLE_MS })).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() ? p : null; } catch { return null; }
}
const getCookie = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};
function setSession(req, res, user) {
  res.cookie(COOKIE, makeToken(user), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: IDLE_MS, path: '/' });
}

// Chặn dò mật khẩu: tối đa 8 lần sai trong 15 phút cho mỗi địa chỉ IP + tên đăng nhập
const fails = new Map();
const failKey = (req, u) => req.ip + '|' + u;
function tooMany(key, max = 8) { const f = fails.get(key); return f && f.n >= max && f.until > Date.now(); }
function addFail(key) {
  const f = fails.get(key); const now = Date.now();
  fails.set(key, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + 15 * 60e3 });
  if (fails.size > 5000) for (const [k, v] of fails) if (v.until < now) fails.delete(k);
}

const publicUser = u => ({ username: u.id, name: u.name || u.id, role: u.role, active: u.active !== false, mustChange: !!u.mustChange, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null });

module.exports = function (store, wrap) {
  const router = express.Router();

  async function currentUser(req) {
    const t = readToken(getCookie(req, COOKIE));
    if (!t) return null;
    const u = await store.get('users', t.u);
    if (!(u && u.active !== false && (u.ver || 0) === t.v)) return null;
    req.sessionToken = t;
    return u;
  }
  async function activeAdmins() { return (await store.all('users')).filter(u => u.role === 'admin' && u.active !== false); }

  /* trang đăng nhập và logo: không cần đăng nhập */
  // Chế độ khởi tạo: chưa có tài khoản nào và không có ADMIN_PASSWORD hợp lệ → người mở trang /setup
  // nhập mã khởi tạo (in trong log máy chủ) để tự tạo quản trị viên đầu tiên.
  let setupCode = null;
  const noUsers = async () => !(await store.all('users')).length;
  router.get('/setup', wrap(async (req, res) => {
    if (!setupCode || !(await noUsers())) return res.redirect('login');
    res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'setup.html'));
  }));
  router.post('/api/setup', express.json({ limit: '10kb' }), wrap(async (req, res) => {
    if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Yêu cầu không hợp lệ' });
    if (!setupCode || !(await noUsers())) return res.status(409).json({ error: 'Hệ thống đã được khởi tạo. Hãy đăng nhập.' });
    const key = failKey(req, '#setup');
    if (tooMany(key)) return res.status(429).json({ error: 'Nhập sai mã quá nhiều lần. Hãy thử lại sau 15 phút.' });
    const b = req.body || {}, code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const want = Buffer.from(setupCode.replace(/-/g, '')), got = Buffer.from(code);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) { addFail(key); return res.status(400).json({ error: 'Mã khởi tạo không đúng. Xem lại dòng "Mã khởi tạo" trong Deploy Logs.' }); }
    const username = String(b.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Tên đăng nhập gồm 3–32 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.' });
    const bad = passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
    const user = { name: String(b.name || '').trim().slice(0, 80) || username, role: 'admin', active: true, ver: 0,
      passHash: await hashPassword(b.password), mustChange: false, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await store.put('users', username, user);
    setupCode = null; fails.delete(key);
    console.log(`Khởi tạo xong: đã tạo quản trị viên "${username}" qua trang /setup.`);
    setSession(req, res, { id: username, ...user });
    res.json({ ok: true });
  }));

  router.get('/login', async (req, res) => {
    if (setupCode && await noUsers().catch(() => false)) return res.redirect('setup');
    if (await currentUser(req).catch(() => null)) return res.redirect('./');
    res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });
  router.use('/brand', express.static(path.join(PUBLIC_DIR, 'brand'), { maxAge: '1h', fallthrough: false }));
  router.get('/api/brand', (req, res) => res.json({
    logo: fs.existsSync(path.join(PUBLIC_DIR, 'brand', 'logo.png')),
    name: process.env.BRAND_NAME || 'Sổ Tài Chính Dự Án',
    org: process.env.BRAND_ORG || '',
    tagline: process.env.BRAND_TAGLINE || '',
    footer: process.env.BRAND_FOOTER || ''
  }));

  // Các yêu cầu thay đổi dữ liệu phải gửi kèm X-Requested-With (chặn form giả mạo từ trang khác)
  router.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Yêu cầu không hợp lệ' });
    next();
  });

  router.post('/api/login', express.json({ limit: '10kb' }), wrap(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase(), password = String(req.body?.password || '');
    const key = failKey(req, username);
    if (tooMany(key)) return res.status(429).json({ error: 'Bạn đã nhập sai quá nhiều lần. Hãy thử lại sau 15 phút.' });
    const u = username && await store.get('users', username);
    const ok = u && u.active !== false && await checkPassword(password, u.passHash);
    if (!ok) { addFail(key); return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' }); }
    fails.delete(key);
    const { id, ...data } = u;
    await store.put('users', id, { ...data, lastLoginAt: new Date().toISOString() });
    setSession(req, res, u);
    res.json({ ok: true, mustChange: !!u.mustChange });
  }));

  router.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.status(204).end(); });

  /* từ đây trở đi cần đăng nhập */
  const requireLogin = wrap(async (req, res, next) => {
    const u = await currentUser(req);
    if (u) {
      req.user = u;
      // Gia hạn phiên khi người dùng thực sự thao tác (không gia hạn cho yêu cầu chạy ngầm)
      if (req.get('X-Background') !== '1' && Date.now() - (req.sessionToken.i || 0) > RENEW_MS) setSession(req, res, u);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' });
    res.redirect(req.baseUrl + '/login');
  });
  const requireRole = role => (req, res, next) =>
    (ROLES[req.user?.role] || 0) >= ROLES[role] ? next() : res.status(403).json({ error: 'Tài khoản của bạn không có quyền thao tác này.' });

  const authed = express.Router();
  authed.use(express.json({ limit: '10kb' }));

  authed.get('/api/me', (req, res) => res.set('Cache-Control', 'no-store').json({ ...publicUser(req.user), idleMinutes: IDLE_MIN }));

  authed.post('/api/me/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (!await checkPassword(String(current || ''), req.user.passHash)) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
    const bad = passwordProblem(next); if (bad) return res.status(400).json({ error: bad });
    const { id, ...data } = req.user;
    const updated = { ...data, passHash: await hashPassword(next), ver: (data.ver || 0) + 1, mustChange: false };
    await store.put('users', id, updated);
    setSession(req, res, { id, ...updated });
    res.status(204).end();
  }));

  const admin = requireRole('admin');
  authed.get('/api/users', admin, wrap(async (req, res) => {
    const list = (await store.all('users')).map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
    res.set('Cache-Control', 'no-store').json(list);
  }));

  authed.post('/api/users', admin, wrap(async (req, res) => {
    const b = req.body || {}, username = String(b.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Tên đăng nhập gồm 3–32 ký tự: chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.' });
    if (!ROLES[b.role]) return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
    const bad = passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
    if (await store.get('users', username)) return res.status(409).json({ error: 'Tên đăng nhập này đã có người dùng.' });
    await store.put('users', username, {
      name: String(b.name || '').trim().slice(0, 80) || username, role: b.role, active: true, ver: 0,
      passHash: await hashPassword(b.password), mustChange: true, createdAt: new Date().toISOString(), createdBy: req.user.id
    });
    res.status(201).json({ ok: true });
  }));

  authed.patch('/api/users/:u', admin, wrap(async (req, res) => {
    const u = await store.get('users', req.params.u);
    if (!u) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    const b = req.body || {}, { id, ...data } = u;
    if ('name' in b) data.name = String(b.name || '').trim().slice(0, 80) || id;
    if ('role' in b) { if (!ROLES[b.role]) return res.status(400).json({ error: 'Vai trò không hợp lệ.' }); data.role = b.role; }
    if ('active' in b) { data.active = !!b.active; if (!data.active) data.ver = (data.ver || 0) + 1; }
    if ('password' in b) {
      const bad = passwordProblem(b.password); if (bad) return res.status(400).json({ error: bad });
      data.passHash = await hashPassword(b.password); data.ver = (data.ver || 0) + 1; data.mustChange = id !== req.user.id;
    }
    const losesAdmin = u.role === 'admin' && u.active !== false && (data.role !== 'admin' || data.active === false);
    if (losesAdmin && (await activeAdmins()).length <= 1) return res.status(400).json({ error: 'Phải còn ít nhất một quản trị viên đang hoạt động.' });
    await store.put('users', id, data);
    if (id === req.user.id && 'password' in b) setSession(req, res, { id, ...data });
    res.status(204).end();
  }));

  authed.delete('/api/users/:u', admin, wrap(async (req, res) => {
    if (req.params.u === req.user.id) return res.status(400).json({ error: 'Bạn không thể tự xóa tài khoản của mình.' });
    const u = await store.get('users', req.params.u);
    if (!u) return res.status(204).end();
    if (u.role === 'admin' && u.active !== false && (await activeAdmins()).length <= 1) return res.status(400).json({ error: 'Phải còn ít nhất một quản trị viên đang hoạt động.' });
    const bad = await checkDeletePasscode(req, req.body?.passcode);
    if (bad) return res.status(bad.status).json({ error: bad.error });
    await store.del('users', u.id);
    res.status(204).end();
  }));

  /* ---------- mã xóa dữ liệu ---------- */
  // Quản trị viên đặt mã xóa (4–12 ký tự); lưu băm scrypt trong meta deletePasscode, không bao giờ trả mã ra ngoài.
  // Áp dụng cho mọi thao tác xóa: giao dịch, dự án, hợp đồng, dữ liệu ví dụ, tài khoản.
  const PASSCODE_MAX_FAILS = 5;
  authed.get('/api/delete-passcode', admin, wrap(async (req, res) => {
    const m = await store.get('meta', 'deletePasscode');
    res.set('Cache-Control', 'no-store').json({ set: !!m?.hash, updatedAt: m?.updatedAt || null, updatedByName: m?.updatedByName || null });
  }));
  authed.put('/api/delete-passcode', admin, wrap(async (req, res) => {
    const code = req.body?.passcode;
    if (typeof code !== 'string' || code.length < 4 || code.length > 12) return res.status(400).json({ error: 'Mã xóa gồm 4–12 ký tự.' });
    await store.put('meta', 'deletePasscode', { hash: await hashPassword(code), updatedAt: new Date().toISOString(), updatedBy: req.user.id, updatedByName: req.user.name || req.user.id });
    res.status(204).end();
  }));
  // Trả null nếu mã đúng; nếu không, trả {status, error}. Sai 5 lần trong 15 phút (theo tài khoản) thì tạm khóa.
  async function checkDeletePasscode(req, code) {
    const m = await store.get('meta', 'deletePasscode');
    if (!m?.hash) return { status: 409, error: 'Quản trị viên chưa đặt mã xóa.' };
    const key = '#xoa|' + req.user.id;
    if (tooMany(key, PASSCODE_MAX_FAILS)) return { status: 429, error: 'Nhập sai mã xóa quá nhiều lần. Hãy thử lại sau 15 phút.' };
    if (typeof code !== 'string' || !code || !(await checkPassword(code, m.hash))) { addFail(key); return { status: 403, error: 'Mã xóa không đúng.' }; }
    fails.delete(key);
    return null;
  }

  // Khởi tạo và khôi phục tài khoản quản trị khi máy chủ khởi động (giá trị biến được cắt khoảng trắng):
  // - chưa có tài khoản nào: tạo ADMIN_USERNAME (mặc định admin) với ADMIN_PASSWORD, hoặc mật khẩu tạm in ra log;
  // - ADMIN_RESET=true: đặt lại (hoặc tạo) tài khoản ADMIN_USERNAME với ADMIN_PASSWORD, quyền Quản trị, đăng xuất phiên cũ;
  // - ADMIN_RESET=all: xóa MỌI tài khoản rồi tạo lại đúng một quản trị viên như trên.
  // Biến sai thì ghi lỗi vào log và bỏ qua, không làm sập máy chủ. Dùng xong phải xóa ADMIN_RESET.
  async function bootstrap() {
    if (!SECRET) {
      const m = await store.get('meta', 'sessionSecret');
      SECRET = m?.secret || crypto.randomBytes(32).toString('hex');
      if (!m?.secret) { await store.put('meta', 'sessionSecret', { secret: SECRET, at: new Date().toISOString() }); console.log('Đã tạo khóa phiên và lưu trong cơ sở dữ liệu (deploy lại không đăng xuất người dùng).'); }
    }
    const env = k => String(process.env[k] ?? '').trim();
    // ADMIN_USER / APP_USER được chấp nhận như tên khác của ADMIN_USERNAME
    const username = (env('ADMIN_USERNAME') || env('ADMIN_USER') || env('APP_USER') || 'admin').toLowerCase();
    const mode = env('ADMIN_RESET').toLowerCase();
    const resetOne = ['true', '1', 'yes', 'on'].includes(mode), resetAll = mode === 'all';
    if (mode && !resetOne && !resetAll) console.error(`ADMIN_RESET="${mode}" không hợp lệ: dùng true (đặt lại một tài khoản) hoặc all (xóa mọi tài khoản rồi tạo lại).`);
    if (resetOne || resetAll) {
      const password = env('ADMIN_PASSWORD');
      const bad = !USERNAME_RE.test(username) ? `ADMIN_USERNAME "${username}" không hợp lệ: 3–32 ký tự chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang.`
        : !password ? 'Chưa đặt ADMIN_PASSWORD.' : passwordProblem(password);
      if (bad) console.error('ADMIN_RESET bị bỏ qua: ' + bad);
      else {
        let removed = 0;
        if (resetAll) for (const u of await store.all('users')) { await store.del('users', u.id); removed++; }
        const old = resetAll ? null : await store.get('users', username);
        const { id, ...data } = old || { createdAt: new Date().toISOString() };
        await store.put('users', username, {
          ...data, name: env('ADMIN_NAME') || data.name || 'Quản trị viên', role: 'admin', active: true,
          passHash: await hashPassword(password), ver: (data.ver || 0) + 1, mustChange: false
        });
        console.warn(`ADMIN_RESET: ${resetAll ? `đã xóa ${removed} tài khoản cũ và tạo` : old ? 'đã đặt lại' : 'đã tạo'} tài khoản quản trị "${username}" (mật khẩu ${password.length} ký tự, lấy từ ADMIN_PASSWORD). Hãy xóa biến ADMIN_RESET ngay.`);
      }
    }
    if (!(await store.all('users')).length) {
      const password = env('ADMIN_PASSWORD') || env('APP_PASSWORD');
      if (USERNAME_RE.test(username) && !passwordProblem(password)) {
        await store.put('users', username, {
          name: env('ADMIN_NAME') || 'Quản trị viên', role: 'admin', active: true, ver: 0,
          passHash: await hashPassword(password), mustChange: false, createdAt: new Date().toISOString()
        });
        console.log(`Đã tạo tài khoản quản trị "${username}", mật khẩu lấy từ ADMIN_PASSWORD.`);
      } else {
        const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', r = crypto.randomBytes(8);
        setupCode = [...r].map(n => c[n % c.length]).join('').replace(/^(.{4})/, '$1-');
        console.warn(`CHƯA CÓ TÀI KHOẢN NÀO. Mở trang /setup và nhập Mã khởi tạo: ${setupCode} (mã đổi mỗi lần máy chủ khởi động lại).`);
      }
    }
    const users = await store.all('users');
    const admins = users.filter(u => u.role === 'admin' && u.active !== false).map(u => u.id);
    console.log(`Tài khoản: ${users.length} · quản trị viên đang hoạt động: ${admins.join(', ') || '(không có)'}`);
  }

  return { router, requireLogin: [requireLogin, authed], requireRole, bootstrap, checkDeletePasscode };
};
