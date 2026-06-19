import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEqual, splitByWeight } from "../src/core/split.js";

test("splitEqual: 100 元三人均分 → 34, 33, 33（規格 §4.2 範例）", () => {
  const r = splitEqual(100, 3);
  assert.deepEqual(r, [34, 33, 33]);
  assert.equal(sum(r), 100);
});

test("splitEqual: 整除時人人相同", () => {
  assert.deepEqual(splitEqual(90, 3), [30, 30, 30]);
  assert.deepEqual(splitEqual(100, 4), [25, 25, 25, 25]);
});

test("splitEqual: 餘數逐一補位給前幾人", () => {
  assert.deepEqual(splitEqual(101, 3), [34, 34, 33]); // 餘 2 → 前兩人
  assert.deepEqual(splitEqual(7, 4), [2, 2, 2, 1]); // 餘 3 → 前三人
});

test("splitEqual: 一人時拿全部", () => {
  assert.deepEqual(splitEqual(57, 1), [57]);
});

test("splitEqual: 0 元", () => {
  assert.deepEqual(splitEqual(0, 3), [0, 0, 0]);
});

test("splitEqual: 負數（折扣）加總歸零", () => {
  const r = splitEqual(-100, 3);
  assert.deepEqual(r, [-34, -33, -33]);
  assert.equal(sum(r), -100);
});

test("splitEqual: n<=0 回空", () => {
  assert.deepEqual(splitEqual(100, 0), []);
});

test("splitByWeight: A 800、B 200，服務費 100 → 80, 20（規格 §4.3 範例）", () => {
  const r = splitByWeight(100, [800, 200]);
  assert.deepEqual(r, [80, 20]);
  assert.equal(sum(r), 100);
});

test("splitByWeight: 餘數補位後加總等於 total", () => {
  const r = splitByWeight(10, [1, 1, 1]); // 各 3.33 → floor 3,3,3 餘 1
  assert.equal(sum(r), 10);
  assert.deepEqual(r, [4, 3, 3]);
});

test("splitByWeight: 權重全 0 退回齊頭均分", () => {
  assert.deepEqual(splitByWeight(100, [0, 0, 0]), [34, 33, 33]);
});

test("splitByWeight: 負數（折扣）依占比且加總歸零", () => {
  const r = splitByWeight(-100, [800, 200]);
  assert.deepEqual(r, [-80, -20]);
  assert.equal(sum(r), -100);
});

test("splitByWeight: 隨機壓力測試，加總永遠等於 total", () => {
  for (let t = 0; t < 2000; t++) {
    const n = 1 + Math.floor(Math.random() * 8);
    const weights = Array.from({ length: n }, () => Math.floor(Math.random() * 1000));
    const total = Math.floor(Math.random() * 100000) - 50000;
    const r = splitByWeight(total, weights);
    assert.equal(sum(r), total, `failed: total=${total} weights=${weights}`);
  }
});

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
