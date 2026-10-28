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
| `ADMIN_USERNAME` | Tên đăng nhập của quản trị viên đầu tiên (mặc định `admin`). Chỉ dùng khi chưa có tài khoản nào hoặc khi có `ADMIN_RESET`. Cũng đọc được từ `ADMIN_USER`. |
| `ADMIN_PASSWORD` | Mật khẩu của quản trị viên đầu tiên. Không đặt thì máy chủ tạo mật khẩu tạm và in ra Deploy Logs. |
| `ADMIN_NAME` | Họ tên hiển thị của quản trị viên đầu tiên. |
| `SESSION_SECRET` | Khóa ký phiên đăng nhập (tùy chọn). Không đặt thì hệ thống tự tạo và lưu trong cơ sở dữ liệu. |
| `SESSION_IDLE_MINUTES` | Tự đăng xuất sau bấy nhiêu phút không thao tác, mặc định 60. Deploy lại không đăng xuất. |
| `FACTORY_RESET` | Một chuỗi bất kỳ (vd `2026-10-28`): xóa **sạch** dự án, giao dịch và tài khoản đúng một lần cho mỗi giá trị, rồi khởi động như mới. Không chạy ở production. |
| `ADMIN_RESET` | `true`: đặt lại hoặc tạo tài khoản `ADMIN_USERNAME`. `all`: xóa mọi tài khoản rồi tạo lại một quản trị viên (dữ liệu dự án giữ nguyên). **Xóa ngay sau khi dùng.** |
| `BRAND_NAME` | Tên ứng dụng trên thanh bên và trang đăng nhập (mặc định `Sổ Tài Chính Dự Án`). |
| `BRAND_ORG` | Tên đơn vị hoặc công ty hiện dưới tên ứng dụng (mặc định để trống). |
| `BRAND_TAGLINE`, `BRAND_FOOTER` | Câu giới thiệu và dòng chân trang trên trang đăng nhập (tùy chọn). |
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
- Logo: đặt tệp `public/brand/logo.png`; logo thay biểu tượng ứng dụng ở thanh bên và trang đăng nhập.

### Khôi phục hoặc đổi tài khoản quản trị

1. Trên Railway, vào **Variables** của môi trường cần khôi phục và đặt:
   - `ADMIN_USERNAME`: tên đăng nhập muốn dùng (tên cũ để đặt lại mật khẩu, tên mới để tạo thêm quản trị viên)
   - `ADMIN_PASSWORD`: mật khẩu mới, ít nhất 8 ký tự
   - `ADMIN_RESET` = `true` (chỉ tài khoản này) hoặc `all` (xóa mọi tài khoản cũ, dữ liệu dự án giữ nguyên)
2. Đợi deploy xong. Deploy Logs có dòng `ADMIN_RESET: đã đặt lại…` hoặc `ADMIN_RESET: đã tạo…`. Mọi phiên đăng nhập cũ của tài khoản đó bị đăng xuất.
3. Đăng nhập bằng tài khoản vừa đặt, rồi **xóa biến `ADMIN_RESET`**. Nếu để nguyên, mỗi lần deploy mật khẩu sẽ bị đặt lại.
4. Tài khoản quản trị cũ không bị xóa; muốn bỏ thì vào **Quản lý tài khoản** để khóa hoặc xóa.

### Khởi tạo lần đầu (không cần đặt mật khẩu trong biến)

Khi chưa có tài khoản nào và không đặt `ADMIN_PASSWORD`, máy chủ in vào log dòng
`Mở trang /setup và nhập Mã khởi tạo: XXXX-XXXX`. Mở trang đăng nhập (tự chuyển sang `/setup`),
nhập mã đó cùng tên đăng nhập và mật khẩu muốn dùng để tạo quản trị viên đầu tiên. Trang chỉ dùng được một lần;
mã đổi mỗi lần máy chủ khởi động lại.

Chỉ làm lại tài khoản trên môi trường thử nghiệm (giữ dữ liệu): sửa `deploy/reset.json` với `token` mới, `"scope": "accounts"` và mã băm scrypt của mật khẩu tạm, rồi đẩy lên nhánh `staging`.

Muốn làm lại từ đầu một môi trường thử nghiệm: xóa các biến `ADMIN_*`, đặt `FACTORY_RESET` = một giá trị mới, deploy,
rồi làm theo bước khởi tạo ở trên.
