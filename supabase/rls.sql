-- SplitBite RLS：Supabase Anonymous Sign-in + 分帳成員隔離
--
-- 前置條件：Supabase Dashboard → Authentication → Providers → Anonymous
-- 必須啟用 Anonymous Sign-Ins。前端取得 auth.uid() 後，透過下方 RPC 建立
-- 或加入分帳；一般資料表政策只允許 session_access 中的成員存取該場資料。

grant usage on schema public to anon, authenticated;

-- 公開金鑰在尚未登入時屬於 anon。anon 不可直接操作任何分帳資料。
revoke all on public.sessions, public.session_access, public.members,
  public.items, public.claims, public.adjustments from anon;

-- authenticated 僅取得 UI 實際需要的最小表級／欄位級權限。
revoke all on public.sessions, public.session_access, public.members,
  public.items, public.claims, public.adjustments from authenticated;

grant select, delete on public.sessions to authenticated;
grant update (payer_id, ocr_total) on public.sessions to authenticated;

grant select, insert, delete on public.members to authenticated;
grant update (name) on public.members to authenticated;

grant select, insert, delete on public.items to authenticated;
grant update (name, qty, unit_price, confidence) on public.items to authenticated;

grant select, insert, delete on public.claims to authenticated;

grant select, insert, delete on public.adjustments to authenticated;
grant update (label, mode, value) on public.adjustments to authenticated;

alter table public.sessions       enable row level security;
alter table public.session_access enable row level security;
alter table public.members        enable row level security;
alter table public.items          enable row level security;
alter table public.claims         enable row level security;
alter table public.adjustments    enable row level security;

-- RLS 內使用 SECURITY DEFINER helper，避免查 session_access 時發生遞迴政策。
create or replace function public.is_session_member(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_access access
    where access.session_id = p_session_id
      and access.user_id = auth.uid()
  );
$$;

create or replace function public.is_session_creator(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.session_access access
    where access.session_id = p_session_id
      and access.user_id = auth.uid()
      and access.role = 'creator'
  );
$$;

create or replace function public.can_access_claim(p_item_id uuid, p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.items item
    join public.members member
      on member.session_id = item.session_id
    join public.session_access access
      on access.session_id = item.session_id
    where item.id = p_item_id
      and member.id = p_member_id
      and access.user_id = auth.uid()
  );
$$;

revoke all on function public.is_session_member(uuid) from public;
revoke all on function public.is_session_creator(uuid) from public;
revoke all on function public.can_access_claim(uuid, uuid) from public;
grant execute on function public.is_session_member(uuid) to authenticated;
grant execute on function public.is_session_creator(uuid) to authenticated;
grant execute on function public.can_access_claim(uuid, uuid) to authenticated;

-- 建帳與加入都必須經 RPC。呼叫者無法列出其他分帳或自行寫 session_access。
create or replace function public.create_session(p_code text)
returns setof public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_session public.sessions;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    raise exception 'invalid session code' using errcode = '22023';
  end if;

  insert into public.sessions (code)
  values (p_code)
  returning * into new_session;

  insert into public.session_access (session_id, user_id, role)
  values (new_session.id, auth.uid(), 'creator');

  return next new_session;
end;
$$;

create or replace function public.join_session(p_code text)
returns setof public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  joined_session public.sessions;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select session.*
  into joined_session
  from public.sessions session
  where session.code = upper(p_code);

  if not found then
    return;
  end if;

  insert into public.session_access (session_id, user_id, role)
  values (joined_session.id, auth.uid(), 'member')
  on conflict (session_id, user_id) do nothing;

  return next joined_session;
end;
$$;

revoke all on function public.create_session(text) from public;
revoke all on function public.join_session(text) from public;
grant execute on function public.create_session(text) to authenticated;
grant execute on function public.join_session(text) to authenticated;

-- 移除舊版及本版政策，讓此檔可重複執行。
do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'sessions', 'session_access', 'members', 'items', 'claims', 'adjustments'
      ])
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end $$;

create policy sessions_select
  on public.sessions for select to authenticated
  using (public.is_session_member(id));

create policy sessions_update
  on public.sessions for update to authenticated
  using (public.is_session_member(id))
  with check (public.is_session_member(id));

create policy sessions_delete
  on public.sessions for delete to authenticated
  using (public.is_session_creator(id));

-- session_access 沒有直接政策；只能由 SECURITY DEFINER RPC 存取。

create policy members_select
  on public.members for select to authenticated
  using (public.is_session_member(session_id));
create policy members_insert
  on public.members for insert to authenticated
  with check (public.is_session_member(session_id));
create policy members_update
  on public.members for update to authenticated
  using (public.is_session_member(session_id))
  with check (public.is_session_member(session_id));
create policy members_delete
  on public.members for delete to authenticated
  using (public.is_session_member(session_id));

create policy items_select
  on public.items for select to authenticated
  using (public.is_session_member(session_id));
create policy items_insert
  on public.items for insert to authenticated
  with check (public.is_session_member(session_id));
create policy items_update
  on public.items for update to authenticated
  using (public.is_session_member(session_id))
  with check (public.is_session_member(session_id));
create policy items_delete
  on public.items for delete to authenticated
  using (public.is_session_member(session_id));

create policy claims_select
  on public.claims for select to authenticated
  using (public.can_access_claim(item_id, member_id));
create policy claims_insert
  on public.claims for insert to authenticated
  with check (public.can_access_claim(item_id, member_id));
create policy claims_delete
  on public.claims for delete to authenticated
  using (public.can_access_claim(item_id, member_id));

create policy adjustments_select
  on public.adjustments for select to authenticated
  using (public.is_session_member(session_id));
create policy adjustments_insert
  on public.adjustments for insert to authenticated
  with check (public.is_session_member(session_id));
create policy adjustments_update
  on public.adjustments for update to authenticated
  using (public.is_session_member(session_id))
  with check (public.is_session_member(session_id));
create policy adjustments_delete
  on public.adjustments for delete to authenticated
  using (public.is_session_member(session_id));
