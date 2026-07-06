import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcrResult } from "../src/core/ocr.js";

test("正常回應：品項與 total 原樣通過", () => {
  const r = normalizeOcrResult({
    items: [
      { name: "牛肉麵", qty: 2, unit_price: 180, confidence: "high" },
      { name: "小菜", qty: 1, unit_price: 40, confidence: "low" },
    ],
    total: 400,
  });
  assert.deepEqual(r.items, [
    { name: "牛肉麵", qty: 2, unit_price: 180, confidence: "high" },
    { name: "小菜", qty: 1, unit_price: 40, confidence: "low" },
  ]);
  assert.equal(r.total, 400);
});

test("垃圾輸入：null / 非物件 / items 非陣列 → 空結果", () => {
  for (const bad of [null, undefined, 42, "x", {}, { items: "not-array" }]) {
    const r = normalizeOcrResult(bad);
    assert.deepEqual(r, { items: [], total: null });
  }
});

test("數值收斂：字串數字、小數、負數、超界", () => {
  const r = normalizeOcrResult({
    items: [
      { name: "A", qty: "3", unit_price: "99.6", confidence: "high" }, // 字串 → 數字，四捨五入
      { name: "B", qty: -5, unit_price: 50, confidence: "high" },      // qty 非法 → 1
      { name: "C", qty: 2, unit_price: -10, confidence: "high" },      // 價格非法 → 0（仍保留，因有品名）
      { name: "D", qty: 2, unit_price: 99999999, confidence: "high" }, // 超界 → 0
    ],
  });
  assert.deepEqual(
    r.items.map((i) => [i.qty, i.unit_price]),
    [[3, 100], [1, 50], [2, 0], [2, 0]]
  );
});

test("confidence 只認 low，其他一律 high", () => {
  const r = normalizeOcrResult({
    items: [
      { name: "A", qty: 1, unit_price: 10, confidence: "low" },
      { name: "B", qty: 1, unit_price: 10, confidence: "HIGH" },
      { name: "C", qty: 1, unit_price: 10, confidence: "banana" },
      { name: "D", qty: 1, unit_price: 10 },
    ],
  });
  assert.deepEqual(r.items.map((i) => i.confidence), ["low", "high", "high", "high"]);
});

test("雜訊品項（無品名且 0 元）被濾掉；有品名的 0 元保留", () => {
  const r = normalizeOcrResult({
    items: [
      { name: "", qty: 1, unit_price: 0, confidence: "high" },
      { name: "   ", qty: 1, unit_price: 0, confidence: "high" },
      { name: "招待小菜", qty: 1, unit_price: 0, confidence: "high" },
      { name: "", qty: 1, unit_price: 30, confidence: "high" },
    ],
  });
  assert.deepEqual(r.items.map((i) => i.name), ["招待小菜", ""]);
});

test("品項數量上限 100，品名截斷 100 字", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `x${i}`, qty: 1, unit_price: 1, confidence: "high" }));
  const r = normalizeOcrResult({ items: many });
  assert.equal(r.items.length, 100);

  const long = normalizeOcrResult({ items: [{ name: "字".repeat(200), qty: 1, unit_price: 1, confidence: "high" }] });
  assert.equal(long.items[0].name.length, 100);
});

test("total：缺、0、負、非數 → null", () => {
  assert.equal(normalizeOcrResult({ items: [] }).total, null);
  assert.equal(normalizeOcrResult({ items: [], total: 0 }).total, null);
  assert.equal(normalizeOcrResult({ items: [], total: -5 }).total, null);
  assert.equal(normalizeOcrResult({ items: [], total: "abc" }).total, null);
  assert.equal(normalizeOcrResult({ items: [], total: "350" }).total, 350);
});
