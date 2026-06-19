import { test } from "node:test";
import assert from "node:assert/strict";
import { compute, settle } from "../src/core/calc.js";

// 小工具：建立測試資料
function fixture() {
  const members = [
    { id: "a", name: "Amy" },
    { id: "b", name: "Bob" },
    { id: "c", name: "Cara" },
  ];
  return { members };
}

test("compute: 單人認領單品項", () => {
  const { members } = fixture();
  const items = [{ id: "i1", name: "牛排", qty: 1, unit_price: 500 }];
  const claims = [{ item_id: "i1", member_id: "a" }];
  const r = compute({ members, items, claims });
  assert.equal(r.perMember[0].total, 500);
  assert.equal(r.perMember[1].total, 0);
  assert.equal(r.claimedTotal, 500);
  assert.equal(r.unclaimedTotal, 0);
});

test("compute: qty × unit_price", () => {
  const { members } = fixture();
  const items = [{ id: "i1", name: "飲料", qty: 3, unit_price: 50 }];
  const claims = [{ item_id: "i1", member_id: "a" }];
  const r = compute({ members, items, claims });
  assert.equal(r.perMember[0].total, 150);
});

test("compute: 兩人合點甜點自動均分（除不盡補位）", () => {
  const { members } = fixture();
  const items = [{ id: "i1", name: "甜點", qty: 1, unit_price: 101 }];
  const claims = [
    { item_id: "i1", member_id: "a" },
    { item_id: "i1", member_id: "b" },
  ];
  const r = compute({ members, items, claims });
  assert.equal(r.perMember[0].total, 51); // 前一人多 1
  assert.equal(r.perMember[1].total, 50);
  assert.equal(r.perMember[2].total, 0);
});

test("compute: 全體共享品項（全選）三人均分 100 → 34/33/33", () => {
  const { members } = fixture();
  const items = [{ id: "i1", name: "火鍋湯底", qty: 1, unit_price: 100 }];
  const claims = members.map((m) => ({ item_id: "i1", member_id: m.id }));
  const r = compute({ members, items, claims });
  assert.deepEqual(
    r.perMember.map((p) => p.total),
    [34, 33, 33]
  );
});

test("compute: 服務費 10% 按品項小計占比分攤（規格 §4.3 範例）", () => {
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const items = [
    { id: "i1", name: "A餐", qty: 1, unit_price: 800 },
    { id: "i2", name: "B餐", qty: 1, unit_price: 200 },
  ];
  const claims = [
    { item_id: "i1", member_id: "a" },
    { item_id: "i2", member_id: "b" },
  ];
  const adjustments = [{ id: "s", label: "服務費", mode: "percent", value: 10 }];
  const r = compute({ members, items, claims, adjustments });
  assert.equal(r.perMember[0].adjustment, 80);
  assert.equal(r.perMember[1].adjustment, 20);
  assert.equal(r.perMember[0].total, 880);
  assert.equal(r.perMember[1].total, 220);
  assert.equal(r.grandTotal, 1100);
});

test("compute: 折扣（負值 fixed）依占比分攤", () => {
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const items = [
    { id: "i1", name: "A餐", qty: 1, unit_price: 800 },
    { id: "i2", name: "B餐", qty: 1, unit_price: 200 },
  ];
  const claims = [
    { item_id: "i1", member_id: "a" },
    { item_id: "i2", member_id: "b" },
  ];
  const adjustments = [{ id: "d", label: "折扣", mode: "fixed", value: -100 }];
  const r = compute({ members, items, claims, adjustments });
  assert.equal(r.perMember[0].adjustment, -80);
  assert.equal(r.perMember[1].adjustment, -20);
  assert.equal(r.grandTotal, 900);
});

test("compute: 未認領品項計入 unclaimedTotal，不算進任何人", () => {
  const { members } = fixture();
  const items = [
    { id: "i1", name: "已認領", qty: 1, unit_price: 100 },
    { id: "i2", name: "沒人領", qty: 1, unit_price: 60 },
  ];
  const claims = [{ item_id: "i1", member_id: "a" }];
  const r = compute({ members, items, claims });
  assert.equal(r.claimedTotal, 100);
  assert.equal(r.unclaimedTotal, 60);
  assert.equal(r.itemsTotal, 160);
  assert.equal(r.unclaimedItems.length, 1);
  assert.equal(r.unclaimedItems[0].id, "i2");
});

test("compute: 驗算斷言 — Σ每人應付 == grandTotal（複雜情境）", () => {
  const members = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }));
  const items = [
    { id: "i1", name: "主餐", qty: 2, unit_price: 333 },
    { id: "i2", name: "共享", qty: 1, unit_price: 777 },
    { id: "i3", name: "合點", qty: 3, unit_price: 49 },
  ];
  const claims = [
    { item_id: "i1", member_id: "m0" },
    { item_id: "i1", member_id: "m1" },
    ...members.map((m) => ({ item_id: "i2", member_id: m.id })), // 全體共享
    { item_id: "i3", member_id: "m2" },
    { item_id: "i3", member_id: "m3" },
    { item_id: "i3", member_id: "m4" },
  ];
  const adjustments = [
    { id: "s", label: "服務費", mode: "percent", value: 10 },
    { id: "d", label: "折價券", mode: "fixed", value: -50 },
  ];
  const r = compute({ members, items, claims, adjustments });
  const sum = r.perMember.reduce((a, p) => a + p.total, 0);
  assert.equal(sum, r.grandTotal); // compute 內也已斷言，這裡再次確認
});

test("settle: 全還給墊款人，每位非墊款人付給墊款人其應付", () => {
  const { members } = fixture();
  const items = [
    { id: "i1", name: "x", qty: 1, unit_price: 300 },
    { id: "i2", name: "y", qty: 1, unit_price: 200 },
  ];
  const claims = [
    { item_id: "i1", member_id: "a" },
    { item_id: "i2", member_id: "b" },
  ];
  const r = compute({ members, items, claims });
  const { transfers } = settle(r, "a", "toPayer");
  // 墊款人 a 不付自己；c 無應付不轉帳；只有 b → a
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0], {
    from: "b",
    fromName: "Bob",
    to: "a",
    toName: "Amy",
    amount: 200,
  });
});

test("settle: minimal 與 toPayer 在單一墊款人下結果相同（規格 §5）", () => {
  const { members } = fixture();
  const items = [{ id: "i1", name: "x", qty: 1, unit_price: 300 }];
  const claims = [
    { item_id: "i1", member_id: "b" },
    { item_id: "i1", member_id: "c" },
  ];
  const r = compute({ members, items, claims });
  const a = settle(r, "a", "toPayer").transfers;
  const b = settle(r, "a", "minimal").transfers;
  assert.deepEqual(a, b);
});

test("settle: 沒指定墊款人回空轉帳", () => {
  const { members } = fixture();
  const r = compute({ members, items: [], claims: [] });
  assert.deepEqual(settle(r, null).transfers, []);
});
