import { compute, settle } from "../core/calc.js";
import * as store from "./store.js";

const app = document.getElementById("app");

function money(n) {
  return `$${n.toLocaleString("en-US")}`;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function render() {
  const s = store.getState();
  app.innerHTML = "";
  app.append(renderMembers(s), renderItems(s), renderAdjustments(s), renderSettlement(s));
}

// ---------- Members ----------
function renderMembers(s) {
  const sec = el(`<section class="card"><h2>👥 成員</h2></section>`);
  const list = el(`<div class="member-chips"></div>`);
  for (const m of s.members) {
    const chip = el(
      `<span class="chip ${s.me === m.id ? "is-me" : ""}">
         <button class="chip-name" data-act="setMe" data-id="${m.id}">${m.name}${s.me === m.id ? " ⭐" : ""}</button>
         <button class="chip-x" data-act="rmMember" data-id="${m.id}" aria-label="刪除">×</button>
       </span>`
    );
    list.append(chip);
  }
  sec.append(list);

  const form = el(
    `<form class="row" data-act="addMember">
       <input name="name" placeholder="新增成員名字" autocomplete="off" />
       <button type="submit">＋</button>
     </form>`
  );
  sec.append(form);
  sec.append(el(`<p class="hint">點名字＝設定「我是誰」（⭐）。階段 1 為本機示範。</p>`));
  return sec;
}

// ---------- Items ----------
function renderItems(s) {
  const sec = el(`<section class="card"><h2>🧾 品項與認領</h2></section>`);

  if (s.members.length === 0) {
    sec.append(el(`<p class="hint">先新增成員，才能認領品項。</p>`));
  }

  for (const it of s.items) {
    sec.append(renderItemRow(s, it));
  }

  const form = el(
    `<form class="row item-add" data-act="addItem">
       <input name="name" placeholder="品名" autocomplete="off" />
       <input name="qty" type="number" min="1" value="1" inputmode="numeric" />
       <input name="unit_price" type="number" min="0" value="0" inputmode="numeric" />
       <button type="submit">＋</button>
     </form>`
  );
  sec.append(el(`<p class="hint">欄位：品名 / 數量 / 單價</p>`));
  sec.append(form);
  return sec;
}

function renderItemRow(s, it) {
  const total = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
  const wrap = el(`<div class="item"></div>`);

  const head = el(
    `<div class="item-head">
       <input class="item-name" data-act="editItem" data-id="${it.id}" data-field="name" value="${escapeAttr(it.name)}" placeholder="品名" />
       <input class="item-num" data-act="editItem" data-id="${it.id}" data-field="qty" type="number" min="1" value="${it.qty}" inputmode="numeric" />
       <span class="x">×</span>
       <input class="item-num" data-act="editItem" data-id="${it.id}" data-field="unit_price" type="number" min="0" value="${it.unit_price}" inputmode="numeric" />
       <span class="item-total">= ${money(total)}</span>
       <button class="item-del" data-act="rmItem" data-id="${it.id}" aria-label="刪除品項">🗑</button>
     </div>`
  );
  wrap.append(head);

  // 認領大按鈕（整列）
  const claimers = s.members.filter((m) => store.isClaimed(it.id, m.id));
  const claimRow = el(`<div class="claims"></div>`);
  for (const m of s.members) {
    const on = store.isClaimed(it.id, m.id);
    claimRow.append(
      el(
        `<button class="claim-btn ${on ? "on" : ""}" data-act="toggleClaim" data-item="${it.id}" data-member="${m.id}">${m.name}</button>`
      )
    );
  }
  wrap.append(claimRow);

  const tools = el(
    `<div class="claim-tools">
       <button class="link" data-act="claimAll" data-item="${it.id}">全選（全體均分）</button>
       <button class="link" data-act="clearClaims" data-item="${it.id}">清除</button>
       ${
         claimers.length > 1
           ? `<span class="split-note">${claimers.length} 人均分，每人約 ${money(Math.floor(total / claimers.length))}（餘數補前幾人）</span>`
           : ""
       }
     </div>`
  );
  wrap.append(tools);
  return wrap;
}

// ---------- Adjustments ----------
function renderAdjustments(s) {
  const sec = el(`<section class="card"><h2>➕ 服務費 / 折扣</h2></section>`);
  for (const a of s.adjustments) {
    sec.append(
      el(
        `<div class="row adj">
           <input data-act="editAdj" data-id="${a.id}" data-field="label" value="${escapeAttr(a.label)}" />
           <select data-act="editAdj" data-id="${a.id}" data-field="mode">
             <option value="percent" ${a.mode === "percent" ? "selected" : ""}>%</option>
             <option value="fixed" ${a.mode === "fixed" ? "selected" : ""}>固定</option>
           </select>
           <input data-act="editAdj" data-id="${a.id}" data-field="value" type="number" value="${a.value}" inputmode="numeric" />
           <button class="item-del" data-act="rmAdj" data-id="${a.id}">🗑</button>
         </div>`
      )
    );
  }
  sec.append(
    el(
      `<div class="row">
         <button class="link" data-act="addAdj" data-mode="percent">＋服務費 10%</button>
         <button class="link" data-act="addAdj" data-mode="fixed">＋折扣</button>
       </div>`
    )
  );
  sec.append(el(`<p class="hint">折扣請填負數。按品項小計占比分攤。</p>`));
  return sec;
}

// ---------- Settlement ----------
function renderSettlement(s) {
  const sec = el(`<section class="card result"><h2>💰 結算</h2></section>`);

  let result;
  try {
    result = compute(s);
  } catch (e) {
    sec.append(el(`<p class="error">計算錯誤：${escapeHtml(e.message)}</p>`));
    return sec;
  }

  // 墊款人選擇
  const payerRow = el(`<div class="row payer"><label>墊款人：</label></div>`);
  const sel = el(`<select data-act="setPayer"></select>`);
  sel.append(el(`<option value="">— 請選擇 —</option>`));
  for (const m of s.members) {
    sel.append(el(`<option value="${m.id}" ${s.payer_id === m.id ? "selected" : ""}>${m.name}</option>`));
  }
  payerRow.append(sel);
  sec.append(payerRow);

  // 每人應付
  const table = el(`<div class="owe-table"></div>`);
  for (const p of result.perMember) {
    table.append(
      el(
        `<div class="owe-row">
           <span class="owe-name">${p.name}</span>
           <span class="owe-detail">小計 ${money(p.subtotal)}${p.adjustment ? ` ${p.adjustment > 0 ? "+" : "−"}${money(Math.abs(p.adjustment))}` : ""}</span>
           <span class="owe-total">${money(p.total)}</span>
         </div>`
      )
    );
  }
  sec.append(table);

  // 總額與未認領提示
  sec.append(
    el(
      `<div class="totals">
         <span>已認領 ${money(result.claimedTotal)}</span>
         ${result.adjustmentTotal ? `<span>調整 ${money(result.adjustmentTotal)}</span>` : ""}
         <span class="grand">合計 ${money(result.grandTotal)}</span>
       </div>`
    )
  );
  if (result.unclaimedTotal > 0) {
    sec.append(
      el(`<p class="warn">⚠️ 尚有 ${money(result.unclaimedTotal)} 未認領（${result.unclaimedItems.map((i) => escapeHtml(i.name || "未命名")).join("、")}）</p>`)
    );
  }

  // 結算模式切換
  const modeRow = el(
    `<div class="seg">
       <button data-act="setMode" data-mode="toPayer" class="${s.settleMode === "toPayer" ? "on" : ""}">全還給墊款人</button>
       <button data-act="setMode" data-mode="minimal" class="${s.settleMode === "minimal" ? "on" : ""}">最小化轉帳</button>
     </div>`
  );
  sec.append(modeRow);

  // 轉帳清單
  const { transfers } = settle(result, s.payer_id, s.settleMode);
  if (!s.payer_id) {
    sec.append(el(`<p class="hint">選擇墊款人後顯示轉帳明細。</p>`));
  } else if (transfers.length === 0) {
    sec.append(el(`<p class="hint">目前沒有人需要轉帳給墊款人。</p>`));
  } else {
    const tl = el(`<div class="transfers"></div>`);
    for (const t of transfers) {
      tl.append(el(`<div class="transfer">${t.fromName} → <b>${t.toName}</b> <span>${money(t.amount)}</span></div>`));
    }
    sec.append(tl);
    sec.append(el(`<button class="share" data-act="share">📋 複製分帳結果</button>`));
  }

  // 危險操作
  sec.append(el(`<button class="reset" data-act="resetAll">清空全部</button>`));
  return sec;
}

function shareText() {
  const s = store.getState();
  const result = compute(s);
  const { transfers } = settle(result, s.payer_id, s.settleMode);
  const payer = s.members.find((m) => m.id === s.payer_id);
  const lines = ["🍽️ SplitBite 分帳結果", ""];
  for (const p of result.perMember) lines.push(`${p.name}：${money(p.total)}`);
  lines.push("", `墊款人：${payer ? payer.name : "（未指定）"}`);
  if (transfers.length) {
    lines.push("");
    for (const t of transfers) lines.push(`${t.fromName} → ${t.toName} ${money(t.amount)}`);
  }
  lines.push("", `合計 ${money(result.grandTotal)}`);
  return lines.join("\n");
}

// ---------- Event delegation ----------
app.addEventListener("submit", (e) => {
  const act = e.target.dataset.act;
  if (act === "addMember") {
    e.preventDefault();
    const input = e.target.querySelector('[name="name"]');
    store.addMember(input.value);
    input.value = "";
  } else if (act === "addItem") {
    e.preventDefault();
    const f = e.target;
    store.addItem({
      name: f.name.value,
      qty: f.qty.value,
      unit_price: f.unit_price.value,
    });
    f.name.value = "";
    f.qty.value = "1";
    f.unit_price.value = "0";
    f.name.focus();
  }
});

app.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  switch (act) {
    case "setMe":
      store.setMe(btn.dataset.id);
      break;
    case "rmMember":
      store.removeMember(btn.dataset.id);
      break;
    case "rmItem":
      store.removeItem(btn.dataset.id);
      break;
    case "toggleClaim":
      store.toggleClaim(btn.dataset.item, btn.dataset.member);
      break;
    case "claimAll":
      store.claimAll(btn.dataset.item);
      break;
    case "clearClaims":
      store.clearClaims(btn.dataset.item);
      break;
    case "addAdj":
      store.addAdjustment(
        btn.dataset.mode === "fixed"
          ? { label: "折扣", mode: "fixed", value: -0 }
          : { label: "服務費", mode: "percent", value: 10 }
      );
      break;
    case "rmAdj":
      store.removeAdjustment(btn.dataset.id);
      break;
    case "setMode":
      store.setSettleMode(btn.dataset.mode);
      break;
    case "share":
      await copy(shareText());
      btn.textContent = "✅ 已複製";
      setTimeout(() => (btn.textContent = "📋 複製分帳結果"), 1500);
      break;
    case "resetAll":
      if (confirm("確定清空全部資料？")) store.resetAll();
      break;
  }
});

app.addEventListener("change", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "editItem") {
    store.updateItem(t.dataset.id, { [t.dataset.field]: t.value });
  } else if (act === "editAdj") {
    store.updateAdjustment(t.dataset.id, { [t.dataset.field]: t.value });
  } else if (act === "setPayer") {
    store.setPayer(t.value || null);
  }
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

store.subscribe(render);
render();
