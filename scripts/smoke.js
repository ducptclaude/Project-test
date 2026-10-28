// Kiểm tra nhanh toàn bộ luồng chính: khởi động máy chủ với dữ liệu tạm, đăng nhập, phân quyền, ghi/xóa dữ liệu.
// Chạy: npm test   (không cần Postgres, không đụng dữ liệu thật)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-smoke-'));
const env = { ...process.env, PORT, DATA_DIR: dataDir, SESSION_SECRET: 'smoke', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Admin12345', APP_ENV: 'test' };
// Mặc định dùng tệp JSON tạm. Muốn thử với PostgreSQL: SMOKE_DATABASE_URL=<một cơ sở dữ liệu TRỐNG, không phải production>
if (process.env.SMOKE_DATABASE_URL) env.DATABASE_URL = process.env.SMOKE_DATABASE_URL; else delete env.DATABASE_URL;

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const h = { 'X-Requested-With': 'fetch', ...headers };
    if (cookie) h.cookie = cookie;
    if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, location: r.headers.get('location') };
  };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('chưa đăng nhập: trang chính chuyển về /login, API trả 401', async () => {
  const c = client();
  assert.equal((await c('GET', '/')).status, 302);
  assert.equal((await c('GET', '/api/data')).status, 401);
  assert.equal((await c('GET', '/login')).status, 200);
});
check('chặn yêu cầu thiếu X-Requested-With', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' }, { 'X-Requested-With': '' })).status, 403);
});
check('sai mật khẩu bị từ chối, đúng thì vào được', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'sai' })).status, 401);
  assert.equal((await c('POST', '/api/login', { username: 'ADMIN', password: 'Admin12345' })).status, 200);
  const me = await c('GET', '/api/me'); assert.equal(me.json.role, 'admin');
  const d = await c('GET', '/api/data'); assert.equal(d.status, 200); assert.ok(d.json.projects.length > 0, 'thiếu dữ liệu ví dụ');
});
check('phân quyền: Chỉ xem không ghi được, Nhập liệu ghi được', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  assert.equal((await a('POST', '/api/users', { username: 'xem', name: 'Xem', role: 'viewer', password: 'Xem123456' })).status, 201);
  assert.equal((await a('POST', '/api/users', { username: 'nhap', name: 'Nhập', role: 'editor', password: 'Nhap12345' })).status, 201);
  const tx = { projectId: 'da01', type: 'in', date: '2026-10-01', amount: 1000000, category: 'Thu khác', note: 'smoke' };
  const v = client(); await v('POST', '/api/login', { username: 'xem', password: 'Xem123456' });
  assert.equal((await v('PUT', '/api/transactions/smoke1', tx)).status, 403);
  assert.equal((await v('GET', '/api/users')).status, 403);
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  assert.equal((await e('PUT', '/api/transactions/smoke1', tx)).status, 204);
  assert.equal((await e('PUT', '/api/transactions/smoke2', { ...tx, amount: -5 })).status, 400);
  assert.equal((await e('GET', '/api/users')).status, 403);
  assert.equal((await e('DELETE', '/api/transactions/smoke1')).status, 204);
});
check('đổi mật khẩu, khóa tài khoản thì phiên cũ hết hiệu lực', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const v = client(); await v('POST', '/api/login', { username: 'xem', password: 'Xem123456' });
  assert.equal((await v('GET', '/api/me')).json.mustChange, true);
  assert.equal((await v('POST', '/api/me/password', { current: 'Xem123456', next: 'XemMoi9999' })).status, 204);
  assert.equal((await v('GET', '/api/me')).json.mustChange, false);
  assert.equal((await a('PATCH', '/api/users/xem', { active: false })).status, 204);
  assert.equal((await v('GET', '/api/data')).status, 401);
});
check('không thể bỏ quản trị viên cuối cùng', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  assert.equal((await a('PATCH', '/api/users/admin', { role: 'viewer' })).status, 400);
  assert.equal((await a('DELETE', '/api/users/admin')).status, 400);
});
check('đăng xuất', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  assert.equal((await a('POST', '/api/logout')).status, 204);
});

function start(extra = {}) {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.log = ''; srv.stdout.on('data', d => srv.log += d); srv.stderr.on('data', d => srv.log += d);
  return new Promise((ok, no) => {
    let i = 0;
    const poll = async () => {
      try { if ((await fetch(BASE + '/healthz')).ok) return ok(srv); } catch {}
      if (srv.exitCode !== null || ++i > 50) { srv.kill(); return no(new Error('Máy chủ không khởi động được:\n' + srv.log)); }
      setTimeout(poll, 100);
    };
    poll();
  });
}
const stop = srv => new Promise(ok => { if (srv.exitCode !== null) return ok(); srv.once('exit', ok); srv.kill(); });

// Kiểm tra cần khởi động lại máy chủ với biến môi trường khác
const restartChecks = [
  ['ADMIN_RESET tạo tài khoản quản trị mới, giữ tài khoản cũ', async () => {
    const srv = await start({ ADMIN_RESET: 'true', ADMIN_USERNAME: 'quantri', ADMIN_PASSWORD: 'QuanTri2026' });
    try {
      const c = client();
      assert.equal((await c('POST', '/api/login', { username: 'quantri', password: 'QuanTri2026' })).status, 200);
      assert.equal((await c('GET', '/api/me')).json.role, 'admin');
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'Admin12345' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['ADMIN_RESET đặt lại mật khẩu và đăng xuất phiên cũ của tài khoản đó', async () => {
    let srv = await start();
    const old = client();
    try { assert.equal((await old('POST', '/api/login', { username: 'admin', password: 'Admin12345' })).status, 200); } finally { await stop(srv); }
    srv = await start({ ADMIN_RESET: 'true', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'MatKhauMoi9' });
    try {
      assert.equal((await old('GET', '/api/data')).status, 401);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'Admin12345' })).status, 401);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'MatKhauMoi9' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['ADMIN_RESET với mật khẩu quá ngắn: bỏ qua, máy chủ vẫn chạy', async () => {
    const srv = await start({ ADMIN_RESET: 'true', ADMIN_PASSWORD: '123' });
    try {
      assert.match(srv.log, /ADMIN_RESET bị bỏ qua/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'MatKhauMoi9' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['ADMIN_RESET chấp nhận " TRUE " và cắt khoảng trắng của mật khẩu', async () => {
    const srv = await start({ ADMIN_RESET: ' TRUE ', ADMIN_USERNAME: ' Admin ', ADMIN_PASSWORD: ' CoKhoangTrang1 \n' });
    try { assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'CoKhoangTrang1' })).status, 200); }
    finally { await stop(srv); }
  }],
  ['ADMIN_RESET đọc tên đăng nhập từ ADMIN_USER khi không có ADMIN_USERNAME', async () => {
    const srv = await start({ ADMIN_RESET: 'true', ADMIN_USERNAME: '', ADMIN_USER: 'ketoan', ADMIN_PASSWORD: 'KeToan2026' });
    try { assert.equal((await client()('POST', '/api/login', { username: 'ketoan', password: 'KeToan2026' })).status, 200); }
    finally { await stop(srv); }
  }],
  ['ADMIN_RESET=all xóa mọi tài khoản và tạo lại một quản trị viên', async () => {
    const srv = await start({ ADMIN_RESET: 'all', ADMIN_USERNAME: 'chu.du.an', ADMIN_PASSWORD: 'KhoiTao2026' });
    try {
      assert.match(srv.log, /quản trị viên đang hoạt động: chu\.du\.an\n/);
      assert.equal((await client()('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' })).status, 401);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'CoKhoangTrang1' })).status, 401);
      const c = client();
      assert.equal((await c('POST', '/api/login', { username: 'chu.du.an', password: 'KhoiTao2026' })).status, 200);
      assert.equal((await c('GET', '/api/users')).json.length, 1);
      assert.ok((await c('GET', '/api/data')).json.projects.length > 0, 'dữ liệu dự án phải còn nguyên');
    } finally { await stop(srv); }
  }],
  ['FACTORY_RESET xóa sạch dữ liệu, mở trang /setup bằng mã khởi tạo', async () => {
    const blank = { ADMIN_USERNAME: '', ADMIN_PASSWORD: '', ADMIN_RESET: '' };
    let srv = await start({ ...blank, FACTORY_RESET: 'lan-1' });
    try {
      assert.match(srv.log, /FACTORY_RESET: đã xóa toàn bộ/);
      const code = (srv.log.match(/Mã khởi tạo: ([A-Z0-9-]+)/) || [])[1];
      assert.ok(code, 'log phải in mã khởi tạo');
      const c = client();
      assert.equal((await c('GET', '/login')).location, 'setup');
      assert.equal((await c('GET', '/setup')).status, 200);
      assert.equal((await c('POST', '/api/login', { username: 'chu.du.an', password: 'KhoiTao2026' })).status, 401);
      assert.equal((await c('POST', '/api/setup', { code: 'SAI0-SAI0', username: 'admin', password: 'MoiTinh2026' })).status, 400);
      assert.equal((await c('POST', '/api/setup', { code: code.toLowerCase(), username: 'Admin', name: 'Quản trị', password: 'MoiTinh2026' })).status, 200);
      assert.equal((await c('GET', '/api/me')).json.username, 'admin');
      const d = (await c('GET', '/api/data')).json;
      assert.ok(!d.transactions.some(t => t.note === 'smoke'), 'giao dịch cũ phải bị xóa');
      assert.equal((await client()('POST', '/api/setup', { code, username: 'ke.gian', password: 'KeGian2026' })).status, 409);
      assert.equal((await c('GET', '/setup')).location, 'login');
    } finally { await stop(srv); }
    srv = await start({ ...blank, FACTORY_RESET: 'lan-1' });
    try {
      assert.match(srv.log, /đã chạy lúc/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'MoiTinh2026' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['FACTORY_RESET không chạy ở production', async () => {
    const srv = await start({ APP_ENV: 'production', FACTORY_RESET: 'lan-2' });
    try {
      assert.match(srv.log, /FACTORY_RESET bị bỏ qua/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'MoiTinh2026' })).status, 200);
    } finally { await stop(srv); }
  }]
];

(async () => {
  let failed = 0;
  const run = async (name, fn) => {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.message || e)); }
  };
  try {
    const srv = await start();
    try { for (const [name, fn] of checks) await run(name, fn); } finally { await stop(srv); }
    for (const [name, fn] of restartChecks) await run(name, fn);
  } catch (e) { failed++; console.error(e.message); }
  finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  const total = checks.length + restartChecks.length;
  console.log(failed ? `\n${failed}/${total} kiểm tra thất bại` : `\nĐạt cả ${total} kiểm tra`);
  process.exit(failed ? 1 : 0);
})();
