# Sổ Tài Chính Dự Án

Quản lý doanh thu, chi phí và lợi nhuận cho một hoặc nhiều dự án: tổng quan danh mục, chi tiết từng dự án so với hợp đồng và ngân sách, sổ giao dịch xuất CSV.

- `server.js`: máy chủ Express (API + trang web)
- `public/index.html`: giao diện
- `sample.js`: dữ liệu ví dụ nạp ở lần chạy đầu (xóa được bằng nút "Xóa dữ liệu ví dụ")

## Chạy thử trên máy

```bash
npm install
npm start          # http://localhost:3000, dữ liệu lưu ở ./data/db.json
```

## Deploy lên Railway

### Cách 1: Railway CLI (từ thư mục này)

```bash
npm i -g @railway/cli
railway login
railway init                         # tạo project mới
railway add --database postgres      # thêm PostgreSQL
railway up                           # tạo service từ code và deploy
```

Sau đó vào service vừa tạo trên railway.com:

1. **Variables**: thêm
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`: tài khoản quản trị đầu tiên
   - `SESSION_SECRET`: chuỗi ngẫu nhiên dài (giữ phiên đăng nhập khi máy chủ khởi động lại)
2. **Settings → Networking → Generate Domain** để có địa chỉ `*.up.railway.app`.

### Cách 2: Từ GitHub

1. Đẩy thư mục này lên một repo GitHub.
2. Trên railway.com: **New Project → Deploy from GitHub repo** → chọn repo.
3. Trong project: **+ Create → Database → PostgreSQL**.
4. Thêm các biến `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET` cho service như trên, rồi **Generate Domain**.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL. Không đặt thì dữ liệu lưu vào tệp JSON (mất khi deploy lại, trừ khi gắn Volume). |
| `ADMIN_USERNAME` | Tên đăng nhập của quản trị viên đầu tiên (mặc định `admin`). Chỉ dùng khi chưa có tài khoản nào. |
| `ADMIN_PASSWORD` | Mật khẩu của quản trị viên đầu tiên. Không đặt thì máy chủ tạo mật khẩu tạm và in ra Deploy Logs. |
| `ADMIN_NAME` | Họ tên hiển thị của quản trị viên đầu tiên. |
| `SESSION_SECRET` | Khóa ký phiên đăng nhập (chuỗi ngẫu nhiên ≥ 32 ký tự). Mỗi môi trường một giá trị khác nhau. |
| `SESSION_HOURS` | Thời gian giữ đăng nhập, mặc định 12 giờ. |
| `BRAND_COMPANY`, `BRAND_TAGLINE`, `BRAND_UNIT`, `BRAND_LEGAL_NAME`, `BRAND_FOOTER` | Chữ trên trang đăng nhập (mặc định theo Tân Minh Nhân · Ban Kiểm soát). |
| `SEED_SAMPLE` | Đặt `false` để không nạp dữ liệu ví dụ ở lần chạy đầu. |
| `PGSSL` | Đặt `true` nếu kết nối Postgres qua địa chỉ công khai cần SSL. |
| `DATA_DIR` | Thư mục lưu tệp JSON khi không dùng Postgres (gắn Railway Volume vào đây). |

## Môi trường thử nghiệm (staging) chạy song song

Hai bản chạy cùng lúc, mỗi bản có cơ sở dữ liệu và địa chỉ riêng:

| | Chính (production) | Thử nghiệm (staging) |
|---|---|---|
| Nhánh Git | `main` | `staging` |
| Môi trường Railway | `production` | `staging` |
| Cơ sở dữ liệu | Postgres riêng (số liệu thật) | Postgres riêng (dữ liệu thử) |
| Nhận diện | bình thường | dải sọc vàng "MÔI TRƯỜNG THỬ NGHIỆM" |

Ứng dụng tự đọc `RAILWAY_ENVIRONMENT_NAME` do Railway đặt; mọi môi trường khác `production` đều hiện dải cảnh báo.

Quy trình: sửa trên nhánh `staging` → Railway tự deploy bản thử → kiểm tra → gộp `staging` vào `main` → bản chính tự cập nhật.

## Tài khoản đăng nhập

- Trang `/login`. Mỗi người một tài khoản, mật khẩu được mã hóa (scrypt), phiên lưu trong cookie bảo mật.
- Vai trò: **Chỉ xem** (xem số liệu) · **Nhập liệu** (thêm, sửa, xóa dự án và giao dịch) · **Quản trị** (thêm quản lý tài khoản).
- Quản trị viên tạo tài khoản và cấp lại mật khẩu trong menu tên người dùng → **Quản lý tài khoản**. Người được cấp mật khẩu tạm phải đổi ở lần đăng nhập đầu.
- Khóa hoặc xóa tài khoản sẽ đăng xuất người đó ngay. Sai mật khẩu 8 lần thì tạm khóa 15 phút.
- Logo: đặt tệp `public/brand/logo.png` (logo đầy đủ, gồm cả chữ). Khi chưa có, trang dùng chữ và biểu tượng tạm.
