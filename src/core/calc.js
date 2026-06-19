import { splitEqual, splitByWeight } from "./split.js";

// 完整計算流程（規格 §4.5）
//
// 輸入（皆為 plain object 陣列，欄位對應 §3 資料模型）：
//   members     : [{ id, name }]
//   items       : [{ id, name, qty, unit_price }]
//   claims      : [{ item_id, member_id }]          // 誰認領哪個品項，可多人均分
//   adjustments : [{ id, label, mode, value }]      // mode: 'percent' | 'fixed'
//
// 回傳：
//   {
//     perMember: [{ id, name, subtotal, adjustment, total }],
//     itemsTotal,          // 所有品項總額（含未認領）
//     claimedTotal,        // 已認領品項總額
//     unclaimedTotal,      // 未認領品項總額
//     adjustmentTotal,     // 調整總額（已分攤者）
//     grandTotal,          // 結算斷言用：claimedTotal + adjustmentTotal
//     adjustmentBreakdown, // [{ id, label, amount }]
//     unclaimedItems,      // [{ id, name, amount }] 仍待認領
//     lowConfidenceItems,  // 由呼叫端標記（此處保留空陣列）
//   }
//
// 注意：規格 §4.5 step 5 的驗算斷言在此實作，任何餘數處理錯誤會被即時捕捉。
export function compute({ members = [], items = [], claims = [], adjustments = [] }) {
  const memberIndex = new Map(members.map((m, i) => [m.id, i]));
  const subtotals = new Array(members.length).fill(0);

  // 1 + 2：每品項總價由認領者均分（§4.2 補位法）
  let itemsTotal = 0;
  let claimedTotal = 0;
  const unclaimedItems = [];

  for (const item of items) {
    const itemTotal = toInt(item.qty) * toInt(item.unit_price);
    itemsTotal += itemTotal;

    // 該品項的認領者（依 members 順序固定，補位才有穩定的「前幾人」）
    const claimerIdxs = claims
      .filter((c) => c.item_id === item.id && memberIndex.has(c.member_id))
      .map((c) => memberIndex.get(c.member_id));
    const uniqueIdxs = [...new Set(claimerIdxs)].sort((a, b) => a - b);

    if (uniqueIdxs.length === 0) {
      unclaimedItems.push({ id: item.id, name: item.name, amount: itemTotal });
      continue;
    }

    claimedTotal += itemTotal;
    const shares = splitEqual(itemTotal, uniqueIdxs.length);
    uniqueIdxs.forEach((idx, k) => {
      subtotals[idx] += shares[k];
    });
  }

  // 3：服務費/折扣按品項小計占比分攤（§4.3 + §4.2 補位）
  const adjustmentAmounts = new Array(members.length).fill(0);
  const adjustmentBreakdown = [];
  let adjustmentTotal = 0;

  for (const adj of adjustments) {
    const amount =
      adj.mode === "percent"
        ? Math.round((claimedTotal * toNum(adj.value)) / 100)
        : Math.round(toNum(adj.value));
    if (amount === 0) {
      adjustmentBreakdown.push({ id: adj.id, label: adj.label, amount: 0 });
      continue;
    }
    const shares = splitByWeight(amount, subtotals);
    shares.forEach((s, i) => {
      adjustmentAmounts[i] += s;
    });
    adjustmentTotal += amount;
    adjustmentBreakdown.push({ id: adj.id, label: adj.label, amount });
  }

  // 4：每人應付 = 品項小計 + 調整額
  const perMember = members.map((m, i) => ({
    id: m.id,
    name: m.name,
    subtotal: subtotals[i],
    adjustment: adjustmentAmounts[i],
    total: subtotals[i] + adjustmentAmounts[i],
  }));

  const grandTotal = claimedTotal + adjustmentTotal;

  // 5：驗算斷言 — Σ每人應付 必須等於 已認領總額 + 調整總額
  const sum = perMember.reduce((a, p) => a + p.total, 0);
  if (sum !== grandTotal) {
    throw new Error(
      `計算驗算失敗：Σ每人應付(${sum}) !== 已認領+調整(${grandTotal})。餘數處理可能有 bug。`
    );
  }

  return {
    perMember,
    itemsTotal,
    claimedTotal,
    unclaimedTotal: itemsTotal - claimedTotal,
    adjustmentTotal,
    grandTotal,
    adjustmentBreakdown,
    unclaimedItems,
  };
}

// 結算：產生轉帳清單（規格 §5）
//
// mode:
//   'toPayer'  — 全還給墊款人（預設）：每位非墊款人 → 付給唯一墊款人
//   'minimal'  — 最小化轉帳：目前單一墊款人，結果與 toPayer 相同；
//                保留介面以利日後支援多付款人
//
// 回傳 { transfers: [{ from, fromName, to, toName, amount }], payerId }
export function settle(computed, payerId, mode = "toPayer") {
  const { perMember } = computed;
  const payer = perMember.find((p) => p.id === payerId);
  const transfers = [];

  if (!payer) {
    return { transfers, payerId, mode };
  }

  for (const p of perMember) {
    if (p.id === payerId) continue;
    if (p.total <= 0) continue;
    transfers.push({
      from: p.id,
      fromName: p.name,
      to: payerId,
      toName: payer.name,
      amount: p.total,
    });
  }

  // 'minimal' 在單一墊款人下與 'toPayer' 等價（§5）
  return { transfers, payerId, mode };
}

function toInt(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
