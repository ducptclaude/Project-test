// Dữ liệu ví dụ nạp vào lần chạy đầu tiên (tắt bằng SEED_SAMPLE=false)
function makeSample() {
  let s = 20261019; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const r5 = x => Math.round(x / 1e5) * 1e5;
  const P = [
    {id:'da01', code:'DA-01', name:'Thi công nhà xưởng KCN Bình Dương', client:'Công ty TNHH Minh Phát (ví dụ)', manager:'Trần Quốc Huy', contractValue:8.5e9, budget:6.9e9, status:'active', start:'2026-01-08', end:'2026-12-20',
      costEnd:'2026-10', costTotal:5.6e9, mix:[['Vật tư',.42],['Nhân công',.26],['Thầu phụ',.18],['Thiết bị / máy móc',.09],['Vận chuyển',.05]],
      ms:[['2026-01-15',.2,'Tạm ứng hợp đồng','Tạm ứng 20% theo HĐ'],['2026-04-28',.25,'Thanh toán theo nghiệm thu','Nghiệm thu phần móng'],['2026-08-10',.25,'Thanh toán theo nghiệm thu','Nghiệm thu khung thép']]},
    {id:'da02', code:'DA-02', name:'Phần mềm quản lý kho cho chuỗi bán lẻ', client:'CTCP Thương mại Sao Việt (ví dụ)', manager:'Nguyễn Thu Hà', contractValue:2.4e9, budget:1.75e9, status:'active', start:'2026-03-02', end:'2026-11-30',
      costEnd:'2026-10', costTotal:1.32e9, mix:[['Nhân công',.78],['Bản quyền / phần mềm',.12],['Chi phí quản lý',.10]],
      ms:[['2026-03-10',.3,'Tạm ứng hợp đồng','Tạm ứng 30%'],['2026-06-30',.3,'Thanh toán theo nghiệm thu','Bàn giao giai đoạn 1'],['2026-09-25',.2,'Thanh toán theo nghiệm thu','Bàn giao giai đoạn 2'],['2026-10-05',.03,'Phát sinh ngoài hợp đồng','Tích hợp máy quét mã vạch']]},
    {id:'da03', code:'DA-03', name:'Cải tạo văn phòng trụ sở Quận 3', client:'Công ty CP Đầu tư An Khang (ví dụ)', manager:'Lê Minh Tâm', contractValue:1.2e9, budget:1.02e9, status:'done', start:'2025-11-05', end:'2026-04-30',
      costEnd:'2026-04', costTotal:1.09e9, mix:[['Vật tư',.45],['Nhân công',.3],['Thầu phụ',.17],['Vận chuyển',.08]],
      ms:[['2025-11-12',.3,'Tạm ứng hợp đồng','Tạm ứng 30%'],['2026-02-06',.4,'Thanh toán theo nghiệm thu','Nghiệm thu hoàn thiện thô'],['2026-05-15',.3,'Quyết toán','Quyết toán công trình']]},
    {id:'da04', code:'DA-04', name:'Điện mặt trời áp mái kho lạnh Long An', client:'Công ty TNHH Lạnh Phương Nam (ví dụ)', manager:'Phạm Đức Anh', contractValue:3.1e9, budget:2.6e9, status:'paused', start:'2026-06-01', end:'2027-02-28',
      costEnd:'2026-08', costTotal:1.45e9, mix:[['Thiết bị / máy móc',.62],['Nhân công',.18],['Vận chuyển',.08],['Thuế & phí',.12]],
      ms:[['2026-06-12',.15,'Tạm ứng hợp đồng','Tạm ứng 15%']]}
  ];
  const projects = [], txs = []; let n = 0;
  for (const p of P) {
    const {costEnd, costTotal, mix, ms, ...proj} = p;
    projects.push({...proj, sample: true});
    for (const [date, share, category, note] of ms)
      txs.push({id:'s' + (++n), projectId:p.id, type:'in', category, amount:r5(p.contractValue * share), date, note, sample:true});
    const months = []; let [y, m] = p.start.slice(0, 7).split('-').map(Number);
    while (`${y}-${String(m).padStart(2,'0')}` <= costEnd) { months.push(`${y}-${String(m).padStart(2,'0')}`); if (++m > 12) { m = 1; y++; } }
    for (const mo of months) for (const [category, share] of mix) {
      const day = String(3 + Math.floor(rnd() * 24)).padStart(2, '0');
      txs.push({id:'s' + (++n), projectId:p.id, type:'out', category, amount:r5(costTotal / months.length * share * (0.7 + rnd() * 0.6)), date:`${mo}-${day}`, note:'', sample:true});
    }
  }
  return {projects, txs};
}


// Dự án mẫu đầy đủ (DA-M01) cho môi trường thử: HĐ gốc + phụ lục (VAT, tạm tính, giá trị âm), khoản thu gắn hợp đồng
// và ngoài hợp đồng, khoản chi có đối tác, số hóa đơn, VAT 10% / 8% / tạm tính. Mọi id có tiền tố "mau-", mang cờ sample.
// Số liệu cố định (không ngẫu nhiên), tiền là số nguyên đồng; giao dịch có VAT thì amount (sau VAT) = pre + vat.
function makeRichSample() {
  const at = '2026-10-29T00:00:00.000Z', by = { createdBy: null, createdByName: 'Dữ liệu mẫu', updatedBy: null, updatedByName: 'Dữ liệu mẫu', updatedAt: at };
  const pid = 'mau-p1';
  const projects = [{ id: pid, code: 'DA-M01', name: 'Xây dựng trường mầm non Hoa Sen (mẫu)', client: 'Ban QLDA phường An Phú (ví dụ)', manager: 'Lê Thu Trang',
    budget: 10800000000, status: 'active', start: '2026-02-01', end: '2027-01-31', sample: true }];
  const contracts = [
    ['mau-c0', 'base', 0, '08/2026/HĐXD', '2026-01-20', 12000000000, 1200000000, 'Thi công trọn gói'],
    ['mau-c1', 'appendix', 1, '08/2026/PL01', '2026-05-15', 850000000, 85000000, 'Bổ sung hệ thống PCCC'],
    ['mau-c2', 'appendix', 2, '08/2026/PL02', '2026-09-10', -300000000, null, 'Giảm khối lượng sân vườn']
  ].map(([id, kind, seq, no, signDate, value, vat, note]) => ({ id, projectId: pid, kind, seq, no, signDate, value, vat, note, ...by, createdAt: at, sample: true }));
  const txs = [];
  const tx = (id, o) => txs.push({ id, projectId: pid, note: '', invoiceNo: '', invoiceDate: '', ...o, amount: o.pre + (o.vat || 0), ...by, createdAt: Date.parse(o.date + 'T09:00:00Z'), sample: true });
  // Khoản thu
  [['2026-02-10', 'mau-c0', 'Tạm ứng hợp đồng', '0000125', '2026-02-08', 2400000000, 240000000, 'Tạm ứng 20% giá trị HĐ'],
   ['2026-05-28', 'mau-c0', 'Thanh toán theo nghiệm thu', '0000188', '2026-05-25', 3000000000, 300000000, 'Nghiệm thu đợt 1 phần móng, khung'],
   ['2026-08-20', 'mau-c1', 'Thanh toán theo nghiệm thu', '0000231', '2026-08-18', 850000000, 85000000, 'Nghiệm thu hạng mục PCCC (PL01)'],
   ['2026-09-30', '', 'Phát sinh ngoài hợp đồng', '0000247', '2026-09-28', 120000000, 12000000, 'Sửa chữa cổng phụ theo yêu cầu CĐT'],
   ['2026-10-15', 'mau-c0', 'Thanh toán theo nghiệm thu', '', '', 1650000000, null, 'Thanh toán đợt 3, chờ hóa đơn']
  ].forEach(([date, contractId, category, invoiceNo, invoiceDate, pre, vat, note], i) =>
    tx('mau-t' + (i + 1), { type: 'in', date, contractId, category, invoiceNo, invoiceDate, pre, vat, note }));
  // Khoản chi theo tháng 02–10/2026; số tiền tính theo đơn vị 100.000 đồng
  const M = [2, 3, 4, 5, 6, 7, 8, 9, 10], mm = m => String(m).padStart(2, '0'), u = 100000;
  const vt = [2815, 3182, 3624, 4198, 5513, 4026, 3791, 3617, 3305];
  const nc = [1500, 1700, 1900, 2100, 2200, 2300, 2200, 2100, 2000];
  const tp = { 4: 1500, 5: 1900, 6: 2300, 7: 2600, 8: 2500, 9: 2300, 10: 2100 };
  const tb = { 2: 1400, 3: 1200, 6: 1300, 7: 1100 };
  const vc = { 3: 450, 5: 550, 8: 500, 10: 480 };
  const VT_NOTE = ['Xi măng, cát, đá đợt 1', 'Thép móng đợt 1', 'Thép hình khung đợt 1', 'Thép hình khung đợt 2', 'Gạch, xi măng xây tường', 'Thép sàn tầng 2', 'Vật tư hoàn thiện đợt 1', 'Gạch ốp lát, sơn', 'Vật tư hoàn thiện đợt 2'];
  let n = 0, inv = 400;
  const out = (date, category, partner, preU, rate, note, invPrefix) => {
    const pre = preU * u, vat = rate == null ? null : Math.round(pre * rate);
    tx('mau-x' + (++n), { type: 'out', date, category, partner, pre, vat, note,
      invoiceNo: rate == null ? '' : invPrefix + String(++inv).padStart(7, '0'), invoiceDate: rate == null ? '' : date });
  };
  M.forEach((m, i) => {
    const d = day => `2026-${mm(m)}-${mm(day)}`;
    out(d(5), 'Vật tư', m % 2 ? 'Công ty TNHH Thép Việt Hưng (ví dụ)' : 'Công ty CP VLXD Bình An (ví dụ)', vt[i], 0.1, VT_NOTE[i], '');
    if (tb[m]) out(d(10), 'Thiết bị / máy móc', 'Cho thuê máy xây dựng Nam Long (ví dụ)', tb[m], 0.1, `Thuê máy đào, cần cẩu tháng ${m}`, 'NL');
    if (vc[m]) out(d(12), 'Vận chuyển', 'Vận tải Minh Khang (ví dụ)', vc[m], 0.08, `Vận chuyển vật tư tháng ${m}`, 'MK');
    if (tp[m]) out(d(18), 'Thầu phụ', 'Công ty CP Điện nước Phú Thành (ví dụ)', tp[m], 0.08, `Thi công điện nước đợt ${m - 3}`, 'PT');
    out(d(28), 'Nhân công', 'Tổ đội thi công anh Bảy (ví dụ)', nc[i], null, `Lương tổ nề tháng ${m}`, '');
  });
  return { projects, contracts, txs };
}

module.exports = makeSample;
module.exports.rich = makeRichSample;
