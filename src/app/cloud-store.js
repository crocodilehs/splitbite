// 雲端狀態管理（Supabase + Realtime）— 取代 stage 1 的本機 store.js
//
// 對外的 state 形狀與本機 store.js 一致，故 calc.js 與 render 不需改動。
// 差異：mutator 為非同步（寫 Supabase），畫面更新由 Realtime → reload → emit 驅動。
//
// localStorage（§1）僅存：最近加入的 session（code）與「我在這場是誰」。

import { createClient } from "../vendor/supabase-js.js"; // 本地 vendor（npm run vendor 產生），不依賴 CDN
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { normalizeCode } from "../core/code.js";
import { normalizeOcrResult } from "../core/ocr.js";
import * as db from "./db.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const LS_RECENT = "splitbite.recent";

const EMPTY = () => ({
  status: "idle", // 'idle' | 'loading' | 'active' | 'error'
  error: null,
  code: null,
  sessionId: null,
  members: [],
  items: [],
  claims: [],
  adjustments: [],
  payer_id: null,
  ocr_total: null,
  ocrBusy: false,
  me: null,
  settleMode: "toPayer",
});

let state = EMPTY();
const listeners = new Set();
let channel = null;
let reloadTimer = null;

export function getState() {
  return state;
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn(state);
}
function setState(patch) {
  state = { ...state, ...patch };
  emit();
}

// ---- localStorage：最近 session 與「我是誰」 ----
function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(LS_RECENT) || "{}");
  } catch {
    return {};
  }
}
function saveRecent(patch) {
  const cur = loadRecent();
  localStorage.setItem(LS_RECENT, JSON.stringify({ ...cur, ...patch }));
}
function loadMe(sessionId) {
  const r = loadRecent();
  return r.sessionId === sessionId ? r.me || null : null;
}

// ---- session 生命週期 ----
export async function init() {
  const r = loadRecent();
  if (r.code) {
    try {
      await joinByCode(r.code);
      return;
    } catch {
      // 最近 session 已失效，回到 idle
    }
  }
  setState({ status: "idle" });
}

export async function createSession() {
  setState({ status: "loading", error: null });
  try {
    const s = await db.createSession(sb);
    saveRecent({ code: s.code, sessionId: s.id, me: null });
    await activate(s.id, s.code);
  } catch (e) {
    setState({ status: "error", error: e.message });
    throw e;
  }
}

export async function joinByCode(input) {
  const code = normalizeCode(input);
  setState({ status: "loading", error: null });
  const s = await db.getSessionByCode(sb, code);
  if (!s) {
    setState({ status: "idle", error: "找不到此加入碼" });
    throw new Error("找不到此加入碼");
  }
  saveRecent({ code: s.code, sessionId: s.id });
  await activate(s.id, s.code);
}

export function leaveSession() {
  if (channel) {
    sb.removeChannel(channel);
    channel = null;
  }
  localStorage.removeItem(LS_RECENT);
  state = EMPTY();
  emit();
}

async function activate(sessionId, code) {
  await reload(sessionId);
  setState({ status: "active", code, sessionId, me: loadMe(sessionId) });
  subscribeRealtime(sessionId);
}

async function reload(sessionId = state.sessionId) {
  if (!sessionId) return;
  const data = await db.loadSession(sb, sessionId);
  state = {
    ...state,
    sessionId,
    members: data.members,
    items: data.items,
    claims: data.claims,
    adjustments: data.adjustments,
    payer_id: data.session.payer_id,
    ocr_total: data.session.ocr_total ?? null,
  };
  emit();
}

function scheduleReload() {
  // 合併短時間內的多筆 Realtime 事件，避免重複抓取
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => reload().catch(() => {}), 120);
}

function subscribeRealtime(sessionId) {
  if (channel) sb.removeChannel(channel);
  const f = { schema: "public", filter: `session_id=eq.${sessionId}` };
  channel = sb
    .channel(`session-${sessionId}`)
    .on("postgres_changes", { event: "*", table: "members", ...f }, scheduleReload)
    .on("postgres_changes", { event: "*", table: "items", ...f }, scheduleReload)
    .on("postgres_changes", { event: "*", table: "adjustments", ...f }, scheduleReload)
    .on("postgres_changes", { event: "*", table: "sessions", schema: "public", filter: `id=eq.${sessionId}` }, scheduleReload)
    // claims 無 session_id 欄位，無法過濾，訂閱全部並重抓本場（低頻可接受）
    .on("postgres_changes", { event: "*", schema: "public", table: "claims" }, scheduleReload)
    .subscribe();
}

// ---- 本機偏好 ----
export function setMe(memberId) {
  saveRecent({ sessionId: state.sessionId, me: memberId });
  setState({ me: memberId });
}
export function setSettleMode(mode) {
  setState({ settleMode: mode === "minimal" ? "minimal" : "toPayer" });
}

// ---- mutator：樂觀更新（先改本機 state 立即重繪，再寫 Supabase）----
// 寫入成功後不需重抓：本機 state 已正確，且 Realtime 事件仍會觸發 reload 校正；
// 寫入失敗時以 resync() 重抓伺服器狀態還原畫面。
//
// 新增中的資料先掛暫時 id（tmp-*）；後續引用該 id 的操作（改名、認領、刪除…）
// 以 realId() 等 insert 回來的真 id 再寫入，避免使用者動作快於網路時掉寫入。
let tmpSeq = 0;
const tmpId = () => `tmp-${Date.now()}-${tmpSeq++}`;
const idWaiters = new Map(); // tmpId -> { promise, resolve, reject }
const resolvedIds = new Map(); // tmpId -> 真 id（同步查詢用；一場 session 的量很小）

// UI 若以 id 記狀態（展開、編輯中…），可用此函式把舊 tmp id 換成真 id
export function canonicalId(id) {
  return resolvedIds.get(id) || id;
}

function trackTmp(id) {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => {}); // 失敗由各操作自行處理，避免 unhandled rejection
  idWaiters.set(id, { promise, resolve, reject });
}
function realId(id) {
  const w = idWaiters.get(id);
  return w ? w.promise : Promise.resolve(id);
}

function resync(e) {
  setState({ error: e?.message || String(e) });
  reload().catch(() => {});
}

// insert 完成：以伺服器 row 換掉暫時 id，保留 temp 期間的本地編輯，
// 並同步改寫引用該 id 的 claims / payer / me。
function adopt(tempId, row, key) {
  const replace = (arr) => arr.map((x) => (x.id === tempId ? { ...row, ...x, id: row.id } : x));
  state = {
    ...state,
    [key]: replace(state[key]),
    claims: state.claims.map((c) => ({
      item_id: c.item_id === tempId ? row.id : c.item_id,
      member_id: c.member_id === tempId ? row.id : c.member_id,
    })),
    payer_id: state.payer_id === tempId ? row.id : state.payer_id,
    me: state.me === tempId ? row.id : state.me,
  };
  if (state.me === row.id) saveRecent({ sessionId: state.sessionId, me: row.id });
  emit();
  const w = idWaiters.get(tempId);
  // 映射要留著：先前快照過舊 tmp id 的操作（如 claimAll）之後仍會來查
  idWaiters.set(tempId, { promise: Promise.resolve(row.id) });
  resolvedIds.set(tempId, row.id);
  w?.resolve(row.id);
}

function abandon(tempId, e) {
  idWaiters.get(tempId)?.reject(e); // 已 reject 的 promise 留在 map，讓後續引用同樣失敗
}

export function addMember(name) {
  const clean = (name || "").trim();
  const temp = { id: tmpId(), session_id: state.sessionId, name: clean };
  trackTmp(temp.id);
  const isFirst = state.members.length === 0 && !state.me;
  setState({ members: [...state.members, temp] });
  if (isFirst) setMe(temp.id); // 第一位新增的成員預設就是「我」
  return db
    .addMember(sb, state.sessionId, clean)
    .then((row) => adopt(temp.id, row, "members"))
    .catch((e) => {
      abandon(temp.id, e);
      setState({
        members: state.members.filter((m) => m.id !== temp.id),
        claims: state.claims.filter((c) => c.member_id !== temp.id),
      });
      if (state.me === temp.id) setMe(null);
      resync(e);
    });
}

export function renameMember(id, name) {
  const clean = (name || "").trim();
  setState({ members: state.members.map((m) => (m.id === id ? { ...m, name: clean } : m)) });
  return realId(id)
    .then((rid) => db.renameMember(sb, rid, clean))
    .catch(resync);
}

export function removeMember(id) {
  setState({
    members: state.members.filter((m) => m.id !== id),
    claims: state.claims.filter((c) => c.member_id !== id),
    payer_id: state.payer_id === id ? null : state.payer_id,
  });
  if (state.me === id) setMe(null);
  return realId(id)
    .then((rid) => db.removeMember(sb, rid))
    .catch(resync);
}

export function addItem(item) {
  const temp = {
    id: tmpId(),
    session_id: state.sessionId,
    name: item.name || "",
    qty: Math.trunc(Number(item.qty)) || 1,
    unit_price: Math.trunc(Number(item.unit_price)) || 0,
    confidence: null,
  };
  trackTmp(temp.id);
  setState({ items: [...state.items, temp] });
  return db
    .addItem(sb, state.sessionId, item)
    .then((row) => adopt(temp.id, row, "items"))
    .catch((e) => {
      abandon(temp.id, e);
      setState({
        items: state.items.filter((it) => it.id !== temp.id),
        claims: state.claims.filter((c) => c.item_id !== temp.id),
      });
      resync(e);
    });
}

export function updateItem(id, patch) {
  setState({ items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  return realId(id)
    .then((rid) => db.updateItem(sb, rid, patch))
    .catch(resync);
}

export function removeItem(id) {
  setState({
    items: state.items.filter((it) => it.id !== id),
    claims: state.claims.filter((c) => c.item_id !== id),
  });
  return realId(id)
    .then((rid) => db.removeItem(sb, rid))
    .catch(resync);
}

export function isClaimed(itemId, memberId) {
  return state.claims.some((c) => c.item_id === itemId && c.member_id === memberId);
}

export function toggleClaim(itemId, memberId) {
  const on = isClaimed(itemId, memberId);
  setState({
    claims: on
      ? state.claims.filter((c) => !(c.item_id === itemId && c.member_id === memberId))
      : [...state.claims, { item_id: itemId, member_id: memberId }],
  });
  return Promise.all([realId(itemId), realId(memberId)])
    .then(([i, m]) => (on ? db.removeClaim(sb, i, m) : db.addClaim(sb, i, m)))
    .catch(resync);
}

export function claimAll(itemId) {
  const members = state.members;
  setState({
    claims: [
      ...state.claims.filter((c) => c.item_id !== itemId),
      ...members.map((m) => ({ item_id: itemId, member_id: m.id })),
    ],
  });
  return realId(itemId)
    .then(async (i) => {
      await db.clearClaims(sb, i);
      await Promise.all(members.map(async (m) => db.addClaim(sb, i, await realId(m.id))));
    })
    .catch(resync);
}

export function clearClaims(itemId) {
  setState({ claims: state.claims.filter((c) => c.item_id !== itemId) });
  return realId(itemId)
    .then((i) => db.clearClaims(sb, i))
    .catch(resync);
}

export function addAdjustment(adj) {
  const temp = { id: tmpId(), session_id: state.sessionId, ...adj };
  trackTmp(temp.id);
  setState({ adjustments: [...state.adjustments, temp] });
  return db
    .addAdjustment(sb, state.sessionId, adj)
    .then((row) => adopt(temp.id, row, "adjustments"))
    .catch((e) => {
      abandon(temp.id, e);
      setState({ adjustments: state.adjustments.filter((a) => a.id !== temp.id) });
      resync(e);
    });
}

export function updateAdjustment(id, patch) {
  setState({ adjustments: state.adjustments.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  return realId(id)
    .then((rid) => db.updateAdjustment(sb, rid, patch))
    .catch(resync);
}

export function removeAdjustment(id) {
  setState({ adjustments: state.adjustments.filter((a) => a.id !== id) });
  return realId(id)
    .then((rid) => db.removeAdjustment(sb, rid))
    .catch(resync);
}

export function setPayer(id) {
  setState({ payer_id: id });
  return realId(id)
    .then((rid) => db.setPayer(sb, state.sessionId, rid))
    .catch(resync);
}

// ---- OCR：上傳收據 → Edge Function（Gemini）→ 寫入品項與收據總額 ----
// base64：不含 dataURL 前綴的影像內容（main.js 已縮圖壓縮）
export async function ocrReceipt(base64, mime) {
  setState({ ocrBusy: true, error: null });
  try {
    const { data, error } = await sb.functions.invoke("ocr", { body: { image: base64, mime } });
    if (error) {
      // FunctionsHttpError：讀函式回的 { error } 訊息
      const detail = await error.context?.json?.().catch(() => null);
      throw new Error(detail?.error || "OCR 服務呼叫失敗");
    }
    const { items, total } = normalizeOcrResult(data);
    if (items.length === 0) throw new Error("辨識不到品項，請拍清楚一點或手動輸入");
    for (const it of items) await db.addItem(sb, state.sessionId, it);
    if (total != null) await db.setOcrTotal(sb, state.sessionId, total);
    await reload();
    return items.length;
  } catch (e) {
    setState({ error: e.message });
    throw e;
  } finally {
    setState({ ocrBusy: false });
  }
}
