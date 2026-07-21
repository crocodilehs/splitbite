-- SplitBite schema（規格 §3）
-- 套用方式：Supabase Dashboard → SQL Editor 貼上執行，或 supabase db push。

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- 一場分帳
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,           -- 6 碼加入碼（供 QR / 手動輸入）
  payer_id    uuid,                            -- 墊款人（結算時指定）
  created_at  timestamptz not null default now()
);

-- 可存取分帳的 Supabase 使用者。
-- 使用 Anonymous Sign-in 時，每個瀏覽器仍有獨立的 auth.uid()。
create table if not exists public.session_access (
  session_id  uuid not null references public.sessions(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (session_id, user_id),
  constraint session_access_role_check check (role in ('creator', 'member'))
);

-- 成員（分帳畫面中的姓名，與登入身分分開）
create table if not exists public.members (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  name        text not null default ''
);

-- 品項（OCR 填入 + 人工修正）
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  name        text not null default '',
  qty         int  not null default 1,
  unit_price  numeric not null default 0       -- 整數元
);

-- 認領（誰認領哪個品項，可多人均分）
create table if not exists public.claims (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  unique (item_id, member_id)
);

-- 調整（服務費 / 折扣 / 稅）
create table if not exists public.adjustments (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions(id) on delete cascade,
  label       text not null default '',
  mode        text not null default 'percent', -- 'percent' | 'fixed'
  value       numeric not null default 0,
  constraint adjustments_mode_check check (mode in ('percent', 'fixed'))
);

-- 階段 3/4 欄位（可重複執行）：OCR 信心標記與收據總額對帳
alter table public.items    add column if not exists confidence text;   -- 'high' | 'low'，人工輸入為 null
alter table public.sessions add column if not exists ocr_total numeric; -- OCR 讀到的收據總額（對帳警告用）

-- 索引：依 session 撈資料、認領查詢
create index if not exists session_access_user_idx on public.session_access(user_id);
create index if not exists members_session_idx on public.members(session_id);
create index if not exists items_session_idx on public.items(session_id);
create index if not exists adjustments_session_idx on public.adjustments(session_id);
create index if not exists claims_item_idx on public.claims(item_id);
create index if not exists claims_member_idx on public.claims(member_id);

-- payer_id 參照 members（建表後再加，避免循環依賴）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_payer_fk'
  ) then
    alter table public.sessions
      add constraint sessions_payer_fk
      foreign key (payer_id) references public.members(id) on delete set null;
  end if;
end $$;

-- Realtime：訂閱 members / items / claims / adjustments（規格 §3）
-- sessions 也加入以便 payer_id 變更同步。
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sessions','members','items','claims','adjustments']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I;', t);
    end if;
  end loop;
end $$;
