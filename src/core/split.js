// 餘數補位法（規格 §4.2）
//
// 將整數 total 分給 n 份，採「floor + 餘數逐一補位給前幾人」：
//   1. 每份先拿 floor(|total| / n)
//   2. 餘數 |total| - floor*n 逐一補 1 給「前幾人」
//   3. 加總必定等於 total（不多不少）
//
// 支援負數（折扣）：以絕對值計算後再套回正負號。
export function splitEqual(total, n) {
  const result = new Array(n).fill(0);
  if (n <= 0) return result;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;
  for (let i = 0; i < n; i++) {
    result[i] = base + (i < remainder ? 1 : 0);
  }
  return result.map((v) => v * sign);
}

// 按權重分攤（規格 §4.3）
//
// 將整數 total 依 weights 占比分攤，餘數同樣用補位法歸零（§4.2）。
//   base_i = floor(|total| * w_i / W)，餘數逐一補給前幾人
// 權重全為 0 時退回齊頭均分（splitEqual）。
// 支援負數（折扣）。
export function splitByWeight(total, weights) {
  const n = weights.length;
  const result = new Array(n).fill(0);
  if (n <= 0 || total === 0) return result;

  const W = weights.reduce((a, b) => a + b, 0);
  if (W === 0) return splitEqual(total, n);

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const base = Math.floor((abs * weights[i]) / W);
    result[i] = base;
    allocated += base;
  }
  let remainder = abs - allocated;
  // 餘數逐一補位給前幾人（與 §4.2 一致；實作最單純）
  for (let i = 0; remainder > 0; i = (i + 1) % n, remainder--) {
    result[i] += 1;
  }
  return result.map((v) => v * sign);
}
