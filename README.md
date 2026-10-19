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
   - `APP_PASSWORD` = mật khẩu bạn chọn (tên đăng nhập mặc định `admin`, đổi bằng `APP_USER`)
2. **Settings → Networking → Generate Domain** để có địa chỉ `*.up.railway.app`.

### Cách 2: Từ GitHub

1. Đẩy thư mục này lên một repo GitHub.
2. Trên railway.com: **New Project → Deploy from GitHub repo** → chọn repo.
3. Trong project: **+ Create → Database → PostgreSQL**.
4. Thêm biến `DATABASE_URL` và `APP_PASSWORD` cho service như trên, rồi **Generate Domain**.

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL. Không đặt thì dữ liệu lưu vào tệp JSON (mất khi deploy lại, trừ khi gắn Volume). |
| `APP_PASSWORD` | Bật đăng nhập (HTTP Basic). **Nên đặt**, vì trang chứa số liệu tài chính. |
| `APP_USER` | Tên đăng nhập, mặc định `admin`. |
| `SEED_SAMPLE` | Đặt `false` để không nạp dữ liệu ví dụ ở lần chạy đầu. |
| `PGSSL` | Đặt `true` nếu kết nối Postgres qua địa chỉ công khai cần SSL. |
| `DATA_DIR` | Thư mục lưu tệp JSON khi không dùng Postgres (gắn Railway Volume vào đây). |
