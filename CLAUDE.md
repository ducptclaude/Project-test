# Sổ Tài Chính Dự Án

Ứng dụng web quản lý doanh thu, chi phí, lợi nhuận theo dự án. Giao diện và thông báo đều bằng tiếng Việt. Nhận diện trung tính: tên hiển thị lấy từ biến `BRAND_*`, không gắn với công ty cụ thể nào; font Montserrat, màu gradient Navy → Teal.

## Kiến trúc
- `server.js`: máy chủ Express. Lưu dữ liệu vào PostgreSQL (bảng `records(col, id, data jsonb)`) khi có `DATABASE_URL`, nếu không thì vào `DATA_DIR/db.json`. Các collection: `projects`, `transactions`, `contracts` (hợp đồng với CĐT), `acceptances` (nghiệm thu, quyết toán), `loans` (vay, trả nợ gốc) — ba collection này có đường dẫn API riêng, `users`, `meta`.
- `auth.js`: trang `/login`, phiên cookie ký HMAC, vai trò `viewer` < `editor` < `admin`, API quản lý tài khoản.
- `public/index.html`: toàn bộ giao diện ứng dụng (HTML + CSS + JS thuần trong một file).
- `public/login.html`: trang đăng nhập hai cột. Logo tùy chọn ở `public/brand/logo.png`.
- `sample.js`: dữ liệu ví dụ nạp ở lần chạy đầu; `makeSample.rich()` dựng dự án mẫu đầy đủ **DA-M01** (HĐ gốc + phụ lục có VAT / tạm tính / âm, khoản thu gắn hợp đồng và ngoài hợp đồng, khoản chi có đối tác, hóa đơn). Mọi id tiền tố `mau-`, cờ `sample` (xóa được bằng "Xóa dữ liệu ví dụ"), người nhập "Dữ liệu mẫu".
- `deploy/reset.json`: `token` / `scope` / `productionAccountsToken` (khởi tạo lại tài khoản), và `sampleToken`: token mới thì khi khởi động ở môi trường **không phải production** máy chủ **thêm / cập nhật** dự án mẫu DA-M01 đúng một lần (meta `sampleSeed`): chỉ ghi bản ghi `mau-` chưa có hoặc còn cờ `sample`; bản ghi `mau-` người dùng đã sửa (mất cờ `sample`) được **giữ nguyên**; bản mẫu trỏ tới dự án / hợp đồng không còn thì bỏ; không xóa, không đụng dữ liệu khác. Cơ sở dữ liệu mới (không phải production) cũng tự có DA-M01.
- `scripts/smoke.js`: bộ kiểm tra chạy bằng `npm test`.

## Lệnh
- `npm start`: chạy ở cổng `PORT` (mặc định 3000).
- `npm test`: kiểm tra cú pháp và chạy bộ kiểm tra luồng chính với dữ liệu tạm.

## Quy tắc chung (bắt buộc, Revi soát theo các quy tắc này)
1. **Ngôn ngữ và nghiệp vụ**: luôn trả lời, ghi chú, thông báo bằng tiếng Việt. Nghiệp vụ nào chưa rõ thì hỏi người dùng trước khi làm, không tự đoán.
2. **Tiền lưu theo đồng**: mọi số tiền lưu là số nguyên đồng (không lưu số thập phân, không lưu theo nghìn/triệu). Khi hiện đầy đủ dùng dấu chấm ngăn nghìn: `12.500.000 ₫`.
3. **Báo cáo tổng hiện theo tỷ đồng**: thẻ chỉ số, biểu đồ, bảng tổng hợp, cảnh báo hiện tiền theo đơn vị tỷ đồng (`9,25 tỷ`, `0,189 tỷ`). Bảng chi tiết từng khoản và ô nhập liệu dùng số đồng đầy đủ.
   - Mỗi khoản tiền có **trước VAT, VAT, sau VAT** (xem mục "VAT giao dịch thu/chi" và "Hợp đồng với CĐT").
4. **Bảng và dữ liệu**:
   - Mọi bảng có số tiền phải có **dòng Tổng cộng** (cả dạng thẻ trên điện thoại và tệp CSV xuất ra).
   - **Không làm mất dữ liệu**: không xóa hàng loạt ngoài ý muốn; không cho xóa bản ghi đang được bản ghi khác tham chiếu (vd. dự án còn giao dịch hoặc hợp đồng; HĐ gốc còn phụ lục). Dữ liệu ví dụ người dùng đã sửa thì không còn là dữ liệu ví dụ.
   - **Liên kết dữ liệu phải logic**: giao dịch và hợp đồng luôn thuộc một dự án đang tồn tại; máy chủ phải chặn dữ liệu sai liên kết, không chỉ giao diện.

### Hợp đồng với CĐT (người dùng đã chốt)
- Một dự án có **nhiều hợp đồng với CĐT**. Mỗi hợp đồng = **HĐ gốc** (giá trị > 0, `seq` 1..n trong dự án) + các **phụ lục** (`parentId` = HĐ gốc cùng dự án, `seq` 1..n trong từng HĐ gốc, giá trị khác 0, **được âm**) + tối đa **một quyết toán** (`acceptances` kind `quyettoan`, `contractId` = HĐ gốc). Nghiệm thu bắt buộc chọn hợp đồng (HĐ gốc hoặc phụ lục), số đợt đếm theo từng hợp đồng. Số thứ tự do máy chủ cấp; sửa không đổi được dự án / loại / HĐ gốc.
- Dữ liệu cũ chuyển một lần (meta `contractGroupsMigrated`): HĐ gốc `seq` 0 → 1; phụ lục / quyết toán / nghiệm thu chưa gắn thì gắn vào HĐ gốc duy nhất của dự án (dự án không có đúng một HĐ gốc thì để nguyên, giao diện hiện "Phụ lục chưa gắn hợp đồng").
- Giá trị nhập là **trước VAT**. **VAT nhập tay** theo hợp đồng (không tự tính theo %); để trống = **Tạm tính** (VAT coi là 0, sau VAT = trước VAT), nhập bổ sung sau. Sau VAT = trước VAT + VAT.
- **Ghi nhận doanh thu theo từng hợp đồng** (TĐ1/TĐ2/TĐ3, người dùng đã chốt): **TĐ1** giá trị HĐ gốc vào ngày ký HĐ gốc; **TĐ2** từng phụ lục vào ngày ký phụ lục; **TĐ3** phần chênh (QT − HĐ gốc − phụ lục) vào ngày quyết toán. Lũy kế đến bất kỳ ngày nào = giá trị ở giai đoạn mới nhất của hợp đồng; doanh thu dự án = tổng các hợp đồng. Còn phải thu và cảnh báo tiền về vượt tính **theo từng hợp đồng** (giữ thêm cảnh báo cấp dự án); tiền về của hợp đồng = khoản thu gắn HĐ gốc hoặc phụ lục của nó.
- Giá trị hợp đồng của dự án **tự cộng từ bảng hợp đồng** (dự án chưa có dòng nào thì dùng `contractValue` cũ). Dữ liệu cũ được chuyển một lần thành HĐ gốc tạm tính (meta `contractsMigrated`), giữ nguyên `contractValue`.
- Tiền thu theo hồ sơ quyết toán là **sau VAT** → "Tiền về / hợp đồng", "Còn phải thu" luôn so với giá trị hợp đồng (hoặc quyết toán) **sau VAT**. Lợi nhuận kế hoạch / dự báo = giá trị **trước VAT** − ngân sách.
- Nút **Trước VAT | Sau VAT** trên đầu trang (nhớ theo trình duyệt) đổi cách hiện giá trị hợp đồng và báo cáo thu/chi (xem mục VAT giao dịch).
- Người nhập / người sửa do máy chủ tự ghi theo tài khoản đăng nhập.
- **Mã xóa**: Quản trị viên đặt trong Quản lý tài khoản (4–12 ký tự, lưu băm). Mã xóa **áp dụng cho mọi thao tác xóa (giao dịch, dự án, hợp đồng, dữ liệu ví dụ, tài khoản)**: máy chủ kiểm tra mã ở mọi đường xóa, sau khi kiểm quyền và các ràng buộc dữ liệu (chưa đặt mã → 409, sai mã → 403, sai 5 lần / 15 phút theo tài khoản → 429). Khóa/mở khóa tài khoản, cấp lại mật khẩu không phải xóa nên không cần mã. Giao diện dùng chung hộp nhập mã `askPasscode` (thay cho bước bấm hai lần).
- Không xóa HĐ gốc khi còn phụ lục, nghiệm thu hoặc quyết toán; không xóa hợp đồng còn khoản thu / nghiệm thu gắn vào; không xóa dự án còn hợp đồng hoặc giao dịch.
- Làm sau: đính kèm file scan, hợp đồng phía chi (thầu phụ, nhà cung cấp).

### VAT giao dịch thu/chi (người dùng đã chốt)
- Báo cáo doanh thu, chi phí, lợi nhuận mặc định theo **trước VAT**. Nút **Trước VAT | Sau VAT** áp dụng cho mọi báo cáo thu/chi (thẻ chỉ số, biểu đồ, bảng tổng hợp, cơ cấu, trang Doanh thu/Chi phí, bảng dự án); tiêu đề ghi rõ đang xem trước hay sau VAT.
- Ngoại lệ không đổi theo nút: **ngân sách** luôn so với chi phí **trước VAT** (đã chi / ngân sách, cảnh báo vượt / sắp hết ngân sách); **Tiền về / Còn phải thu** luôn so tiền về **sau VAT** với giá trị hợp đồng (hoặc quyết toán) sau VAT. Lợi nhuận kế hoạch / dự báo theo trước VAT.
- Mỗi giao dịch có 3 ô **Trước VAT · VAT · Sau VAT**; người dùng gõ 2 ô bất kỳ (gợi ý: Sau VAT trên chứng từ + VAT theo hóa đơn), ô còn lại tự tính (sau = trước + VAT). **VAT để trống = Tạm tính** (vat = null, trước = sau), nhãn vàng "Tạm tính". VAT 0 khác VAT trống.
- Dữ liệu: `amount` = **sau VAT** (giữ tên cũ), `pre` = trước VAT, `vat` (null = tạm tính). Máy chủ kiểm tra `pre + vat = amount`. **Giao dịch cũ chỉ có `amount`**: coi là sau VAT, VAT tạm tính, trước = sau; không ghi đè dữ liệu cũ, đọc qua `txPre / txVat / txPost / txVal`.
- **Khoản thu phải chọn hợp đồng** (HĐ gốc / Phụ lục n của đúng dự án) hoặc **Ngoài hợp đồng** khi dự án đã có hợp đồng (`contractId`, '' = ngoài hợp đồng); dự án chưa có hợp đồng thì ẩn ô này. Bảng hợp đồng hiện **Tiền về (sau VAT)** từng hợp đồng (chip "Vượt" nếu vượt giá trị dòng đó). Không xóa hợp đồng còn khoản thu gắn vào.
- **Hạng mục chọn từ danh sách cố định** (`CATS`, mỗi loại có mục khác); hạng mục cũ ngoài danh sách giữ nguyên, hiện "(cũ) …" khi sửa. Quản trị chỉnh danh mục: làm sau.
- **Khoản chi có ô Đối tác** (nhà cung cấp / thầu phụ), không bắt buộc, ≤ 120 ký tự, gợi ý từ tên đã nhập.
- Thêm **Số hóa đơn / chứng từ** (≤ 60) và **Ngày hóa đơn**; `date` là ngày thu / chi tiền.

### Doanh thu và Tiền về (người dùng đã chốt)
1. **Doanh thu ghi nhận** = tổng giá trị hiện hành các hợp đồng: hợp đồng đã quyết toán thì = **giá trị quyết toán**; chưa thì = **HĐ gốc + phụ lục** (chưa có dòng hợp đồng thì dùng `contractValue` cũ). Theo nút Trước/Sau VAT (mặc định trước VAT). Dự án chưa có hợp đồng thì doanh thu = 0.
2. **Thời điểm ghi nhận** (đã chốt, xem mục Hợp đồng): theo từng hợp đồng, HĐ gốc = TĐ1 vào ngày ký, phụ lục = TĐ2 vào ngày ký (thiếu ngày ký thì ngày bắt đầu dự án, rồi ngày tạo); quyết toán ghi **phần chênh** vào **ngày quyết toán** (TĐ3). Giao diện: `revEvents()` là nguồn duy nhất cho doanh thu theo kỳ / tháng.
3. **Nghiệm thu** (`acceptances`, kind `nghiemthu`, đợt 1..n do máy chủ cấp, gắn HĐ gốc / Phụ lục n hoặc không): chỉ theo dõi khối lượng, **không đổi doanh thu**; hiện "Đã nghiệm thu x% giá trị HĐ" và "Nghiệm thu chưa thu tiền".
4. **Quyết toán** (kind `quyettoan`): **tối đa một quyết toán mỗi hợp đồng** (HĐ gốc), áp cho cả hợp đồng đó (HĐ gốc + phụ lục). Không đổi được loại / dự án / hợp đồng khi sửa.
5. **Tiền về** = các khoản thu (tạm ứng, thanh toán theo nghiệm thu, quyết toán…), là tiền thực **đã gồm VAT**: luôn **sau VAT**, không đổi theo nút, **không cộng vào doanh thu**. **Thực chi** = khoản chi sau VAT. **Còn lại = Tiền về − Thực chi** (sau VAT). Chi phí trong lợi nhuận theo nút; ngân sách so chi phí trước VAT.
6. **Lợi nhuận** = Doanh thu ghi nhận − Chi phí (cùng theo nút). Lợi nhuận kế hoạch / dự báo = HĐ (đã QT thì QT) trước VAT − ngân sách.
7. **Tiền về vượt hợp đồng**: tiền về (sau VAT) > giá trị HĐ (hoặc QT) sau VAT → dòng "TIỀN VỀ VƯỢT HỢP ĐỒNG" trong Cần chú ý, chip ở dự án; khi lưu chỉ **cảnh báo, không chặn**. Còn phải thu = max(0, HĐ hoặc QT sau VAT − Tiền về).
- Ràng buộc xóa (kiểm trước mã xóa): hợp đồng còn nghiệm thu gắn vào, HĐ gốc khi đã quyết toán, dự án còn nghiệm thu / quyết toán → 409. Xóa nghiệm thu / quyết toán cần quyền Nhập liệu trở lên và mã xóa.
- Menu "Doanh thu" đổi thành **"Tiền về"** (view vẫn tên `revenue`).
- Làm sau: gắn khoản tiền về vào từng đợt nghiệm thu.

### Chi phí 3 khối và tiền vay (người dùng đã chốt)
- Khoản chi có `group` + `category` (danh mục cố định, máy chủ kiểm tra hạng mục thuộc đúng khối, sai → 400):
  - `direct` **Chi phí trực tiếp**: Thầu phụ · Vật tư · Nhân công · MMTB · Tổ chức thi công · Khác
  - `indirect` **Chi phí gián tiếp**: Lương BCH · Điện, nước · Ngoại giao · Khác
  - `finance` **Chi phí tài chính**: Phí bảo lãnh · Phí ngân hàng · Lãi vay, phạt
  - Khoản thu không có `group`.
- Chuyển khoản chi cũ một lần (meta `costGroupsMigrated`, mọi môi trường): Thầu phụ / Vật tư / Nhân công → giữ tên (Trực tiếp); Thiết bị / máy móc → MMTB; Vận chuyển → Tổ chức thi công; Chi phí quản lý, Bản quyền / phần mềm, Thuế & phí → Gián tiếp · Khác; Chi khác, trống, lạ → Trực tiếp · Khác. Tên cũ lưu ở `oldCategory` (chỉ bước chuyển đổi ghi), không đổi người sửa / thời điểm sửa / cờ `sample`.
- Trang Chi phí dạng cây Khối → Hạng mục → Khoản chi (tổng, tỷ trọng %, Mở tất cả / Thu gọn tất cả, dòng Tổng cộng); tổng khối theo nút VAT.
- **Tiền vay / trả nợ gốc** (`loans`: `kind` vay|tragoc, ngày, số tiền nguyên đồng không VAT, bên cho vay, số khế ước): **không phải chi phí**, không vào doanh thu, lợi nhuận, Tiền về, Thực chi, Còn lại. **Dư nợ vay = vay − trả gốc** (không được âm: trả gốc vượt → 400; xóa khoản vay làm dư nợ âm → 409). **Số dư tiền = Còn lại + Dư nợ vay**. Không xóa dự án còn khoản vay. Xóa cần mã xóa.
- **Lãi vay là chi phí**: nhập như khoản chi ở Tài chính → "Lãi vay, phạt".

## Môi trường và nhánh
- `main` → Railway **production** (số liệu thật). `staging` → Railway **staging** (dữ liệu thử).
- Mọi thay đổi vào `staging` trước; người dùng gộp vào `main` qua Pull Request sau khi kiểm tra.

## Hai agent của dự án
- `revi`: lập kế hoạch trước khi code; review, chạy kiểm tra sau khi code. Không sửa file.
- `dev`: viết code trên `staging`, chạy `npm test`, commit và push `staging`.
- Quy trình: `revi` (kế hoạch) → `dev` (làm) → `revi` (review) → `dev` (sửa nếu cần) → người dùng gộp vào `main`.
