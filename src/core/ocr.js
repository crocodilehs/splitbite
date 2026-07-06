// OCR 回應正規化（規格 §6）
//
// Edge Function 只做代理，Gemini 的輸出在這裡驗證與收斂後才進資料庫。
// 純函式、無依賴，與 split.js / calc.js 同樣以單元測試守住。

const MAX_ITEMS = 100; // 一張收據不會有這麼多品項；防呆上限
const MAX_QTY = 999;
const MAX_PRICE = 1_000_000;

// 把 Edge Function 回應（可能不可信）轉成安全的 { items, total }。
//   items: [{ name, qty, unit_price, confidence }]，全為合法值
//   total: 正整數或 null（收據上沒印/讀不到）
export function normalizeOcrResult(raw) {
  const out = { items: [], total: null };
  if (!raw || typeof raw !== "object") return out;

  const list = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const name = String(it.name ?? "").trim().slice(0, 100);
    const qty = clampInt(it.qty, 1, MAX_QTY, 1);
    const unit_price = clampInt(it.unit_price, 0, MAX_PRICE, 0);
    if (!name && unit_price === 0) continue; // 無品名又無金額 → 雜訊，略過
    out.items.push({
      name,
      qty,
      unit_price,
      confidence: it.confidence === "low" ? "low" : "high",
    });
  }

  const total = clampInt(raw.total, 1, MAX_PRICE * 10, null);
  out.total = total;
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
