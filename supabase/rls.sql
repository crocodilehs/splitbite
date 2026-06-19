-- RLS — 方案 A（規格 §7）
--
-- 取捨：本工具無登入系統（匿名加入），auth.uid() 不可用。
-- 方案 A 以 session code 當通行證：「知道 6 碼的人可讀寫該 session 資料」。
--
-- 實作說明：
-- anon key 會出現在瀏覽器，且 Realtime（postgres_changes）的 RLS 在複寫情境下
-- 無法取得自訂請求標頭，因此「以標頭帶 code 做 per-request 比對」對 Realtime 不可行。
-- 故方案 A 採「對 anon 開放讀寫」，安全性建立於：
--   1. code 不可猜：6 碼取自 31 字元集 ≈ 8.87 億組合，且 7 天 TTL 清理（§8）。
--   2. 前端只會以「使用者輸入/掃到的 code」換得 session_id 後，再依該 id 操作。
-- 對低敏感、短生命週期的分帳資料足夠（§7 明列方案 A 為「安全性中等」）。
--
-- 日後方案 B：改用 Supabase Anonymous Sign-in，RLS 依 auth.uid() 收斂到
-- 「該訪客所屬 session」，較嚴謹；屆時替換以下政策即可。

alter table public.sessions    enable row level security;
alter table public.members     enable row level security;
alter table public.items       enable row level security;
alter table public.claims      enable row level security;
alter table public.adjustments enable row level security;

-- 統一以 anon + authenticated 角色開放（方案 A）
do $$
declare t text;
begin
  foreach t in array array['sessions','members','items','claims','adjustments']
  loop
    execute format('drop policy if exists %I_anon_all on public.%I;', t, t);
    execute format(
      'create policy %I_anon_all on public.%I for all to anon, authenticated using (true) with check (true);',
      t, t
    );
  end loop;
end $$;
