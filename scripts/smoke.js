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
const env = { ...process.env, PORT, DATA_DIR: dataDir, RESET_FILE: path.join(dataDir, 'khong-co.json'), SESSION_SECRET: 'smoke', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Admin12345', APP_ENV: 'test' };
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
  const tx = { projectId: 'da01', type: 'in', date: '2026-10-01', amount: 1000000, category: 'Thu khác', note: 'smoke', contractId: '' };
  const v = client(); await v('POST', '/api/login', { username: 'xem', password: 'Xem123456' });
  assert.equal((await v('PUT', '/api/transactions/smoke1', tx)).status, 403);
  assert.equal((await v('GET', '/api/users')).status, 403);
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  assert.equal((await e('PUT', '/api/transactions/smoke1', tx)).status, 200);
  assert.equal((await e('PUT', '/api/transactions/smoke2', { ...tx, amount: -5 })).status, 400);
  assert.equal((await e('GET', '/api/users')).status, 403);
  assert.equal((await v('DELETE', '/api/transactions/smoke1')).status, 403, 'Chỉ xem không xóa được');
});
check('giao dịch: máy chủ ghi người nhập / người sửa, không đổi được loại thu/chi', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  const tx = { projectId: 'da01', type: 'out', date: '2026-10-05', amount: 3000000, category: 'Vật tư', note: 'ghi người nhập',
    createdBy: 'ke-gian', createdByName: 'Giả mạo', createdAt: 1, updatedBy: 'ke-gian', updatedByName: 'Giả mạo', updatedAt: 'x' };
  let r = await e('PUT', '/api/transactions/nn1', tx);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.createdBy, r.json.createdByName, r.json.updatedBy, r.json.updatedByName], ['nhap', 'Nhập', 'nhap', 'Nhập']);
  assert.ok(r.json.createdAt > 1e12, 'thời điểm tạo do máy chủ ghi'); const createdAt = r.json.createdAt;
  // sửa: giữ người tạo, cập nhật người sửa
  r = await a('PUT', '/api/transactions/nn1', { ...tx, amount: 3500000, createdBy: 'admin', createdByName: 'Đổi tên' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.createdBy, r.json.createdByName, r.json.createdAt, r.json.updatedBy, r.json.updatedByName], ['nhap', 'Nhập', createdAt, 'admin', 'Quản trị viên']);
  // đổi loại khi sửa: chặn; tạo mới loại nào cũng được
  r = await a('PUT', '/api/transactions/nn1', { ...tx, type: 'in' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Không đổi được loại thu/chi của khoản đã ghi.');
  const t = (await a('GET', '/api/data')).json.transactions.find(x => x.id === 'nn1');
  assert.deepEqual([t.type, t.amount, t.createdByName, t.updatedByName], ['out', 3500000, 'Nhập', 'Quản trị viên']);
  assert.equal((await a('PUT', '/api/transactions/nn2', { ...tx, type: 'in', category: 'Thu khác', contractId: '' })).status, 200);
  // giao dịch cũ chưa có người nhập: sửa không bịa người tạo
  const old = (await a('GET', '/api/data')).json.transactions.find(x => x.sample && x.projectId === 'da01');
  const { id: oid, ...od } = old;
  r = await a('PUT', '/api/transactions/' + oid, { ...od, contractId: '' });
  assert.equal(r.status, 200); assert.equal(r.json.createdBy, undefined); assert.equal(r.json.createdByName, undefined); assert.equal(r.json.updatedBy, 'admin');
});
check('thu/chi có VAT, khoản thu gắn hợp đồng, khoản chi có đối tác', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const d0 = (await a('GET', '/api/data')).json;
  const hd01 = d0.contracts.find(c => c.projectId === 'da01').id, hd02 = d0.contracts.find(c => c.projectId === 'da02').id;
  const thu = { projectId: 'da01', type: 'in', date: '2026-10-10', category: 'Thanh toán theo nghiệm thu', note: '', invoiceNo: 'HĐ0001234', invoiceDate: '2026-10-08' };
  // sau VAT + VAT → máy chủ tự tính trước VAT
  let r = await a('PUT', '/api/transactions/v1', { ...thu, amount: 110000000, vat: 10000000, contractId: hd01 });
  assert.equal(r.status, 200); assert.deepEqual([r.json.pre, r.json.vat, r.json.amount, r.json.contractId], [100000000, 10000000, 110000000, hd01]);
  assert.deepEqual([r.json.invoiceNo, r.json.invoiceDate], ['HĐ0001234', '2026-10-08']);
  r = await a('PUT', '/api/transactions/v2', { ...thu, pre: 100000000, vat: 8000000, amount: 110000000, contractId: hd01 });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Trước VAT + VAT phải bằng Sau VAT.');
  // VAT trống = tạm tính: trước VAT = sau VAT
  r = await a('PUT', '/api/transactions/v3', { ...thu, pre: 50000000, vat: null, amount: 50000000, contractId: '' });
  assert.equal(r.status, 200); assert.equal(r.json.vat, null); assert.equal(r.json.pre, 50000000);
  assert.equal((await a('PUT', '/api/transactions/v4', { ...thu, pre: 50000000, vat: null, amount: 55000000, contractId: '' })).status, 400);
  assert.equal((await a('PUT', '/api/transactions/v4', { ...thu, amount: 1000, vat: -5, contractId: '' })).status, 400, 'VAT âm');
  assert.equal((await a('PUT', '/api/transactions/v4', { ...thu, amount: 1000, vat: 1.5, contractId: '' })).status, 400, 'VAT lẻ');
  assert.equal((await a('PUT', '/api/transactions/v4', { ...thu, amount: 1000, invoiceDate: '8/10/2026', contractId: '' })).status, 400, 'ngày hóa đơn sai');
  // khoản thu trên dự án có hợp đồng: phải chọn hợp đồng của đúng dự án, hoặc ngoài hợp đồng
  r = await a('PUT', '/api/transactions/v4', { ...thu, amount: 1000 });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Chọn hợp đồng hoặc Ngoài hợp đồng.');
  r = await a('PUT', '/api/transactions/v4', { ...thu, amount: 1000, contractId: hd02 });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Hợp đồng không thuộc dự án này.');
  assert.ok(!(await a('GET', '/api/data')).json.transactions.some(t => t.id === 'v4' || t.id === 'v2'));
  // khoản chi: lưu đối tác, bỏ contractId
  r = await a('PUT', '/api/transactions/v5', { projectId: 'da01', type: 'out', date: '2026-10-11', category: 'Vật tư', amount: 22000000, vat: 2000000, partner: 'Công ty Thép Miền Nam', contractId: hd01, note: '' });
  assert.equal(r.status, 200); assert.equal(r.json.partner, 'Công ty Thép Miền Nam'); assert.equal(r.json.contractId, undefined); assert.equal(r.json.pre, 20000000);
  assert.equal((await a('PUT', '/api/transactions/v6', { projectId: 'da01', type: 'out', date: '2026-10-11', category: 'Vật tư', amount: 1000, partner: 'x'.repeat(121) })).status, 400);
  // giao dịch cũ (chỉ có amount) vẫn đọc / sửa được, không bịa VAT
  const old = d0.transactions.find(t => t.type === 'out' && t.sample && t.pre === undefined);
  const { id: oid, ...od } = old;
  r = await a('PUT', '/api/transactions/' + oid, { ...od, note: 'sửa giao dịch cũ' });
  assert.equal(r.status, 200); assert.equal(r.json.pre, undefined); assert.equal(r.json.vat, undefined); assert.equal(r.json.amount, old.amount);
  // không xóa hợp đồng còn khoản thu gắn vào, dù đúng mã
  r = await a('DELETE', '/api/contracts/' + hd01, { passcode: 'Ma2026' });
  assert.equal(r.status, 409); assert.match(r.json.error, /Hợp đồng còn 1 khoản thu gắn vào/);
});
const MA = { passcode: 'Ma2026' };
check('mã xóa áp dụng cho mọi thao tác xóa: giao dịch, dự án, dữ liệu ví dụ, tài khoản', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  assert.equal((await a('PUT', '/api/projects/mx-p', { name: 'Dự án để xóa' })).status, 204);
  assert.equal((await a('POST', '/api/users', { username: 'tam', name: 'Tạm', role: 'editor', password: 'Tam123456' })).status, 201);
  assert.equal((await a('PUT', '/api/acceptances/mx-a', { projectId: 'da01', kind: 'nghiemthu', date: '2026-10-01', value: 1000000, vat: null })).status, 200);
  const before = (await a('GET', '/api/data')).json;
  // chưa đặt mã: mọi đường xóa trả 409, không xóa gì
  for (const [c, url] of [[e, '/api/transactions/smoke1'], [e, '/api/projects/mx-p'], [e, '/api/sample'], [a, '/api/users/tam'], [a, '/api/acceptances/mx-a']]) {
    const r = await c('DELETE', url, MA);
    assert.equal(r.status, 409, url); assert.equal(r.json.error, 'Quản trị viên chưa đặt mã xóa.', url);
  }
  let d = (await a('GET', '/api/data')).json;
  assert.equal(d.transactions.length, before.transactions.length); assert.equal(d.projects.length, before.projects.length);
  assert.ok((await a('GET', '/api/users')).json.some(u => u.username === 'tam'));
  // chỉ quản trị viên đặt mã; mã 4–12 ký tự; không lộ mã băm
  assert.equal((await e('PUT', '/api/delete-passcode', MA)).status, 403);
  assert.equal((await e('GET', '/api/delete-passcode')).status, 403);
  assert.equal((await a('PUT', '/api/delete-passcode', { passcode: 'abc' })).status, 400);
  assert.equal((await a('PUT', '/api/delete-passcode', { passcode: 'qua-dai-hon-12' })).status, 400);
  assert.equal((await a('PUT', '/api/delete-passcode', MA)).status, 204);
  const g = await a('GET', '/api/delete-passcode');
  assert.equal(g.json.set, true); assert.ok(!JSON.stringify(g.json).includes('scrypt'), 'không lộ mã băm');
  // sai mã hoặc thiếu mã: 403, dữ liệu còn nguyên
  for (const [c, url] of [[e, '/api/transactions/smoke1'], [e, '/api/projects/mx-p'], [e, '/api/sample'], [a, '/api/users/tam'], [a, '/api/acceptances/mx-a']]) {
    const r = await c('DELETE', url, { passcode: 'sai-ma' });
    assert.equal(r.status, 403, url); assert.equal(r.json.error, 'Mã xóa không đúng.');
  }
  assert.equal((await a('DELETE', '/api/users/tam')).status, 403, 'thiếu mã');
  d = (await a('GET', '/api/data')).json;
  assert.ok(d.transactions.some(t => t.id === 'smoke1') && d.projects.some(p => p.id === 'mx-p') && d.transactions.some(t => t.sample));
  assert.ok((await a('GET', '/api/users')).json.some(u => u.username === 'tam'));
  // đúng mã: xóa được
  assert.equal((await e('DELETE', '/api/transactions/smoke1', MA)).status, 204);
  assert.equal((await e('DELETE', '/api/projects/mx-p', MA)).status, 204);
  assert.equal((await a('DELETE', '/api/users/tam', MA)).status, 204);
  assert.ok((await a('GET', '/api/data')).json.acceptances.some(x => x.id === 'mx-a'), 'biên bản còn sau khi sai mã');
  assert.equal((await a('DELETE', '/api/acceptances/mx-a', MA)).status, 204);
  d = (await a('GET', '/api/data')).json;
  assert.ok(!d.acceptances.some(x => x.id === 'mx-a'));
  assert.ok(!d.transactions.some(t => t.id === 'smoke1') && !d.projects.some(p => p.id === 'mx-p'));
  assert.ok(!(await a('GET', '/api/users')).json.some(u => u.username === 'tam'));
  // vẫn giữ các chặn khác dù đúng mã
  assert.equal((await a('DELETE', '/api/users/admin', MA)).status, 400, 'không tự xóa mình');
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
check('tiền phải là số nguyên đồng: số lẻ bị từ chối', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const tx = { projectId: 'da01', type: 'in', date: '2026-10-01', amount: 12.5, category: 'Thu khác', note: 'lẻ' };
  assert.equal((await a('PUT', '/api/transactions/le1', tx)).status, 400);
  assert.equal((await a('PUT', '/api/transactions/le1', { ...tx, amount: '1000' })).status, 400);
  assert.equal((await a('PUT', '/api/projects/le-p', { name: 'Lẻ', contractValue: 1.5 })).status, 400);
  assert.equal((await a('PUT', '/api/projects/le-p', { name: 'Lẻ', budget: -1 })).status, 400);
  assert.equal((await a('PUT', '/api/projects/trong', { name: 'Chưa có giá trị hợp đồng' })).status, 204);
  assert.ok(!(await a('GET', '/api/data')).json.transactions.some(t => t.id === 'le1'));
});
check('giao dịch phải thuộc dự án đang tồn tại', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const r = await a('PUT', '/api/transactions/mo-coi', { projectId: 'khong-co', type: 'out', date: '2026-10-01', amount: 1000, category: 'Khác', note: '' });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Dự án không tồn tại.');
  assert.ok(!(await a('GET', '/api/data')).json.transactions.some(t => t.id === 'mo-coi'));
});
check('không xóa được dự án còn giao dịch, dữ liệu còn nguyên', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const before = (await a('GET', '/api/data')).json, n = before.transactions.filter(t => t.projectId === 'da02').length;
  assert.ok(n > 0);
  const r = await a('DELETE', '/api/projects/da02', MA);
  assert.equal(r.status, 409, 'ràng buộc dữ liệu vẫn chặn dù mã đúng'); assert.match(r.json.error, new RegExp(`Dự án còn ${n} giao dịch`));
  const after = (await a('GET', '/api/data')).json;
  assert.ok(after.projects.some(p => p.id === 'da02'));
  assert.equal(after.transactions.length, before.transactions.length);
  assert.equal((await a('DELETE', '/api/projects/trong', MA)).status, 204, 'dự án không có giao dịch thì xóa được');
});
check('chuyển dữ liệu cũ: mỗi dự án ví dụ có đúng một HĐ gốc VAT tạm tính', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const d = (await a('GET', '/api/data')).json;
  for (const p of d.projects.filter(p => p.sample && !p.id.startsWith('mau-'))) {
    const cs = d.contracts.filter(c => c.projectId === p.id);
    assert.equal(cs.length, 1, p.id);
    assert.equal(cs[0].kind, 'base'); assert.equal(cs[0].vat, null); assert.equal(cs[0].value, p.contractValue);
    assert.equal(cs[0].createdByName, 'Chuyển từ dữ liệu cũ');
    assert.ok(p.contractValue > 0, 'giữ nguyên contractValue cũ');
  }
});
// Kiểm tra nội dung dự án mẫu DA-M01 (dùng cho cả lần chạy đầu và sampleToken)
function checkRich(d) {
  const p = d.projects.find(x => x.id === 'mau-p1');
  assert.ok(p, 'phải có dự án mẫu DA-M01'); assert.equal(p.code, 'DA-M01'); assert.equal(p.sample, true); assert.equal(p.budget, 10800000000);
  const cs = d.contracts.filter(c => c.projectId === 'mau-p1').sort((a, b) => a.seq - b.seq);
  assert.deepEqual(cs.map(c => [c.id, c.kind, c.seq, c.value, c.vat]), [['mau-c0', 'base', 0, 12000000000, 1200000000], ['mau-c1', 'appendix', 1, 850000000, 85000000], ['mau-c2', 'appendix', 2, -300000000, null]]);
  const txs = d.transactions.filter(t => t.projectId === 'mau-p1'), ins = txs.filter(t => t.type === 'in'), outs = txs.filter(t => t.type === 'out');
  assert.equal(ins.length, 5);
  assert.equal(ins.filter(t => t.contractId === '').length, 1, 'một khoản thu ngoài hợp đồng');
  assert.equal(ins.filter(t => t.vat == null).length, 1, 'một khoản thu VAT tạm tính');
  assert.ok(ins.every(t => t.contractId === '' || cs.some(c => c.id === t.contractId)), 'khoản thu gắn đúng hợp đồng của dự án');
  assert.ok(outs.length > 20 && outs.every(t => t.partner), 'khoản chi có đối tác');
  assert.ok(txs.every(t => t.sample && t.id.startsWith('mau-') && Number.isInteger(t.amount) && Number.isInteger(t.pre) && t.amount === t.pre + (t.vat || 0)), 'trước VAT + VAT = sau VAT');
  const chi = outs.reduce((a, t) => a + t.pre, 0);
  assert.ok(chi > 7.3e9 && chi < 7.8e9, 'tổng chi trước VAT 7,3–7,8 tỷ');
  const acc = d.acceptances.filter(x => x.projectId === 'mau-p1').sort((x, y) => x.seq - y.seq);
  assert.deepEqual(acc.map(x => [x.id, x.kind, x.seq, x.contractId, x.date, x.value, x.vat]),
    [['mau-a1', 'nghiemthu', 1, 'mau-c0', '2026-05-25', 3000000000, 300000000], ['mau-a2', 'nghiemthu', 2, 'mau-c1', '2026-08-18', 850000000, 85000000]]);
  assert.ok(!acc.some(x => x.kind === 'quyettoan'), 'dự án mẫu chưa quyết toán');
  assert.ok(cs.every(c => c.sample) && acc.every(x => x.sample) && [...cs, ...acc, ...txs].every(x => x.createdByName === 'Dữ liệu mẫu'));
}
check('lần chạy đầu (môi trường thử) có dự án mẫu đầy đủ DA-M01', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  checkRich((await a('GET', '/api/data')).json);
});
check('hợp đồng: HĐ gốc + phụ lục, máy chủ cấp số thứ tự và người nhập', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  assert.equal((await a('PUT', '/api/projects/hd-p', { name: 'Dự án có hợp đồng', code: 'HD-01', budget: 0 })).status, 204);
  let r = await a('PUT', '/api/contracts/hd1', { projectId: 'hd-p', kind: 'base', no: '01/2026/HĐ', signDate: '2026-01-05', value: 1000000000, vat: 100000000, note: '', seq: 9, createdBy: 'ke-gian', createdByName: 'Giả mạo' });
  assert.equal(r.status, 200); assert.equal(r.json.seq, 0); assert.equal(r.json.createdBy, 'admin'); assert.equal(r.json.createdByName, 'Quản trị viên');
  r = await e('PUT', '/api/contracts/hd2', { projectId: 'hd-p', kind: 'appendix', no: 'PL01', value: 200000000, vat: null });
  assert.equal(r.status, 200); assert.equal(r.json.seq, 1); assert.equal(r.json.createdByName, 'Nhập'); assert.equal(r.json.vat, null);
  r = await e('PUT', '/api/contracts/hd3', { projectId: 'hd-p', kind: 'appendix', no: 'PL02', value: -50000000, vat: -5000000, note: 'giảm khối lượng' });
  assert.equal(r.status, 200); assert.equal(r.json.seq, 2);
  // sửa: giữ dự án, loại, số thứ tự, người tạo; cập nhật người sửa
  r = await a('PUT', '/api/contracts/hd2', { projectId: 'da01', kind: 'base', value: 250000000, vat: 25000000 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.projectId, r.json.kind, r.json.seq, r.json.createdByName, r.json.updatedByName], ['hd-p', 'appendix', 1, 'Nhập', 'Quản trị viên']);
  const cs = (await a('GET', '/api/data')).json.contracts.filter(c => c.projectId === 'hd-p');
  assert.equal(cs.length, 3);
  assert.equal(cs.reduce((s, c) => s + c.value, 0), 1200000000);
  assert.equal(cs.reduce((s, c) => s + (c.vat || 0), 0), 120000000);
});
check('hợp đồng: máy chủ chặn dữ liệu sai', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const put = (id, b) => a('PUT', '/api/contracts/' + id, b);
  assert.equal((await put('x1', { projectId: 'hd-p', kind: 'base', value: 5000000 })).status, 400, 'HĐ gốc thứ hai');
  assert.equal((await put('x2', { projectId: 'khong-co', kind: 'base', value: 5000000 })).json.error, 'Dự án không tồn tại.');
  assert.equal((await put('x3', { projectId: 'hd-p', kind: 'appendix', value: 12.5 })).status, 400, 'giá trị lẻ');
  assert.equal((await put('x4', { projectId: 'hd-p', kind: 'appendix', value: 0 })).status, 400, 'phụ lục bằng 0');
  assert.equal((await put('x5', { projectId: 'hd-p', kind: 'appendix', value: 1000, vat: 1.5 })).status, 400, 'VAT lẻ');
  assert.equal((await put('x6', { projectId: 'hd-p', kind: 'khac', value: 1000 })).status, 400, 'loại sai');
  assert.equal((await a('PUT', '/api/projects/hd-q', { name: 'Chưa có HĐ gốc' })).status, 204);
  assert.equal((await put('x7', { projectId: 'hd-q', kind: 'base', value: -1000 })).status, 400, 'HĐ gốc âm');
  assert.equal((await put('x8', { projectId: 'hd-q', kind: 'appendix', value: 1000 })).status, 400, 'phụ lục khi chưa có HĐ gốc');
  assert.equal((await a('PUT', '/api/contracts/x9', null)).status, 400);
  const ids = (await a('GET', '/api/data')).json.contracts.map(c => c.id);
  assert.ok(!ids.some(id => /^x\d$/.test(id)));
});
check('xóa dòng hợp đồng phải nhập mã xóa', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const e = client(); await e('POST', '/api/login', { username: 'nhap', password: 'Nhap12345' });
  assert.equal((await a('POST', '/api/users', { username: 'xem2', name: 'Xem 2', role: 'viewer', password: 'Xem123456' })).status, 201);
  const v = client(); await v('POST', '/api/login', { username: 'xem2', password: 'Xem123456' });
  assert.equal((await a('DELETE', '/api/contracts/hd1', { passcode: 'gi-cung-duoc' })).status, 409, 'HĐ gốc còn phụ lục');
  let r = await e('DELETE', '/api/contracts/hd3', { passcode: 'sai-ma' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'Mã xóa không đúng.');
  assert.equal((await v('DELETE', '/api/contracts/hd3', { passcode: 'Ma2026' })).status, 403, 'Chỉ xem không xóa được');
  assert.ok((await a('GET', '/api/data')).json.contracts.some(c => c.id === 'hd3'), 'còn nguyên sau khi bị từ chối');
  assert.equal((await e('DELETE', '/api/contracts/hd3', { passcode: 'Ma2026' })).status, 204);
  assert.ok(!(await a('GET', '/api/data')).json.contracts.some(c => c.id === 'hd3'));
  // chặn dò mã: sai 5 lần thì tạm khóa, kể cả nhập đúng
  for (let i = 0; i < 5; i++) assert.equal((await e('DELETE', '/api/contracts/hd2', { passcode: 'doan' + i })).status, 403);
  assert.equal((await e('DELETE', '/api/contracts/hd2', { passcode: 'Ma2026' })).status, 429);
  assert.ok((await a('GET', '/api/data')).json.contracts.some(c => c.id === 'hd2'));
});
check('không xóa được dự án còn hợp đồng', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const r = await a('DELETE', '/api/projects/hd-p', MA);
  assert.equal(r.status, 409); assert.match(r.json.error, /2 dòng hợp đồng/);
  assert.ok((await a('GET', '/api/data')).json.projects.some(p => p.id === 'hd-p'));
  assert.equal((await a('DELETE', '/api/projects/hd-q', MA)).status, 204);
});
check('nghiệm thu, quyết toán: máy chủ cấp đợt, chặn sai, ràng buộc khi xóa', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const v = client(); await v('POST', '/api/login', { username: 'xem2', password: 'Xem123456' });
  const put = (id, b, c = a) => c('PUT', '/api/acceptances/' + id, b);
  const nt = { projectId: 'hd-p', kind: 'nghiemthu', no: 'BB-01', date: '2026-06-01', value: 400000000, vat: 40000000, note: '', createdBy: 'ke-gian', createdByName: 'Giả mạo', seq: 9 };
  let r = await put('nt1', { ...nt, contractId: 'hd1' });
  assert.equal(r.status, 200); assert.deepEqual([r.json.seq, r.json.contractId, r.json.createdBy, r.json.createdByName], [1, 'hd1', 'admin', 'Quản trị viên']);
  r = await put('nt2', { ...nt, no: 'BB-02', contractId: 'hd2', vat: null });
  assert.equal(r.status, 200); assert.equal(r.json.seq, 2); assert.equal(r.json.vat, null);
  assert.equal((await put('nt1', { ...nt, contractId: 'hd1', value: 450000000 })).json.seq, 1, 'sửa giữ số đợt');
  assert.equal((await put('x', nt, v)).status, 403, 'Chỉ xem không ghi được');
  const hdDa01 = (await a('GET', '/api/data')).json.contracts.find(c => c.projectId === 'da01').id;
  r = await put('x1', { ...nt, contractId: hdDa01 });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Hợp đồng không thuộc dự án này.');
  assert.equal((await put('x2', { ...nt, value: 12.5 })).status, 400, 'giá trị lẻ');
  assert.equal((await put('x3', { ...nt, value: 0 })).status, 400, 'giá trị 0');
  assert.equal((await put('x4', { ...nt, date: '' })).status, 400, 'thiếu ngày');
  assert.equal((await put('x5', { ...nt, vat: -1 })).status, 400, 'VAT âm');
  assert.equal((await put('x6', { ...nt, kind: 'khac' })).status, 400, 'loại sai');
  assert.equal((await put('x7', { ...nt, projectId: 'khong-co' })).status, 400, 'dự án không tồn tại');
  // quyết toán: cần HĐ gốc; tối đa một quyết toán mỗi dự án; không đổi loại khi sửa
  assert.equal((await a('PUT', '/api/projects/qt-x', { name: 'Chưa có hợp đồng' })).status, 204);
  r = await put('q0', { projectId: 'qt-x', kind: 'quyettoan', date: '2026-10-01', value: 1000 });
  assert.equal(r.status, 400); assert.match(r.json.error, /chưa có hợp đồng gốc/);
  r = await put('q1', { projectId: 'hd-p', kind: 'quyettoan', no: 'QT-01', date: '2026-10-20', value: 1150000000, vat: 115000000 });
  assert.equal(r.status, 200); assert.equal(r.json.seq, 0);
  r = await put('q2', { projectId: 'hd-p', kind: 'quyettoan', date: '2026-10-21', value: 1000 });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'Dự án đã có quyết toán.');
  assert.equal((await put('q1', { kind: 'nghiemthu', date: '2026-10-20', value: 1000 })).status, 400, 'đổi loại khi sửa');
  assert.equal((await put('nt1', { ...nt, projectId: 'da01' })).status, 400, 'đổi dự án khi sửa');
  const ids = (await a('GET', '/api/data')).json.acceptances.map(x => x.id);
  assert.ok(['nt1', 'nt2', 'q1'].every(id => ids.includes(id)) && !ids.some(id => /^(x\d|q0|q2)$/.test(id)));
  // ràng buộc xóa, kể cả khi đúng mã
  r = await a('DELETE', '/api/contracts/hd2', MA);
  assert.equal(r.status, 409); assert.match(r.json.error, /đợt nghiệm thu gắn vào/);
  assert.equal((await a('DELETE', '/api/projects/hd-p', MA)).status, 409, 'dự án còn nghiệm thu / quyết toán');
  assert.equal((await a('DELETE', '/api/projects/qt-x', MA)).status, 204);
  const base04 = (await a('GET', '/api/data')).json.contracts.find(c => c.projectId === 'da04' && c.kind === 'base').id;
  assert.equal((await put('q4', { projectId: 'da04', kind: 'quyettoan', date: '2026-10-01', value: 3000000000, vat: null })).status, 200);
  r = await a('DELETE', '/api/contracts/' + base04, MA);
  assert.equal(r.status, 409); assert.match(r.json.error, /đã quyết toán/);
  // xóa biên bản: Chỉ xem 403, sai mã 403, đúng mã 204
  assert.equal((await v('DELETE', '/api/acceptances/q4', MA)).status, 403);
  assert.equal((await a('DELETE', '/api/acceptances/q4', { passcode: 'sai' })).status, 403);
  assert.equal((await a('DELETE', '/api/acceptances/q4', MA)).status, 204);
  // tiền về vượt hợp đồng: chỉ cảnh báo ở giao diện, máy chủ vẫn nhận
  assert.equal((await a('PUT', '/api/transactions/vuot1', { projectId: 'hd-p', type: 'in', date: '2026-10-25', category: 'Quyết toán', amount: 9000000000, vat: null, contractId: 'hd1' })).status, 200);
});
check('sửa giao dịch / dự án ví dụ thì không còn là dữ liệu ví dụ', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  const d = (await a('GET', '/api/data')).json;
  const t = d.transactions.find(t => t.sample && t.projectId === 'da03');
  const { id, ...tx } = t;
  assert.equal((await a('PUT', '/api/transactions/' + id, { ...tx, contractId: '', note: 'người dùng đã sửa', sample: true })).status, 200);
  const { id: pid, ...pr } = d.projects.find(p => p.id === 'da04');
  assert.equal((await a('PUT', '/api/projects/da04', { ...pr, name: 'Điện mặt trời (đã sửa)', sample: true })).status, 204);
  const d2 = (await a('GET', '/api/data')).json;
  assert.equal(d2.transactions.find(x => x.id === id).sample, undefined);
  assert.equal(d2.projects.find(x => x.id === 'da04').sample, undefined);
});
check('xóa dữ liệu ví dụ giữ lại dự án ví dụ đang có giao dịch thật', async () => {
  const a = client(); await a('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
  assert.equal((await a('PUT', '/api/transactions/that1', { projectId: 'da01', type: 'out', date: '2026-10-03', amount: 2500000, category: 'Vật tư', note: 'giao dịch thật' })).status, 200);
  assert.equal((await a('PUT', '/api/projects/rieng', { name: 'Dự án riêng', code: 'R-01', contractValue: 0, budget: 0 })).status, 204);
  assert.equal((await a('DELETE', '/api/sample', MA)).status, 204);
  const d = (await a('GET', '/api/data')).json;
  assert.ok(!d.transactions.some(t => t.sample), 'giao dịch ví dụ phải bị xóa');
  assert.ok(!d.projects.some(p => p.sample), 'không còn dự án mang cờ ví dụ');
  const da01 = d.projects.find(p => p.id === 'da01');
  assert.ok(da01, 'dự án ví dụ có giao dịch thật phải được giữ'); assert.equal(da01.name, 'Thi công nhà xưởng KCN Bình Dương');
  assert.ok(d.transactions.some(t => t.id === 'that1' && t.amount === 2500000), 'giao dịch thật phải còn');
  assert.ok(!d.projects.some(p => p.id === 'da02'), 'dự án ví dụ không còn giao dịch thì bị xóa');
  assert.ok(d.projects.some(p => p.id === 'rieng'), 'dự án thật không bị đụng tới');
  assert.ok(d.transactions.some(t => t.note === 'người dùng đã sửa'), 'giao dịch ví dụ đã sửa phải còn');
  assert.ok(d.projects.some(p => p.id === 'da03'), 'dự án của giao dịch đã sửa phải còn');
  assert.ok(d.projects.some(p => p.id === 'da04' && p.name === 'Điện mặt trời (đã sửa)'), 'dự án ví dụ đã sửa phải còn');
  assert.ok(!d.contracts.some(c => c.sample), 'không còn hợp đồng mang cờ ví dụ');
  for (const p of ['da01', 'da03', 'da04']) assert.equal(d.contracts.filter(c => c.projectId === p).length, 1, 'giữ hợp đồng của dự án còn lại: ' + p);
  assert.ok(!d.contracts.some(c => c.projectId === 'da02'), 'hợp đồng của dự án ví dụ đã xóa cũng bị xóa');
  assert.equal(d.contracts.filter(c => c.projectId === 'hd-p').length, 2, 'hợp đồng thật còn nguyên');
  assert.ok(![...d.projects, ...d.contracts, ...d.acceptances, ...d.transactions].some(x => x.id.startsWith('mau-')), 'xóa hết dự án mẫu DA-M01 cùng hợp đồng, nghiệm thu và giao dịch');
  assert.ok(['nt1', 'nt2', 'q1'].every(id => d.acceptances.some(x => x.id === id)), 'biên bản thật còn nguyên');
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
  ['sampleToken: thêm dự án mẫu ở môi trường thử, một lần, không đụng dữ liệu khác; production bỏ qua', async () => {
    const file = path.join(dataDir, 'sample-token.json'), strip = d => JSON.stringify(['projects', 'contracts', 'acceptances', 'transactions'].map(k => d[k].filter(x => !x.id.startsWith('mau-')).sort((a, b) => a.id.localeCompare(b.id))));
    let srv = await start(), before;
    try {
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
      before = (await c('GET', '/api/data')).json;
      assert.ok(!before.projects.some(p => p.id === 'mau-p1'), 'đã xóa ở bước trước');
    } finally { await stop(srv); }
    fs.writeFileSync(file, JSON.stringify({ sampleToken: 'mau-test-1' }));
    srv = await start({ RESET_FILE: file });
    try {
      assert.match(srv.log, /sampleToken "mau-test-1": đã thêm dự án mẫu DA-M01/);
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
      const d = (await c('GET', '/api/data')).json;
      checkRich(d);
      assert.equal(strip(d), strip(before), 'dữ liệu khác không thay đổi');
      assert.equal((await c('DELETE', '/api/sample', { passcode: 'Ma2026' })).status, 204);
      assert.ok(!(await c('GET', '/api/data')).json.projects.some(p => p.id === 'mau-p1'));
    } finally { await stop(srv); }
    srv = await start({ RESET_FILE: file });   // cùng token: không nạp lại
    try {
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
      assert.ok(!(await c('GET', '/api/data')).json.projects.some(p => p.id === 'mau-p1'), 'token đã chạy thì không nạp lại');
    } finally { await stop(srv); }
    fs.writeFileSync(file, JSON.stringify({ sampleToken: 'mau-test-2' }));
    srv = await start({ RESET_FILE: file, APP_ENV: 'production' });
    try {
      assert.match(srv.log, /không nạp dự án mẫu ở môi trường production/);
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
      assert.ok(!(await c('GET', '/api/data')).json.projects.some(p => p.id === 'mau-p1'));
    } finally { await stop(srv); }
  }],
  ['khởi động lại không chuyển dữ liệu hợp đồng lần nữa', async () => {
    const srv = await start();
    try {
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'Admin12345' });
      const d = (await c('GET', '/api/data')).json;
      assert.equal(d.contracts.filter(x => x.projectId === 'da01').length, 1);
      assert.equal(d.contracts.filter(x => x.projectId === 'hd-p').length, 2);
    } finally { await stop(srv); }
  }],
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
      assert.match(srv.log, /đã chạy trước đó/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'MoiTinh2026' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['deploy/reset.json xóa sạch và tạo quản trị viên phải đổi mật khẩu, chỉ một lần', async () => {
    const crypto = require('crypto'), salt = crypto.randomBytes(16);
    const passHash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync('TuFile2026', salt, 64).toString('hex');
    const file = path.join(dataDir, 'reset.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'tep-1', admin: { username: 'admin', name: 'QTV', passHash } }));
    let srv = await start({ RESET_FILE: file });
    try {
      assert.match(srv.log, /đã tạo quản trị viên "admin" từ deploy\/reset.json/);
      const c = client();
      assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'MoiTinh2026' })).status, 401);
      assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'TuFile2026' })).json.mustChange, true);
      assert.equal((await c('POST', '/api/me/password', { current: 'TuFile2026', next: 'DaDoi2026' })).status, 204);
    } finally { await stop(srv); }
    srv = await start({ RESET_FILE: file });
    try {
      assert.match(srv.log, /đã chạy trước đó/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'DaDoi2026' })).status, 200);
    } finally { await stop(srv); }
  }],
  ['deploy/reset.json scope "accounts": chỉ xóa tài khoản, giữ dữ liệu', async () => {
    const crypto = require('crypto'), salt = crypto.randomBytes(16);
    const passHash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync('ChiTaiKhoan1', salt, 64).toString('hex');
    const file = path.join(dataDir, 'reset2.json');
    let srv = await start(), before;
    try {
      const c = client(); await c('POST', '/api/login', { username: 'admin', password: 'DaDoi2026' });
      assert.equal((await c('PUT', '/api/transactions/giu-lai', { projectId: 'da01', type: 'in', date: '2026-10-02', amount: 5000000, category: 'Thu khác', note: 'giữ', contractId: '' })).status, 200);
      before = (await c('GET', '/api/data')).json.transactions.length;
    } finally { await stop(srv); }
    fs.writeFileSync(file, JSON.stringify({ token: 'tk-1', scope: 'accounts', admin: { username: 'quantri', passHash } }));
    srv = await start({ RESET_FILE: file });
    try {
      assert.match(srv.log, /giữ nguyên dự án và giao dịch/);
      assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'DaDoi2026' })).status, 401);
      const c = client();
      assert.equal((await c('POST', '/api/login', { username: 'quantri', password: 'ChiTaiKhoan1' })).json.mustChange, true);
      assert.equal((await c('GET', '/api/users')).json.length, 1);
      const d = (await c('GET', '/api/data')).json;
      assert.equal(d.transactions.length, before);
      assert.ok(d.transactions.some(t => t.id === 'giu-lai'));
      assert.equal((await c('POST', '/api/me/password', { current: 'ChiTaiKhoan1', next: 'DaDoi2026' })).status, 204);
    } finally { await stop(srv); }
  }],
  ['production chưa có tài khoản: tạo quản trị viên từ tệp, không xóa dữ liệu', async () => {
    const crypto = require('crypto'), salt = crypto.randomBytes(16);
    const passHash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync('ChinhThuc26', salt, 64).toString('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-prod-')), file = path.join(dir, 'reset.json');
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ projects: { p1: { name: 'Dự án thật', code: 'X-01', contractValue: 500000000 } }, transactions: {}, meta: { seeded: { at: 'x' } } }));
    fs.writeFileSync(file, JSON.stringify({ token: 'tk-prod', scope: 'all', admin: { username: 'admin', passHash } }));
    const blank = { ADMIN_USERNAME: '', ADMIN_PASSWORD: '', APP_ENV: 'production', DATA_DIR: dir, RESET_FILE: file, DATABASE_URL: '' };
    let srv = await start(blank);
    try {
      const c = client();
      assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'ChinhThuc26' })).json.mustChange, true);
      const d = (await c('GET', '/api/data')).json;
      assert.deepEqual(d.projects.map(p => p.id), ['p1']);
      // dữ liệu cũ (có contractValue, chưa có bảng hợp đồng) được chuyển thành một HĐ gốc tạm tính, giữ contractValue
      assert.deepEqual(d.contracts.map(x => [x.projectId, x.kind, x.value, x.vat]), [['p1', 'base', 500000000, null]]);
      assert.equal(d.projects[0].contractValue, 500000000);
      assert.equal((await c('POST', '/api/me/password', { current: 'ChinhThuc26', next: 'RiengToi2026' })).status, 204);
    } finally { await stop(srv); }
    srv = await start(blank);
    try { assert.equal((await client()('POST', '/api/login', { username: 'admin', password: 'RiengToi2026' })).status, 200); }
    finally { await stop(srv); }
    // productionAccountsToken: xóa tài khoản production, giữ dữ liệu, tạo lại admin; chỉ một lần
    fs.writeFileSync(file, JSON.stringify({ token: 'tk-prod', productionAccountsToken: 'pa-1', admin: { username: 'admin', passHash } }));
    for (let i = 0; i < 2; i++) {
      srv = await start(blank);
      try {
        const c = client();
        if (i === 0) {
          assert.match(srv.log, /Production: đã xóa 1 tài khoản/);
          assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'RiengToi2026' })).status, 401);
          assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'ChinhThuc26' })).json.mustChange, true);
          assert.deepEqual((await c('GET', '/api/data')).json.projects.map(p => p.id), ['p1']);
          assert.equal((await c('POST', '/api/me/password', { current: 'ChinhThuc26', next: 'LanHai2026' })).status, 204);
        } else assert.equal((await c('POST', '/api/login', { username: 'admin', password: 'LanHai2026' })).status, 200);
      } finally { await stop(srv); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }],
  ['không có SESSION_SECRET: khởi động lại (deploy) vẫn giữ đăng nhập', async () => {
    const c = client();
    let srv = await start({ SESSION_SECRET: '' });
    try {
      assert.equal((await c('POST', '/api/login', { username: 'quantri', password: 'DaDoi2026' })).status, 200);
    } finally { await stop(srv); }
    srv = await start({ SESSION_SECRET: '' });
    try { assert.equal((await c('GET', '/api/data')).status, 200); } finally { await stop(srv); }
  }],
  ['phiên trượt: thao tác thì gia hạn, chạy ngầm không gia hạn, quá hạn thì đăng xuất', async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms)), bg = { 'X-Background': '1' };
    const srv = await start({ SESSION_IDLE_MINUTES: '0.05' });   // 3 giây
    try {
      const a = client(), b = client();
      await a('POST', '/api/login', { username: 'quantri', password: 'DaDoi2026' });
      await b('POST', '/api/login', { username: 'quantri', password: 'DaDoi2026' });
      assert.equal((await a('GET', '/api/me')).json.idleMinutes, 0.05);
      await wait(1600);
      assert.equal((await a('GET', '/api/data')).status, 200);            // thao tác: gia hạn
      assert.equal((await b('GET', '/api/data', null, bg)).status, 200);  // chạy ngầm: còn hạn nhưng không gia hạn
      await wait(2000);
      assert.equal((await a('GET', '/api/data', null, bg)).status, 200);  // đã được gia hạn ở lần trước
      assert.equal((await b('GET', '/api/data', null, bg)).status, 401);  // quá 3 giây không thao tác
    } finally { await stop(srv); }
  }],
  ['FACTORY_RESET không chạy ở production', async () => {
    const srv = await start({ APP_ENV: 'production', FACTORY_RESET: 'lan-2' });
    try {
      assert.match(srv.log, /không xóa dữ liệu ở môi trường production/);
      assert.equal((await client()('POST', '/api/login', { username: 'quantri', password: 'DaDoi2026' })).status, 200);
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
