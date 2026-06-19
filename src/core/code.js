// 加入碼（規格 §3 sessions.code、§8 唯一性）
//
// 6 碼短碼，供 QR / 手動輸入。排除易混淆字元（0/O、1/I/L），
// 全大寫，方便手機輸入與口頭傳達。

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去除 0 O 1 I L
const LENGTH = 6;

// 產生單一隨機碼（密碼學等級隨機）
export function generateCode(length = LENGTH) {
  const out = new Array(length);
  const max = ALPHABET.length;
  const buf = randomBytes(length);
  for (let i = 0; i < length; i++) {
    out[i] = ALPHABET[buf[i] % max];
  }
  return out.join("");
}

// 產生唯一碼：碰撞時重試（規格 §8）
//   existsFn(code) -> boolean | Promise<boolean>：該碼是否已存在
//   回傳一個尚未被使用的碼；超過 maxTries 仍碰撞則丟錯。
export async function generateUniqueCode(existsFn, { maxTries = 10, length = LENGTH } = {}) {
  for (let i = 0; i < maxTries; i++) {
    const code = generateCode(length);
    const taken = await existsFn(code);
    if (!taken) return code;
  }
  throw new Error(`產生唯一加入碼失敗：連續 ${maxTries} 次碰撞`);
}

// 正規化使用者輸入：去空白與連字號、轉大寫。
// 字母表已排除易混淆字元（0/O、1/I/L），故不做猜測性映射。
export function normalizeCode(input) {
  return String(input || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

export function isValidCode(input) {
  const c = normalizeCode(input);
  if (c.length !== LENGTH) return false;
  return [...c].every((ch) => ALPHABET.includes(ch));
}

function randomBytes(n) {
  // 同時支援瀏覽器（crypto.getRandomValues）與 Node（globalThis.crypto）
  const g = globalThis.crypto;
  if (g && g.getRandomValues) {
    return g.getRandomValues(new Uint8Array(n));
  }
  // 後備：非密碼學等級
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
}

export const CODE_LENGTH = LENGTH;
export const CODE_ALPHABET = ALPHABET;
