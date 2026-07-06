// Supabase 整合測試（端到端：schema + RLS + Realtime）
//
// 預設略過，避免離線跑 `npm test` 失敗。實測時：
//   SPLITBITE_LIVE=1 npm test
// 並需：(1) 已套用 supabase/schema.sql + supabase/rls.sql
//        (2) 本環境 egress 允許連線到 Supabase 主機
// URL/anon key 取自環境變數，否則退回 src/app/config.js。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const LIVE = process.env.SPLITBITE_LIVE === "1";

import { createClient } from "@supabase/supabase-js";
import * as db from "../src/app/db.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../src/app/config.js";

const URL = process.env.SUPABASE_URL || SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;

let sb;
let session;

before(async () => {
  if (!LIVE) return;
  sb = createClient(URL, KEY, { realtime: { params: { eventsPerSecond: 10 } } });
});

after(async () => {
  if (!LIVE || !session) return;
  await sb.from("sessions").delete().eq("id", session.id); // cascade 清掉子表
});

test("createSession 產生唯一加入碼並寫入", { skip: !LIVE }, async () => {
  session = await db.createSession(sb);
  assert.ok(session.id);
  assert.equal(session.code.length, 6);

  const found = await db.getSessionByCode(sb, session.code);
  assert.equal(found.id, session.id);
});

test("Realtime：A 裝置新增成員，B 裝置即時收到", { skip: !LIVE }, async () => {
  assert.ok(session, "前置失敗：createSession 未成功（見上一測試）");
  const sbB = createClient(URL, KEY);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime 逾時：未收到 members 變更")), 8000);
    sbB
      .channel(`s-${session.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "members", filter: `session_id=eq.${session.id}` },
        (payload) => {
          clearTimeout(timer);
          resolve(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          db.addMember(sb, session.id, "Amy").catch(reject);
        }
      });
  });
  const row = await received;
  assert.equal(row.name, "Amy");
  await sbB.removeAllChannels();
});

test("品項 / 認領 / 調整 / 墊款人 寫入與讀回一致", { skip: !LIVE }, async () => {
  assert.ok(session, "前置失敗：createSession 未成功（見上一測試）");
  const members = (await sb.from("members").select("*").eq("session_id", session.id)).data;
  let amy = members[0];
  const bob = await db.addMember(sb, session.id, "Bob");

  const item = await db.addItem(sb, session.id, { name: "牛排", qty: 1, unit_price: 500 });
  await db.addClaim(sb, item.id, amy.id);
  await db.addClaim(sb, item.id, amy.id); // 重複認領應被忽略（unique）

  await db.addAdjustment(sb, session.id, { label: "服務費", mode: "percent", value: 10 });
  await db.setPayer(sb, session.id, bob.id);

  const loaded = await db.loadSession(sb, session.id);
  assert.equal(loaded.members.length, 2);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].name, "牛排");
  assert.equal(loaded.claims.filter((c) => c.item_id === item.id && c.member_id === amy.id).length, 1);
  assert.equal(loaded.adjustments.length, 1);
  assert.equal(loaded.session.payer_id, bob.id);

  // 取消認領
  await db.removeClaim(sb, item.id, amy.id);
  const after = await db.loadSession(sb, session.id);
  assert.equal(after.claims.length, 0);
});
