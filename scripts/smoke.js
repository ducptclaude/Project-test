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

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  let failed = 0;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
      if (i > 50) throw new Error('Máy chủ không khởi động được:\n' + log);
      await new Promise(r => setTimeout(r, 100));
    }
    for (const [name, fn] of checks) {
      try { await fn(); console.log('  ✓ ' + name); }
      catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.message || e)); }
    }
  } catch (e) { failed++; console.error(e.message); }
  finally { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
  console.log(failed ? `\n${failed}/${checks.length} kiểm tra thất bại` : `\nĐạt cả ${checks.length} kiểm tra`);
  process.exit(failed ? 1 : 0);
})();
