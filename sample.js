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


module.exports = makeSample;
