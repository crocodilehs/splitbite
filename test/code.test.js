import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCode,
  generateUniqueCode,
  normalizeCode,
  isValidCode,
  CODE_LENGTH,
  CODE_ALPHABET,
} from "../src/core/code.js";

test("generateCode: 長度與字元集正確", () => {
  for (let i = 0; i < 500; i++) {
    const c = generateCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.ok([...c].every((ch) => CODE_ALPHABET.includes(ch)), `非法字元: ${c}`);
  }
});

test("generateCode: 不含易混淆字元 0 O 1 I L", () => {
  for (let i = 0; i < 500; i++) {
    const c = generateCode();
    assert.ok(!/[0O1IL]/.test(c), `含易混淆字元: ${c}`);
  }
});

test("generateUniqueCode: 碰撞時重試直到取得未使用碼（§8）", async () => {
  const used = new Set();
  // 前兩次都假裝碰撞，第三次才放行
  let calls = 0;
  const existsFn = () => {
    calls++;
    return calls <= 2; // 前兩個碼視為已存在
  };
  const code = await generateUniqueCode(existsFn);
  assert.equal(calls, 3);
  assert.ok(isValidCode(code));
  used.add(code);
});

test("generateUniqueCode: 持續碰撞超過上限丟錯", async () => {
  await assert.rejects(() => generateUniqueCode(() => true, { maxTries: 5 }), /碰撞/);
});

test("generateUniqueCode: 支援非同步 existsFn", async () => {
  let first = true;
  const existsFn = async () => {
    await Promise.resolve();
    if (first) {
      first = false;
      return true;
    }
    return false;
  };
  const code = await generateUniqueCode(existsFn);
  assert.ok(isValidCode(code));
});

test("normalizeCode: 去空白/連字號並轉大寫", () => {
  assert.equal(normalizeCode(" ab2-3x y "), "AB23XY");
  assert.equal(normalizeCode("abc234"), "ABC234");
});

test("isValidCode: 正確長度與字元才有效", () => {
  assert.equal(isValidCode("ABC234"), true);
  assert.equal(isValidCode("abc234"), true); // 會正規化
  assert.equal(isValidCode("ABC23"), false); // 太短
  assert.equal(isValidCode("ABC2340"), false); // 太長
  assert.equal(isValidCode("ABC23O"), false); // 含字母表外字元 O
});
