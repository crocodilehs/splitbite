# SplitBite 🍽️

聚餐分帳工具。上傳收據自動辨識品項，多人各自用手機認領，計算每個人該付給墊款人多少錢。

> 手機優先的單頁 web app。前端 supabase-js 直連，後端 Supabase（Postgres + Realtime + Edge Functions），OCR 走 Gemini。

## 開發階段

| 階段 | 內容 | 狀態 |
|------|------|------|
| 1 | 本機版核心：品項 → 認領 → 計算 → 兩種結算 | ✅ 完成 |
| 2 | 接 Supabase：建表、Realtime、加入碼機制 | ✅ 完成（live 整合測試 3/3 綠）|
| 3 | 接 OCR：Edge Function + Gemini 自動填品項 | ✅ 完成（真收據圖端到端實測通過）|
| 4 | 打磨：服務費/折扣、QR code、結果分享 | ✅ 完成（低信心高亮與 OCR 對帳的 UI 已就緒，資料由階段 3 填入）|

## 階段 1：計算核心（可測模組）

計算邏輯獨立於 UI，純函式、無依賴，方便單元測試與日後隔離問題。

- `src/core/split.js` — 餘數補位法（§4.2）與占比分攤（§4.3）
- `src/core/calc.js` — `compute()` 完整計算流程（§4.5，含 Σ 驗算斷言）與 `settle()` 結算（§5）

核心保證：**每人應付加總必定等於收據總額**，不多不少。全程整數「元」運算，除不盡時用 floor + 餘數逐一補位歸零。

### 跑測試

```bash
npm test
```

涵蓋規格中的範例（100 元三人均分 → 34/33/33；服務費 10% 按占比 80/20）、
未認領處理、折扣、結算兩種模式，以及隨機壓力測試驗證加總恆等於總額。

## 階段 1：本機 UI

純前端、無建置步驟。用任意靜態伺服器開啟根目錄即可（ES modules 需經 http，不能用 `file://`）：

```bash
npx serve .
# 或
python3 -m http.server 8000
```

然後開啟 `index.html`。「最近的 session」與「我是誰」存於 localStorage；資料本體在 Supabase（Realtime 同步）。

前端執行期依賴（supabase-js、qrcode-generator）已打包在 `src/vendor/`，不依賴 CDN。
升級依賴版本後執行 `npm run vendor` 重新產生並 commit。

## 階段 3：OCR（收據 → 品項）

流程：前端把收據照片縮圖（≤1600px JPEG）→ `POST /functions/v1/ocr`（Edge Function）→
Gemini（`gemini-3.1-flash-lite`，structured output）→ 前端 `src/core/ocr.js` 正規化 → 寫入品項。

- API key 只存在 Supabase secrets（`GEMINI_API_KEY`），不進前端與 repo。
- 服務費/折扣/稅不會進品項（app 有調整項機制），但會包含在 `total` 供對帳。
- 影像模糊或金額經推算的品項標 `confidence:'low'`，UI 黃框提醒核對。

### 部署

1. Dashboard → Edge Functions → Secrets：設定 `GEMINI_API_KEY`。
2. 部署 `supabase/functions/ocr/index.ts`：
   - CLI：`supabase functions deploy ocr --no-verify-jwt --project-ref <ref>`
   - 或 Dashboard → Edge Functions → Deploy new function → 名稱 `ocr` → 貼上檔案內容。
   - ⚠️ 需**關閉 JWT 驗證**（`--no-verify-jwt` / 取消勾選 Enforce JWT verification）：
     前端用新式 publishable key，不是 JWT，開著會一律 401。

## 階段 4：分享與打磨

- **QR code**：session 標頭顯示加入 QR，內容為 `<app 網址>#join=<code>`；掃碼或點分享連結開啟即自動加入（深連結處理後會清掉 hash，避免重整重複觸發）。
- **分享連結**：行動裝置用系統分享面板（`navigator.share`），桌面退回複製連結。
- **OCR 信心高亮**：`items.confidence = 'low'` 的品項以黃框＋⚠️ 提示核對（資料由階段 3 OCR 填入，人工輸入為 null）。
- **OCR 對帳警告**：`sessions.ocr_total`（收據上讀到的總額）與計算合計不符時，結算區顯示警告。
- **結果分享**：一鍵複製各人應付與轉帳明細文字。

## 階段 2：Supabase 設定與實測

1. Supabase Dashboard → SQL Editor，依序執行 `supabase/schema.sql`、`supabase/rls.sql`（兩者皆可重複執行）。
   - ⚠️ `rls.sql` 含必要的 `GRANT`：RLS 政策只是過濾條件，anon 角色仍需表級權限，
     缺少時所有請求都會回 `42501 permission denied`。
2. 將專案 URL 與 publishable key 填入 `src/app/config.js`（參考 `config.example.js`）。
3. 跑端到端整合測試（建 session、Realtime 推播、CRUD 讀寫一致，測後自動清理）：

```bash
npm install
SPLITBITE_LIVE=1 npm test
```

未設 `SPLITBITE_LIVE=1` 時整合測試自動略過，`npm test` 只跑離線單元測試。

## 計算規則摘要（§4）

| 規則 | 採用方式 |
|------|---------|
| 精度 | 整數「元」，不用小數 |
| 餘數 | floor + 逐一補位給前幾人，加總歸零 |
| 服務費/折扣 | 按品項小計占比分攤 |
| 共享品項 | 每品項可指定均分對象，湯底等用「全選」 |
| 驗算 | Σ每人應付必須等於總額（斷言抓 bug） |
