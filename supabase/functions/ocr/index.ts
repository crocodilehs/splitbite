// SplitBite OCR Edge Function — Gemini 收據辨識代理（規格 §6）
//
// 職責刻意最小化：隱藏 GEMINI_API_KEY（只存在 Supabase secrets，不進前端），
// 把收據影像轉給 Gemini，原樣回傳結構化 JSON。
// 欄位驗證/正規化在前端 src/core/ocr.js 做（純函式、可單元測試）。
//
// 部署（Dashboard 路線）：Edge Functions → Deploy new function → 名稱 `ocr` → 貼上本檔。
// ⚠️ 本專案前端用新式 publishable key（非 JWT），部署時需關閉
//    「Enforce JWT verification」，否則一律 401。
// 部署（CLI 路線）：supabase functions deploy ocr --no-verify-jwt
//
// 請求：POST { image: <base64 不含 dataURL 前綴>, mime: "image/jpeg" | "image/png" | "image/webp" }
// 回應：200 { items: [{ name, qty, unit_price, confidence }], total }
//       4xx/5xx { error: "訊息" }

const MODEL = "gemini-3.1-flash-lite";
const MAX_BASE64_LEN = 8_000_000; // ~6MB 影像；前端已縮圖，正常遠小於此

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `你是收據辨識引擎。從這張餐廳收據照片中擷取品項。規則：
1. 每個品項輸出：name（品名，保留原文）、qty（數量，正整數）、unit_price（單價，整數元，四捨五入）。
2. 單價是「一份」的價格；若收據只印小計，unit_price = 小計 ÷ 數量（四捨五入）。
3. confidence：影像模糊、金額不確定、或你做了推算 → "low"；清楚可讀 → "high"。
4. total：收據上印的應付總額（整數元）；找不到就省略。
5. 服務費、折扣、稅金「不要」放進 items（app 另有調整項機制），但它們包含在 total 中沒關係。
6. 不是收據或完全無法辨識 → items 給空陣列。`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          qty: { type: "INTEGER" },
          unit_price: { type: "INTEGER" },
          confidence: { type: "STRING", enum: ["high", "low"] },
        },
        required: ["name", "qty", "unit_price", "confidence"],
      },
    },
    total: { type: "INTEGER" },
  },
  required: ["items"],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "只接受 POST" });

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json(500, { error: "伺服器未設定 GEMINI_API_KEY" });

  let image: string, mime: string;
  try {
    const body = await req.json();
    image = String(body.image || "");
    mime = String(body.mime || "image/jpeg");
  } catch {
    return json(400, { error: "請求需為 JSON：{ image, mime }" });
  }
  if (!image) return json(400, { error: "缺少 image（base64）" });
  if (image.length > MAX_BASE64_LEN) return json(413, { error: "影像過大，請壓縮後再試" });
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json(400, { error: "mime 需為 image/jpeg|png|webp" });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mime, data: image } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      }),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Gemini error", res.status, detail.slice(0, 500));
    // 不把上游細節透給前端（可能含配額/專案資訊），log 供除錯
    return json(502, { error: `OCR 服務暫時無法使用（${res.status}）` });
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return json(502, { error: "OCR 服務回應為空" });

  try {
    return json(200, JSON.parse(text));
  } catch {
    console.error("Gemini 非 JSON 回應", String(text).slice(0, 500));
    return json(502, { error: "OCR 回應格式錯誤" });
  }
});
