-- Путь Таролога · защита доступов и видео уроков
-- Что делает:
--   • доступы ученицы (какие ступени куплены) живут в записи a/<id ученицы>;
--     менять их может только мастер, ученица — только читать;
--   • видео уроков ступени n живут в записи v/<n>; ученица видит их,
--     только если ступень n у неё открыта (ступень 7 — когда куплены все ступени 1–6);
--   • ученица может создавать и менять только свои рабочие записи
--     (u/, s/, m/, n/ и заявки pr/ в статусе «ожидает»);
--   • записи a/ и v/ нельзя удалить из платформы (только здесь, в SQL Editor).
-- Нужен уже выполненный setup.sql.
-- Перед запуском сделай копию: выполни access-backup.sql (тоже в SQL Editor).
-- Вставь целиком в SQL Editor → Run. Повторный запуск ничего не ломает.

-- 1. Открыта ли ученице ступень n. Читает её запись a/<id> в обход правил доступа
--    (security definer), поэтому правила таблицы docs могут её вызывать без
--    «infinite recursion detected in policy»
create or replace function public.has_stage(n int) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_master() or exists (
    select 1 from public.docs d
    where d.path = 'a/' || auth.uid()::text
      and (   d.data->'free' = 'true'::jsonb
           or (n between 1 and 6 and d.data->'owned' @> to_jsonb(n))
           or (n = 7 and d.data->'owned' @> '[1,2,3,4,5,6]'::jsonb))
  )
$$;
revoke all on function public.has_stage(int) from public, anon;
grant execute on function public.has_stage(int) to authenticated;

-- 2. Какие записи ученица может создавать и менять сама (таблицы не читает)
create or replace function public.student_path_ok(p text, o uuid, d jsonb) returns boolean
language sql stable set search_path = public as $$
  select coalesce(
    o = auth.uid() and (
         p = 'u/' || auth.uid()::text
      or p like 's/' || auth.uid()::text || '~%'
      or p like 'm/' || auth.uid()::text || '~%'
      or p like 'n/%'
      or (p like 'pr/%' and d->>'u' = auth.uid()::text and d->>'st' = 'wait')
    ), false)
$$;
revoke all on function public.student_path_ok(text, uuid, jsonb) from public, anon;
grant execute on function public.student_path_ok(text, uuid, jsonb) to authenticated;

-- 3. Ограничивающие правила: действуют вместе с правилами из setup.sql
--    и могут только сузить доступ, но не расширить его

-- видео ступени видно, только если ступень открыта
drop policy if exists docs_v_select on public.docs;
create policy docs_v_select on public.docs as restrictive for select to authenticated
  using (
    path !~ '^v/'
    or public.is_master()
    or case when path ~ '^v/[1-7]$' then public.has_stage(substring(path from 3)::int) else false end
  );

-- создавать: мастер — что угодно, ученица — только свои рабочие записи
drop policy if exists docs_paths_insert on public.docs;
create policy docs_paths_insert on public.docs as restrictive for insert to authenticated
  with check (public.is_master() or public.student_path_ok(path, owner, data));

-- менять: и старая запись (using), и новая (with check) должны быть разрешены
drop policy if exists docs_paths_update on public.docs;
create policy docs_paths_update on public.docs as restrictive for update to authenticated
  using (public.is_master() or public.student_path_ok(path, owner, data))
  with check (public.is_master() or public.student_path_ok(path, owner, data));

-- удалять: a/ и v/ — никому из платформы; остальное — как создавать
drop policy if exists docs_paths_delete on public.docs;
create policy docs_paths_delete on public.docs as restrictive for delete to authenticated
  using (path !~ '^(a|v)/' and (public.is_master() or public.student_path_ok(path, owner, data)));
