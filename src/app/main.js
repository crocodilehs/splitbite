import qrcode from "../vendor/qrcode-generator.js"; // 本地 vendor（npm run vendor 產生）
import { compute, settle } from "../core/calc.js";
import { isValidCode, normalizeCode } from "../core/code.js";
import * as store from "./cloud-store.js";

const app = document.getElementById("app");

// 純 UI 狀態（不進 store）：成員編輯中、已認領品項的展開狀態、
// 收據照片預覽（本機 dataURL，供比對 OCR 結果）、調整項說明開關
let editingMemberId = null;
let expandedItems = new Set();
let receiptPreview = null; // { url, expanded, collapsed }
let showAdjHelp = false;
let showMemberHelp = false;
let dirtyFieldKey = null; // 目前 focus 欄位「使用者有輸入、尚未 commit」才設，重繪還原值時依此判斷

// Material Symbols（Apache 2.0）路徑，viewBox="0 -960 960 960"
const ICON_PATHS = {
  copy: "M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z",
  share:
    "M680-80q-50 0-85-35t-35-85q0-6 3-28L282-392q-16 15-37 23.5t-45 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q24 0 45 8.5t37 23.5l281-164q-2-7-2.5-13.5T560-760q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-24 0-45-8.5T598-672L317-508q2 7 2.5 13.5t.5 14.5q0 8-.5 14.5T317-452l281 164q16-15 37-23.5t45-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T720-200q0-17-11.5-28.5T680-240q-17 0-28.5 11.5T640-200q0 17 11.5 28.5T680-160ZM200-440q17 0 28.5-11.5T240-480q0-17-11.5-28.5T200-520q-17 0-28.5 11.5T160-480q0 17 11.5 28.5T200-440Zm480-320q17 0 28.5-11.5T720-800q0-17-11.5-28.5T680-840q-17 0-28.5 11.5T640-800q0 17 11.5 28.5T680-760Z",
  logout:
    "M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z",
  edit: "M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z",
  check: "M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z",
  expandMore: "M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z",
  expandLess: "m296-345-56-56 240-240 240 240-56 56-184-184-184 184Z",
  help: "M478-240q21 0 35.5-14.5T528-290q0-21-14.5-35.5T478-340q-21 0-35.5 14.5T428-290q0 21 14.5 35.5T478-240Zm-36-154h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z",
};
function icon(name) {
  return `<svg class="mi" viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}

function money(n) {
  return `$${n.toLocaleString("en-US")}`;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// render 重入保護：innerHTML 清空會移除 focus 中已修改的輸入框，Chrome 會
// 同步觸發 change → 寫入 store → emit → 又呼叫 render。若放任重入，外層
// render 會用開頭快照的過期 state 蓋掉內層畫好的新 DOM。改為「進行中就
// 排隊」，本輪結束後再以最新 state 重畫一次。
let rendering = false;
let renderQueued = false;

function render() {
  if (rendering) {
    renderQueued = true;
    return;
  }
  rendering = true;
  try {
    renderOnce();
  } finally {
    rendering = false;
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  }
}

function renderOnce() {
  const s = store.getState();
  // 樂觀新增的 tmp id 換成真 id 後，同步更新以 id 記錄的 UI 狀態
  expandedItems = new Set([...expandedItems].map(store.canonicalId));
  if (editingMemberId) editingMemberId = store.canonicalId(editingMemberId);

  // 重繪會整個重建 DOM：先記下正在輸入的欄位（值與游標），重建後還原，
  // 避免 Realtime 或樂觀更新觸發的 render 清掉使用者打到一半的字
  const active = document.activeElement;
  let restore = null;
  if (app.contains(active) && (active.tagName === "INPUT" || active.tagName === "SELECT")) {
    restore = { key: fieldKey(active), value: active.value, selStart: null, selEnd: null };
    try {
      restore.selStart = active.selectionStart;
      restore.selEnd = active.selectionEnd;
    } catch {
      // number input 不支援 selection
    }
  }

  app.innerHTML = "";

  if (s.status !== "active") {
    app.append(renderGate(s));
    return;
  }

  app.append(
    renderSessionBar(s),
    renderMembers(s),
    renderItems(s),
    renderAdjustments(s),
    renderSettlement(s)
  );

  if (restore) {
    for (const f of app.querySelectorAll("input, select")) {
      if (fieldKey(f) !== restore.key) continue;
      // 只有使用者真的輸入過（dirty）才回寫舊值；純 focus 未編輯時保留
      // 重繪後的新值，避免把過期內容蓋掉其他人剛同步進來的更新
      const dirty = dirtyFieldKey === restore.key;
      const rendered = f.value;
      if (dirty) f.value = restore.value;
      f.focus({ preventScroll: true });
      if (restore.selStart != null) {
        try {
          const len = f.value.length;
          f.setSelectionRange(Math.min(restore.selStart, len), Math.min(restore.selEnd, len));
        } catch {}
      }
      // 有未存編輯且與 state 不同：focus 在設值之後，之後的 blur 不會再
      // 觸發 change，先補發一次讓 editItem / editAdj / setPayer 不掉更新。
      // 只對「change 真的會 commit 到 store」的欄位補發；新增表單（addMember/
      // addItem）的草稿沒有對應的 change 持久化邏輯，補發只會白白清掉 dirty，
      // 讓下一輪重繪把使用者還沒送出的字清空。
      const persistsOnChange = f.dataset.act === "editItem" || f.dataset.act === "editAdj" || f.dataset.act === "setPayer";
      if (dirty && persistsOnChange && f.value !== rendered) f.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    }
  }
}

// 跨重繪辨識同一個欄位：以自身與所屬表單的 data-* / name 組 key。
// data-id 經 canonicalId 換算，tmp id 換成真 id 後仍視為同一欄位。
function fieldKey(f) {
  const wrap = f.closest("[data-act]") === f ? f.form?.closest?.("[data-act]") : f.closest("[data-act]");
  return [
    f.tagName,
    f.name || "",
    f.dataset.act || "",
    store.canonicalId(f.dataset.id || ""),
    f.dataset.field || "",
    wrap?.dataset.act || "",
    store.canonicalId(wrap?.dataset.id || ""),
  ].join("|");
}

// ---------- Gate：建帳 / 加入 ----------
function renderGate(s) {
  const sec = el(`<section class="card gate"></section>`);
  sec.append(el(`<h2>開始分帳</h2>`));
  if (s.status === "loading") {
    sec.append(el(`<p class="hint">連線中…</p>`));
    return sec;
  }
  if (s.error) sec.append(el(`<p class="warn">${escapeHtml(s.error)}</p>`));

  sec.append(el(`<button class="big" data-act="create">＋ 建立新分帳</button>`));
  sec.append(el(`<p class="hint">或輸入 6 碼加入碼加入別人的分帳：</p>`));
  const form = el(
    `<form class="row" data-act="join">
       <input name="code" placeholder="加入碼" autocapitalize="characters" autocomplete="off" maxlength="8" />
       <button type="submit">加入</button>
     </form>`
  );
  sec.append(form);
  return sec;
}

// ---------- Session 標頭：顯示加入碼 ----------
function renderSessionBar(s) {
  const sec = el(`<section class="card sessionbar"></section>`);
  sec.append(
    el(
      `<div class="sb-row">
         <div class="sb-codebox">
           <div class="sb-label">加入碼</div>
           <div class="sb-code">${s.code}</div>
         </div>
         <div class="sb-actions">
           <button class="mbtn" data-act="copyCode">${icon("copy")}<span>複製</span></button>
           <button class="mbtn" data-act="shareLink">${icon("share")}<span>分享</span></button>
           <button class="mbtn mbtn-muted" data-act="leave">${icon("logout")}<span>離開</span></button>
         </div>
       </div>`
    )
  );
  sec.append(renderQr(s.code));
  return sec;
}

// 加入連結：掃 QR 或點連結 → 開啟 app 並自動加入（#join=CODE）
function joinUrl(code) {
  return `${location.origin}${location.pathname}#join=${code}`;
}

function renderQr(code) {
  const qr = qrcode(0, "M"); // type 0 = 自動選最小版本
  qr.addData(joinUrl(code));
  qr.make();
  const box = el(`<div class="qr" title="掃描加入這場分帳"></div>`);
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
  box.append(el(`<p class="hint qr-hint">掃描 QR code 直接加入</p>`));
  return box;
}

// ---------- Members ----------
function renderMembers(s) {
  const sec = el(
    `<section class="card">
       <h2>👥 成員
         <button class="icon-btn help-btn" data-act="toggleMemberHelp" aria-label="說明" aria-expanded="${showMemberHelp}">${icon("help")}</button>
       </h2>
     </section>`
  );
  if (showMemberHelp) sec.append(el(`<p class="hint section-help">點成員名字可設定哪個是自己（⭐）。</p>`));
  const list = el(`<div class="member-chips"></div>`);
  for (const m of s.members) {
    if (editingMemberId === m.id) {
      list.append(
        el(
          `<form class="chip chip-edit" data-act="saveMember" data-id="${m.id}">
             <input name="name" value="${escapeAttr(m.name)}" autocomplete="off" aria-label="成員名字" />
             <button type="submit" class="chip-save" aria-label="儲存">${icon("check")}</button>
           </form>`
        )
      );
      continue;
    }
    const chip = el(
      `<span class="chip ${s.me === m.id ? "is-me" : ""}">
         <button class="chip-name" data-act="setMe" data-id="${m.id}">${escapeHtml(m.name)}${s.me === m.id ? " ⭐" : ""}</button>
         <button class="chip-edit-btn" data-act="editMember" data-id="${m.id}" aria-label="編輯名字">${icon("edit")}</button>
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
  return sec;
}

// ---------- Items ----------
function renderItems(s) {
  const sec = el(`<section class="card"><h2>🧾 品項與認領</h2></section>`);

  // OCR：拍照/上傳收據 → Edge Function 自動填品項
  // 不加 capture 屬性：手機會跳出「拍照或從相簿選取」的選單，兩種都支援
  const ocrRow = el(
    `<div class="row ocr-row">
       <label class="ocr-btn ${s.ocrBusy ? "busy" : ""}">
         ${s.ocrBusy ? "⏳ 辨識中…" : "📷 拍照 / 上傳收據自動填品項"}
         <input type="file" accept="image/*" data-act="ocr" ${s.ocrBusy ? "disabled" : ""} hidden />
       </label>
     </div>`
  );
  sec.append(ocrRow);
  // 收據照片預覽：辨識中與辨識後都顯示，方便比對結果；可摺疊、點圖可放大/縮小
  if (receiptPreview) {
    if (receiptPreview.collapsed) {
      sec.append(
        el(
          `<div class="receipt-preview collapsed">
             <button class="receipt-bar" data-act="uncollapseReceipt">
               <span>🧾 收據照片</span>${icon("expandMore")}
             </button>
           </div>`
        )
      );
    } else {
      sec.append(
        el(
          `<div class="receipt-preview ${receiptPreview.expanded ? "expanded" : ""}">
             <img src="${receiptPreview.url}" alt="收據照片" data-act="toggleReceipt" />
             <div class="receipt-tools">
               <span class="hint">${receiptPreview.expanded ? "點圖片縮小" : "點圖片放大"}</span>
               <button class="link" data-act="collapseReceipt">摺疊圖片</button>
               <button class="link" data-act="closeReceipt">關閉圖片</button>
             </div>
           </div>`
        )
      );
    }
  }
  if (s.error && !s.ocrBusy) sec.append(el(`<p class="warn">${escapeHtml(s.error)}</p>`));

  // 手動新增放在拍照/照片下方、品項列表上方：方便看著收據補上缺漏品項
  const form = el(
    `<form class="row item-add" data-act="addItem">
       <input name="name" placeholder="品名" autocomplete="off" />
       <input name="qty" type="number" min="1" placeholder="數量" inputmode="numeric" aria-label="數量" />
       <input name="unit_price" type="number" min="0" placeholder="單價" inputmode="numeric" aria-label="單價" />
       <button type="submit" aria-label="新增品項">＋</button>
     </form>`
  );
  sec.append(form);

  if (s.members.length === 0) sec.append(el(`<p class="hint">先新增成員，才能認領品項。</p>`));
  for (const it of s.items) sec.append(renderItemRow(s, it));
  return sec;
}

function renderItemRow(s, it) {
  const total = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
  const lowConf = it.confidence === "low"; // OCR 信心低（階段 3 填入），人工輸入為 null
  const claimers = s.members.filter((m) => store.isClaimed(it.id, m.id));

  // 已認領的品項預設摺疊成一列摘要，點擊可展開編輯（減少畫面長度）
  if (claimers.length > 0 && !expandedItems.has(it.id)) {
    return el(
      `<div class="item item-collapsed ${lowConf ? "low-conf" : ""}">
         <button class="item-summary" data-act="expandItem" data-id="${it.id}" aria-expanded="false" aria-label="展開品項">
           <span class="sum-name">${lowConf ? "⚠️ " : ""}${escapeHtml(it.name || "未命名")}</span>
           <span class="sum-claimers">${claimers.map((c) => escapeHtml(c.name)).join("、")}</span>
           <span class="sum-total">${money(total)}</span>
           ${icon("expandMore")}
         </button>
       </div>`
    );
  }

  const wrap = el(`<div class="item ${lowConf ? "low-conf" : ""}"></div>`);
  const head = el(
    `<div class="item-name-row">
       ${lowConf ? `<span class="conf-badge" title="OCR 辨識可信度低，請確認品名與金額">⚠️</span>` : ""}
       <input class="item-name" data-act="editItem" data-id="${it.id}" data-field="name" value="${escapeAttr(it.name)}" placeholder="品名" />
       ${claimers.length > 0 ? `<button class="icon-btn" data-act="collapseItem" data-id="${it.id}" aria-expanded="true" aria-label="摺疊品項">${icon("expandLess")}</button>` : ""}
       <button class="item-del" data-act="rmItem" data-id="${it.id}" aria-label="刪除品項">🗑</button>
     </div>`
  );
  wrap.append(head);
  wrap.append(
    el(
      `<div class="item-calc-row">
         <input class="item-num" data-act="editItem" data-id="${it.id}" data-field="qty" type="number" min="1" value="${it.qty}" inputmode="numeric" aria-label="數量" />
         <span class="x">×</span>
         <input class="item-num" data-act="editItem" data-id="${it.id}" data-field="unit_price" type="number" min="0" value="${it.unit_price}" inputmode="numeric" aria-label="單價" />
         <span class="item-total">= ${money(total)}</span>
       </div>`
    )
  );

  const claimRow = el(`<div class="claims"></div>`);
  for (const m of s.members) {
    const on = store.isClaimed(it.id, m.id);
    claimRow.append(
      el(`<button class="claim-btn ${on ? "on" : ""}" data-act="toggleClaim" data-item="${it.id}" data-member="${m.id}">${escapeHtml(m.name)}</button>`)
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
  const sec = el(
    `<section class="card">
       <h2>➕ 服務費 / 折扣
         <button class="icon-btn help-btn" data-act="toggleAdjHelp" aria-label="說明" aria-expanded="${showAdjHelp}">${icon("help")}</button>
       </h2>
     </section>`
  );
  if (showAdjHelp) sec.append(el(`<p class="hint section-help">折扣請填負數。服務費 / 折扣會按各品項小計的占比分攤給成員。</p>`));
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

  const payerRow = el(`<div class="row payer"><label>墊款人：</label></div>`);
  const sel = el(`<select data-act="setPayer"></select>`);
  sel.append(el(`<option value="">— 請選擇 —</option>`));
  for (const m of s.members) {
    sel.append(el(`<option value="${m.id}" ${s.payer_id === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`));
  }
  payerRow.append(sel);
  sec.append(payerRow);

  const table = el(`<div class="owe-table"></div>`);
  for (const p of result.perMember) {
    table.append(
      el(
        `<div class="owe-row">
           <span class="owe-name">${escapeHtml(p.name)}</span>
           <span class="owe-detail">小計 ${money(p.subtotal)}${p.adjustment ? ` ${p.adjustment > 0 ? "+" : "−"}${money(Math.abs(p.adjustment))}` : ""}</span>
           <span class="owe-total">${money(p.total)}</span>
         </div>`
      )
    );
  }
  sec.append(table);

  sec.append(
    el(
      `<div class="totals">
         <span>已認領 ${money(result.claimedTotal)}</span>
         ${result.adjustmentTotal ? `<span>調整 ${money(result.adjustmentTotal)}</span>` : ""}
         <span class="grand">合計 ${money(result.grandTotal)}</span>
       </div>`
    )
  );
  // OCR 對帳：收據上讀到的總額與計算合計不符時警告（階段 3 填入 ocr_total）
  const ocrTotal = Number(s.ocr_total);
  if (ocrTotal > 0 && ocrTotal !== result.grandTotal) {
    sec.append(
      el(`<p class="warn">⚠️ 收據 OCR 總額 ${money(ocrTotal)} 與計算合計 ${money(result.grandTotal)} 不符，請檢查品項或調整項。</p>`)
    );
  }
  if (result.unclaimedTotal > 0) {
    sec.append(
      el(`<p class="warn">⚠️ 尚有 ${money(result.unclaimedTotal)} 未認領（${result.unclaimedItems.map((i) => escapeHtml(i.name || "未命名")).join("、")}）</p>`)
    );
  }

  const modeRow = el(
    `<div class="seg">
       <button data-act="setMode" data-mode="toPayer" class="${s.settleMode === "toPayer" ? "on" : ""}">全還給墊款人</button>
       <button data-act="setMode" data-mode="minimal" class="${s.settleMode === "minimal" ? "on" : ""}">最小化轉帳</button>
     </div>`
  );
  sec.append(modeRow);

  const { transfers } = settle(result, s.payer_id, s.settleMode);
  if (!s.payer_id) {
    sec.append(el(`<p class="hint">選擇墊款人後顯示轉帳明細。</p>`));
  } else if (transfers.length === 0) {
    sec.append(el(`<p class="hint">目前沒有人需要轉帳給墊款人。</p>`));
  } else {
    const tl = el(`<div class="transfers"></div>`);
    for (const t of transfers) {
      tl.append(el(`<div class="transfer">${escapeHtml(t.fromName)} → <b>${escapeHtml(t.toName)}</b> <span>${money(t.amount)}</span></div>`));
    }
    sec.append(tl);
    sec.append(el(`<button class="share" data-act="share">📋 複製分帳結果</button>`));
  }
  return sec;
}

function shareText() {
  const s = store.getState();
  const result = compute(s);
  const { transfers } = settle(result, s.payer_id, s.settleMode);
  const payer = s.members.find((m) => m.id === s.payer_id);
  const lines = ["🍽️ SplitBite 分帳結果", `加入碼：${s.code}`, ""];
  for (const p of result.perMember) lines.push(`${p.name}：${money(p.total)}`);
  lines.push("", `墊款人：${payer ? payer.name : "（未指定）"}`);
  if (transfers.length) {
    lines.push("");
    for (const t of transfers) lines.push(`${t.fromName} → ${t.toName} ${money(t.amount)}`);
  }
  lines.push("", `合計 ${money(result.grandTotal)}`);
  return lines.join("\n");
}

// ---------- Events ----------
// 使用者實際輸入才標記 dirty；change（commit 到 store）後解除
app.addEventListener("input", (e) => {
  const t = e.target;
  if (t.matches("input, select, textarea")) dirtyFieldKey = fieldKey(t);
});

app.addEventListener("submit", (e) => {
  const act = e.target.dataset.act;
  if (act === "join") {
    e.preventDefault();
    const code = e.target.querySelector('[name="code"]').value;
    if (!isValidCode(code)) {
      store.getState().error = "加入碼格式不正確";
      render();
      return;
    }
    store.joinByCode(code).catch(() => render());
  } else if (act === "addMember") {
    e.preventDefault();
    // store.addMember 會同步 emit → render 重建表單：先取值、清欄位、
    // 解除 dirty，重繪還原時才不會把剛送出的名字塞回新表單（Enter 連按會重複新增）
    const input = e.target.querySelector('[name="name"]');
    const name = input.value.trim();
    input.value = "";
    dirtyFieldKey = null;
    if (name) store.addMember(name);
    app.querySelector('form[data-act="addMember"] input')?.focus();
  } else if (act === "saveMember") {
    e.preventDefault();
    const id = e.target.dataset.id;
    const name = e.target.querySelector('[name="name"]').value.trim();
    editingMemberId = null;
    dirtyFieldKey = null;
    if (name) store.renameMember(id, name);
    else render();
  } else if (act === "addItem") {
    e.preventDefault();
    const f = e.target;
    const item = { name: f.name.value, qty: f.qty.value || 1, unit_price: f.unit_price.value || 0 };
    f.name.value = "";
    f.qty.value = "";
    f.unit_price.value = "";
    dirtyFieldKey = null;
    store.addItem(item);
    app.querySelector('.item-add input[name="name"]')?.focus();
  }
});

app.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  switch (act) {
    case "create":
      store.createSession().catch(() => render());
      break;
    case "leave":
      if (confirm("離開這場分帳？（資料仍保留在雲端，可用加入碼回來）")) store.leaveSession();
      break;
    case "copyCode":
      await copy(store.getState().code);
      flash(btn, "已複製", "複製");
      break;
    case "shareLink": {
      const url = joinUrl(store.getState().code);
      if (navigator.share) {
        navigator.share({ title: "SplitBite 分帳", text: "掃碼或點連結加入分帳", url }).catch(() => {});
      } else {
        await copy(url);
        flash(btn, "已複製連結", "分享");
      }
      break;
    }
    case "setMe":
      store.setMe(btn.dataset.id);
      break;
    case "editMember":
      editingMemberId = btn.dataset.id;
      render();
      app.querySelector(".chip-edit input")?.select();
      break;
    case "rmMember":
      if (editingMemberId === btn.dataset.id) editingMemberId = null;
      store.removeMember(btn.dataset.id);
      break;
    case "rmItem":
      expandedItems.delete(btn.dataset.id);
      store.removeItem(btn.dataset.id);
      break;
    case "expandItem":
      expandedItems.add(btn.dataset.id);
      render();
      break;
    case "collapseItem":
      expandedItems.delete(btn.dataset.id);
      render();
      break;
    case "toggleReceipt":
      if (receiptPreview) receiptPreview.expanded = !receiptPreview.expanded;
      render();
      break;
    case "collapseReceipt":
      if (receiptPreview) {
        receiptPreview.collapsed = true;
        receiptPreview.expanded = false;
      }
      render();
      break;
    case "uncollapseReceipt":
      if (receiptPreview) receiptPreview.collapsed = false;
      render();
      break;
    case "closeReceipt":
      if (confirm("關閉收據照片？關閉後需要重新拍照或上傳才能再看。")) {
        receiptPreview = null;
        render();
      }
      break;
    case "toggleAdjHelp":
      showAdjHelp = !showAdjHelp;
      render();
      break;
    case "toggleMemberHelp":
      showMemberHelp = !showMemberHelp;
      render();
      break;
    case "toggleClaim":
      // 認領中的品項保持展開，其餘已認領品項自動摺疊（換選下一項＝上一項選完了）
      expandedItems = new Set([btn.dataset.item]);
      store.toggleClaim(btn.dataset.item, btn.dataset.member);
      break;
    case "claimAll":
      expandedItems = new Set(); // 全選是完整動作，直接摺疊（其他展開中的也一併收起）
      store.claimAll(btn.dataset.item);
      break;
    case "clearClaims":
      store.clearClaims(btn.dataset.item);
      break;
    case "addAdj":
      store.addAdjustment(
        btn.dataset.mode === "fixed"
          ? { label: "折扣", mode: "fixed", value: 0 }
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
      flash(btn, "✅ 已複製", "📋 複製分帳結果");
      break;
  }
});

app.addEventListener("change", (e) => {
  const t = e.target.closest("[data-act]");
  const act = t?.dataset.act;
  // change 只有在會真的 commit 到 store（editItem/editAdj/setPayer）時才代表
  // 「已存檔」而解除 dirty；addMember/addItem 等草稿表單的 change 只是使用者
  // 移開焦點（blur），草稿還沒送出，此時解除 dirty 會讓下一輪重繪把還沒送出
  // 的字當成非 dirty 蓋成空字串 —— 草稿要保持 dirty 直到 submit 才清除。
  const persists = act === "editItem" || act === "editAdj" || act === "setPayer";
  if (persists && e.target.matches("input, select, textarea") && dirtyFieldKey === fieldKey(e.target)) dirtyFieldKey = null;
  if (!t) return;
  if (act === "ocr") {
    const file = t.files && t.files[0];
    t.value = ""; // 允許重選同一張
    if (file) uploadReceipt(file).catch(() => {}); // 錯誤已寫入 state.error 由 render 顯示
    return;
  }
  if (act === "editItem") store.updateItem(t.dataset.id, { [t.dataset.field]: t.value });
  else if (act === "editAdj") store.updateAdjustment(t.dataset.id, { [t.dataset.field]: t.value });
  else if (act === "setPayer") store.setPayer(t.value || null);
});

// 收據照片先縮圖再上傳：省流量、加快辨識，也避開 Edge Function 的大小上限
async function uploadReceipt(file) {
  const dataUrl = await downscaleImage(file, 1600, 0.85);
  receiptPreview = { url: dataUrl, expanded: false }; // 顯示照片供比對辨識結果
  render();
  const [head, base64] = dataUrl.split(",");
  const mime = head.match(/^data:([^;]+)/)?.[1] || "image/jpeg";
  await store.ocrReceipt(base64, mime);
}

function downscaleImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取圖片"));
    };
    img.src = url;
  });
}

function flash(btn, on, off) {
  const label = btn.querySelector("span") || btn; // 圖示按鈕只換文字，保留 SVG
  label.textContent = on;
  setTimeout(() => (label.textContent = off), 1500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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

// 深連結：#join=CODE（QR / 分享連結進來）優先於「最近的 session」
function hashJoinCode() {
  const m = location.hash.match(/^#join=(.+)$/);
  if (!m) return null;
  const code = normalizeCode(decodeURIComponent(m[1]));
  return isValidCode(code) ? code : null;
}

store.subscribe(render);
render();
const deepLink = hashJoinCode();
if (deepLink) {
  history.replaceState(null, "", location.pathname + location.search); // 清掉 hash，避免重整重複觸發
  store.joinByCode(deepLink).catch(() => render());
} else {
  store.init();
}
