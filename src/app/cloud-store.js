// 雲端狀態管理（Supabase + Realtime）— 取代 stage 1 的本機 store.js
//
// 對外的 state 形狀與本機 store.js 一致，故 calc.js 與 render 不需改動。
// 差異：mutator 為非同步（寫 Supabase），畫面更新由 Realtime → reload → emit 驅動。
//
// localStorage（§1）僅存：最近加入的 session（code）與「我在這場是誰」。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { normalizeCode } from "../core/code.js";
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

// ---- mutator：寫 Supabase 後重抓（Realtime 也會觸發，重抓為冪等）----
const run = (p) => p.then(() => reload()).catch((e) => setState({ error: e.message }));

export const addMember = (name) => run(db.addMember(sb, state.sessionId, name));
export const renameMember = (id, name) => run(db.renameMember(sb, id, name));
export const removeMember = (id) => run(db.removeMember(sb, id));

export const addItem = (item) => run(db.addItem(sb, state.sessionId, item));
export const updateItem = (id, patch) => run(db.updateItem(sb, id, patch));
export const removeItem = (id) => run(db.removeItem(sb, id));

export function isClaimed(itemId, memberId) {
  return state.claims.some((c) => c.item_id === itemId && c.member_id === memberId);
}
export const toggleClaim = (itemId, memberId) =>
  isClaimed(itemId, memberId)
    ? run(db.removeClaim(sb, itemId, memberId))
    : run(db.addClaim(sb, itemId, memberId));
export const claimAll = (itemId) =>
  run(
    db.clearClaims(sb, itemId).then(() =>
      Promise.all(state.members.map((m) => db.addClaim(sb, itemId, m.id)))
    )
  );
export const clearClaims = (itemId) => run(db.clearClaims(sb, itemId));

export const addAdjustment = (adj) => run(db.addAdjustment(sb, state.sessionId, adj));
export const updateAdjustment = (id, patch) => run(db.updateAdjustment(sb, id, patch));
export const removeAdjustment = (id) => run(db.removeAdjustment(sb, id));

export const setPayer = (id) => run(db.setPayer(sb, state.sessionId, id));
