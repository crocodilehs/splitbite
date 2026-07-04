// Supabase 資料存取層（環境無關）
//
// 每個函式都接受一個 @supabase/supabase-js client（sb）作為第一參數，
// 因此瀏覽器 store 與 Node 整合測試可共用同一套邏輯。
// 回傳的資料形狀對應 §3 資料模型，與本機 store.js 一致，
// 故 calc.js 與 UI 不需改動。

import { generateUniqueCode } from "../core/code.js";

// 建立 session：產生不碰撞的加入碼後 insert（§3、§8）
export async function createSession(sb) {
  const existsFn = async (code) => {
    const { data, error } = await sb.from("sessions").select("id").eq("code", code).maybeSingle();
    if (error) throw error;
    return !!data;
  };
  const code = await generateUniqueCode(existsFn);
  const { data, error } = await sb.from("sessions").insert({ code }).select().single();
  if (error) throw error;
  return data; // { id, code, payer_id, created_at }
}

export async function getSessionByCode(sb, code) {
  const { data, error } = await sb.from("sessions").select("*").eq("code", code).maybeSingle();
  if (error) throw error;
  return data; // null 表示查無此 session
}

// 撈整場資料（members / items / claims / adjustments + session 本身）
export async function loadSession(sb, sessionId) {
  const [session, members, items, adjustments] = await Promise.all([
    sb.from("sessions").select("*").eq("id", sessionId).single(),
    sb.from("members").select("*").eq("session_id", sessionId).order("id"),
    sb.from("items").select("*").eq("session_id", sessionId).order("id"),
    sb.from("adjustments").select("*").eq("session_id", sessionId).order("id"),
  ]);
  for (const r of [session, members, items, adjustments]) if (r.error) throw r.error;

  const itemIds = items.data.map((i) => i.id);
  let claims = [];
  if (itemIds.length) {
    const res = await sb.from("claims").select("*").in("item_id", itemIds);
    if (res.error) throw res.error;
    claims = res.data;
  }

  return {
    session: session.data,
    members: members.data,
    items: items.data,
    claims: claims.map((c) => ({ item_id: c.item_id, member_id: c.member_id })),
    adjustments: adjustments.data,
  };
}

// ---- members ----
export async function addMember(sb, sessionId, name) {
  const { data, error } = await sb
    .from("members")
    .insert({ session_id: sessionId, name: (name || "").trim() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function renameMember(sb, id, name) {
  const { error } = await sb.from("members").update({ name: (name || "").trim() }).eq("id", id);
  if (error) throw error;
}

export async function removeMember(sb, id) {
  const { error } = await sb.from("members").delete().eq("id", id);
  if (error) throw error;
}

// ---- items ----
export async function addItem(sb, sessionId, { name = "", qty = 1, unit_price = 0, confidence = null } = {}) {
  const row = { session_id: sessionId, name, qty: toInt(qty, 1), unit_price: toInt(unit_price, 0) };
  if (confidence != null) row.confidence = confidence; // OCR 信心（'high'|'low'），人工輸入不帶
  const { data, error } = await sb.from("items").insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function updateItem(sb, id, patch) {
  const clean = {};
  if ("name" in patch) clean.name = patch.name;
  if ("qty" in patch) clean.qty = toInt(patch.qty, 1);
  if ("unit_price" in patch) clean.unit_price = toInt(patch.unit_price, 0);
  const { error } = await sb.from("items").update(clean).eq("id", id);
  if (error) throw error;
}

export async function removeItem(sb, id) {
  const { error } = await sb.from("items").delete().eq("id", id);
  if (error) throw error;
}

// ---- claims ----
export async function addClaim(sb, itemId, memberId) {
  // unique(item_id, member_id)：重複時忽略
  const { error } = await sb
    .from("claims")
    .upsert({ item_id: itemId, member_id: memberId }, { onConflict: "item_id,member_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function removeClaim(sb, itemId, memberId) {
  const { error } = await sb.from("claims").delete().eq("item_id", itemId).eq("member_id", memberId);
  if (error) throw error;
}

export async function clearClaims(sb, itemId) {
  const { error } = await sb.from("claims").delete().eq("item_id", itemId);
  if (error) throw error;
}

// ---- adjustments ----
export async function addAdjustment(sb, sessionId, { label = "", mode = "percent", value = 0 } = {}) {
  const { data, error } = await sb
    .from("adjustments")
    .insert({ session_id: sessionId, label, mode: mode === "fixed" ? "fixed" : "percent", value: Number(value) || 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateAdjustment(sb, id, patch) {
  const clean = {};
  if ("label" in patch) clean.label = patch.label;
  if ("mode" in patch) clean.mode = patch.mode === "fixed" ? "fixed" : "percent";
  if ("value" in patch) clean.value = Number(patch.value) || 0;
  const { error } = await sb.from("adjustments").update(clean).eq("id", id);
  if (error) throw error;
}

export async function removeAdjustment(sb, id) {
  const { error } = await sb.from("adjustments").delete().eq("id", id);
  if (error) throw error;
}

// ---- settlement ----
export async function setPayer(sb, sessionId, memberId) {
  const { error } = await sb.from("sessions").update({ payer_id: memberId }).eq("id", sessionId);
  if (error) throw error;
}

// OCR 讀到的收據總額（階段 3 寫入，結算頁對帳用）
export async function setOcrTotal(sb, sessionId, total) {
  const { error } = await sb.from("sessions").update({ ocr_total: toInt(total, null) }).eq("id", sessionId);
  if (error) throw error;
}

function toInt(v, fallback) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}
