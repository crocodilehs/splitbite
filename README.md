# SplitBite 🍽️

聚餐分帳工具。上傳收據自動辨識品項，多人各自用手機認領，計算每個人該付給墊款人多少錢。

> 手機優先的單頁 web app。前端 supabase-js 直連，後端 Supabase（Postgres + Realtime + Edge Functions），OCR 走 Gemini。

## 開發階段

| 階段 | 內容 | 狀態 |
|------|------|------|
| 1 | 本機版核心：品項 → 認領 → 計算 → 兩種結算 | ✅ 完成 |
| 2 | 接 Supabase：建表、Realtime、加入碼機制 | ✅ 完成（live 整合測試 3/3 綠）|
| 3 | 接 OCR：Edge Function + Gemini 自動填品項 | ⏳ |
| 4 | 打磨：服務費/折扣、QR code、結果分享 | ⏳ |

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

然後開啟 `index.html`。狀態暫存於 localStorage；階段 2 會以 Supabase + Realtime 取代 `store.js`，對外 state 形狀不變。

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
