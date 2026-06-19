// 階段 1：本機狀態管理（純前端，無 Supabase）
//
// 整場 session 暫存於 localStorage。階段 2 接 Supabase 後，
// 這層會被 supabase-js + Realtime 取代，但對外的 state 形狀維持不變，
// 讓 calc.js 與 UI 不需改動。

const KEY = "splitbite.local.v1";

const DEFAULT_STATE = () => ({
  members: [],
  items: [],
  claims: [], // { item_id, member_id }
  adjustments: [], // { id, label, mode, value }
  payer_id: null,
  me: null, // 「我在這場是誰」的 member id
  settleMode: "toPayer",
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_STATE(), ...JSON.parse(raw) };
  } catch (_) {}
  return DEFAULT_STATE();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (_) {}
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  persist();
  for (const fn of listeners) fn(state);
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---- members ----
export function addMember(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const m = { id: uid(), name: trimmed };
  state.members.push(m);
  emit();
  return m;
}

export function renameMember(id, name) {
  const m = state.members.find((x) => x.id === id);
  if (m) {
    m.name = (name || "").trim() || m.name;
    emit();
  }
}

export function removeMember(id) {
  state.members = state.members.filter((m) => m.id !== id);
  state.claims = state.claims.filter((c) => c.member_id !== id);
  if (state.payer_id === id) state.payer_id = null;
  if (state.me === id) state.me = null;
  emit();
}

export function setMe(id) {
  state.me = id;
  emit();
}

// ---- items ----
export function addItem({ name = "", qty = 1, unit_price = 0 } = {}) {
  const it = { id: uid(), name, qty: toInt(qty, 1), unit_price: toInt(unit_price, 0) };
  state.items.push(it);
  emit();
  return it;
}

export function updateItem(id, patch) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  if ("name" in patch) it.name = patch.name;
  if ("qty" in patch) it.qty = toInt(patch.qty, it.qty);
  if ("unit_price" in patch) it.unit_price = toInt(patch.unit_price, it.unit_price);
  emit();
}

export function removeItem(id) {
  state.items = state.items.filter((x) => x.id !== id);
  state.claims = state.claims.filter((c) => c.item_id !== id);
  emit();
}

// ---- claims ----
export function toggleClaim(item_id, member_id) {
  const idx = state.claims.findIndex((c) => c.item_id === item_id && c.member_id === member_id);
  if (idx >= 0) state.claims.splice(idx, 1);
  else state.claims.push({ item_id, member_id });
  emit();
}

export function claimAll(item_id) {
  // 全選：全體共享（火鍋湯底、桌邊小菜等）
  state.claims = state.claims.filter((c) => c.item_id !== item_id);
  for (const m of state.members) state.claims.push({ item_id, member_id: m.id });
  emit();
}

export function clearClaims(item_id) {
  state.claims = state.claims.filter((c) => c.item_id !== item_id);
  emit();
}

export function isClaimed(item_id, member_id) {
  return state.claims.some((c) => c.item_id === item_id && c.member_id === member_id);
}

// ---- adjustments ----
export function addAdjustment({ label = "服務費", mode = "percent", value = 10 } = {}) {
  const a = { id: uid(), label, mode, value: Number(value) || 0 };
  state.adjustments.push(a);
  emit();
  return a;
}

export function updateAdjustment(id, patch) {
  const a = state.adjustments.find((x) => x.id === id);
  if (!a) return;
  if ("label" in patch) a.label = patch.label;
  if ("mode" in patch) a.mode = patch.mode === "fixed" ? "fixed" : "percent";
  if ("value" in patch) a.value = Number(patch.value) || 0;
  emit();
}

export function removeAdjustment(id) {
  state.adjustments = state.adjustments.filter((x) => x.id !== id);
  emit();
}

// ---- settlement ----
export function setPayer(id) {
  state.payer_id = id;
  emit();
}

export function setSettleMode(mode) {
  state.settleMode = mode === "minimal" ? "minimal" : "toPayer";
  emit();
}

export function resetAll() {
  state = DEFAULT_STATE();
  emit();
}

function toInt(v, fallback) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
}
