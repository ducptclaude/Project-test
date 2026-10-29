# Sổ Tài Chính Dự Án

Ứng dụng web quản lý doanh thu, chi phí, lợi nhuận theo dự án. Giao diện và thông báo đều bằng tiếng Việt. Nhận diện trung tính: tên hiển thị lấy từ biến `BRAND_*`, không gắn với công ty cụ thể nào; font Montserrat, màu gradient Navy → Teal.

## Kiến trúc
- `server.js`: máy chủ Express. Lưu dữ liệu vào PostgreSQL (bảng `records(col, id, data jsonb)`) khi có `DATABASE_URL`, nếu không thì vào `DATA_DIR/db.json`. Các collection: `projects`, `transactions`, `contracts` (hợp đồng với CĐT, có đường dẫn API riêng), `users`, `meta`.
- `auth.js`: trang `/login`, phiên cookie ký HMAC, vai trò `viewer` < `editor` < `admin`, API quản lý tài khoản.
- `public/index.html`: toàn bộ giao diện ứng dụng (HTML + CSS + JS thuần trong một file).
- `public/login.html`: trang đăng nhập hai cột. Logo tùy chọn ở `public/brand/logo.png`.
- `sample.js`: dữ liệu ví dụ nạp ở lần chạy đầu.
- `scripts/smoke.js`: bộ kiểm tra chạy bằng `npm test`.

## Lệnh
- `npm start`: chạy ở cổng `PORT` (mặc định 3000).
- `npm test`: kiểm tra cú pháp và chạy bộ kiểm tra luồng chính với dữ liệu tạm.

## Quy tắc chung (bắt buộc, Revi soát theo các quy tắc này)
1. **Ngôn ngữ và nghiệp vụ**: luôn trả lời, ghi chú, thông báo bằng tiếng Việt. Nghiệp vụ nào chưa rõ thì hỏi người dùng trước khi làm, không tự đoán.
2. **Tiền lưu theo đồng**: mọi số tiền lưu là số nguyên đồng (không lưu số thập phân, không lưu theo nghìn/triệu). Khi hiện đầy đủ dùng dấu chấm ngăn nghìn: `12.500.000 ₫`.
3. **Báo cáo tổng hiện theo tỷ đồng**: thẻ chỉ số, biểu đồ, bảng tổng hợp, cảnh báo hiện tiền theo đơn vị tỷ đồng (`9,25 tỷ`, `0,189 tỷ`). Bảng chi tiết từng khoản và ô nhập liệu dùng số đồng đầy đủ.
   - Mỗi khoản tiền có **trước VAT, VAT, sau VAT** (đang chờ người dùng chốt nghiệp vụ VAT, xem mục dưới).
4. **Bảng và dữ liệu**:
   - Mọi bảng có số tiền phải có **dòng Tổng cộng** (cả dạng thẻ trên điện thoại và tệp CSV xuất ra).
   - **Không làm mất dữ liệu**: không xóa hàng loạt ngoài ý muốn; không cho xóa bản ghi đang được bản ghi khác tham chiếu (vd. dự án còn giao dịch hoặc hợp đồng; HĐ gốc còn phụ lục). Dữ liệu ví dụ người dùng đã sửa thì không còn là dữ liệu ví dụ.
   - **Liên kết dữ liệu phải logic**: giao dịch và hợp đồng luôn thuộc một dự án đang tồn tại; máy chủ phải chặn dữ liệu sai liên kết, không chỉ giao diện.

### Hợp đồng với CĐT (người dùng đã chốt)
- Mỗi dự án có **đúng một HĐ gốc** (giá trị > 0) và các **phụ lục** 1..n (giá trị khác 0, **được âm** khi giảm khối lượng). Số thứ tự phụ lục do máy chủ cấp.
- Giá trị nhập là **trước VAT**. **VAT nhập tay** theo hợp đồng (không tự tính theo %); để trống = **Tạm tính** (VAT coi là 0, sau VAT = trước VAT), nhập bổ sung sau. Sau VAT = trước VAT + VAT.
- Giá trị hợp đồng của dự án **tự cộng từ bảng hợp đồng** (dự án chưa có dòng nào thì dùng `contractValue` cũ). Dữ liệu cũ được chuyển một lần thành HĐ gốc tạm tính (meta `contractsMigrated`), giữ nguyên `contractValue`.
- Tiền thu theo hồ sơ quyết toán là **sau VAT** → "Đã thu / hợp đồng", "Còn phải thu" luôn so với giá trị hợp đồng **sau VAT**. Lợi nhuận kế hoạch / dự báo = giá trị **trước VAT** − ngân sách.
- Nút **Trước VAT | Sau VAT** trên đầu trang (nhớ theo trình duyệt) đổi cách hiện giá trị hợp đồng; chưa áp dụng cho giao dịch thu/chi.
- Người nhập / người sửa do máy chủ tự ghi theo tài khoản đăng nhập.
- **Mã xóa**: Quản trị viên đặt trong Quản lý tài khoản (4–12 ký tự, lưu băm). Nhập liệu và Quản trị phải nhập mã khi **xóa dòng hợp đồng**; sai 5 lần / 15 phút thì tạm khóa. Chưa chốt có áp dụng mã xóa cho các thao tác xóa khác hay không.
- Không xóa HĐ gốc khi còn phụ lục; không xóa dự án còn hợp đồng hoặc giao dịch.
- Làm sau: đính kèm file scan, hợp đồng phía chi (thầu phụ, nhà cung cấp).

### VAT: câu hỏi nghiệp vụ còn chờ người dùng trả lời (cho giao dịch thu/chi)
- Phần hợp đồng đã trả lời: giá trị nhập **trước VAT**, VAT nhập tay, tiền thu theo quyết toán là **sau VAT** (xem mục trên).
- Báo cáo doanh thu, chi phí, lợi nhuận tính theo giá **trước VAT** hay **sau VAT**?
- Giao dịch thu/chi: thuế suất dùng những mức nào? Nhập theo % hay nhập số tiền VAT theo hóa đơn? Người dùng gõ số trước VAT hay tổng thanh toán?
- Ngân sách dự án có tách trước VAT / VAT / sau VAT không?
- Giao dịch đã nhập trước đây: coi số tiền hiện có là trước VAT hay sau VAT, thuế suất bao nhiêu?

## Môi trường và nhánh
- `main` → Railway **production** (số liệu thật). `staging` → Railway **staging** (dữ liệu thử).
- Mọi thay đổi vào `staging` trước; người dùng gộp vào `main` qua Pull Request sau khi kiểm tra.

## Hai agent của dự án
- `revi`: lập kế hoạch trước khi code; review, chạy kiểm tra sau khi code. Không sửa file.
- `dev`: viết code trên `staging`, chạy `npm test`, commit và push `staging`.
- Quy trình: `revi` (kế hoạch) → `dev` (làm) → `revi` (review) → `dev` (sửa nếu cần) → người dùng gộp vào `main`.
