-- Путь Таролога · настройка базы Supabase
-- Вставь целиком в SQL Editor → Run. Повторный запуск ничего не ломает.

-- 1. Все данные платформы: каждая запись — документ с владельцем
create table if not exists public.docs (
  path       text primary key,
  owner      uuid,                       -- чья запись (ученица); null = общее (программа курса)
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists docs_owner_idx on public.docs(owner);

-- время изменения ставит сервер (по нему платформа видит, что пришло новое)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := clock_timestamp(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.touch_updated_at();

-- 2. Кто мастер. Таблица закрыта от всех, читает её только функция ниже
create table if not exists public.masters (uid uuid primary key);
alter table public.masters enable row level security;

create or replace function public.is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.masters where uid = auth.uid())
$$;
revoke all on function public.is_master() from public;
grant execute on function public.is_master() to authenticated;

-- 3. Правила доступа: ученица видит и меняет только своё, мастер — всё
alter table public.docs enable row level security;

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated
  using (owner = auth.uid() or owner is null or public.is_master());

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (owner = auth.uid() or public.is_master());

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (owner = auth.uid() or public.is_master())
  with check (owner = auth.uid() or public.is_master());

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (owner = auth.uid() or public.is_master());

grant select, insert, update, delete on public.docs to authenticated;
revoke all on public.docs from anon;
