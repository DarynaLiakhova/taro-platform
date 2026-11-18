-- Путь Таролога · защита доступов и видео уроков
-- Что делает:
--   • доступы ученицы (какие ступени куплены) живут в записи a/<id ученицы>;
--     менять их может только мастер, ученица — только читать;
--   • видео уроков ступени n живут в записи v/<n>; ученица видит их,
--     только если ступень n у неё открыта (ступень 7 — когда куплены все ступени 1–6);
--   • ученица может создавать и менять только свои рабочие записи
--     (u/, s/, m/, n/ и заявки pr/ в статусе «ожидает»);
--   • записи a/ и v/ нельзя удалить из платформы (только здесь, в SQL Editor).
--   • переносит уже существующие данные: доступы из профилей u/ в a/,
--     ссылки на видео из программы p/program в v/<n>; в конце показывает,
--     кого из учениц стоит проверить мастеру.
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

-- ── Перенос уже существующих данных ──────────────────────────────────────────
-- Все шаги повторяемые: второй запуск ничего не меняет и не затирает того,
-- что мастер поправил в a/ и v/ между запусками.

-- 4. Доступы ученицы из её профиля u/<id> → a/<id>.
--    Ступени — числа без повторов по возрастанию ("3" из старых данных → 3);
--    appliedReqs — из профиля плюс все подтверждённые (ok) заявки pr/ этой ученицы.
--    free из профиля не переносится (такие ученицы видны в проверочном запросе в конце).
--    Если a/<id> уже есть — запись не трогаем.
insert into public.docs(path, owner, data)
select 'a/' || u.owner::text, u.owner, jsonb_build_object(
  'owned', coalesce((
    select jsonb_agg(x order by x) from (
      select distinct (e #>> '{}')::numeric as x
      from jsonb_array_elements(case when jsonb_typeof(u.data->'owned') = 'array'
                                     then u.data->'owned' else '[]'::jsonb end) e
      where e #>> '{}' ~ '^\d+$') s), '[]'::jsonb),
  'fbUntil', case when jsonb_typeof(u.data->'fbUntil') = 'string' and u.data->>'fbUntil' <> ''
                  then u.data->'fbUntil' else 'null'::jsonb end,
  'free', false,
  'sessions', case when jsonb_typeof(u.data->'sessions') = 'number'
                   then u.data->'sessions' else '0'::jsonb end,
  'appliedReqs', coalesce((
    select jsonb_agg(x order by x) from (
      select (e #>> '{}')::numeric as x
      from jsonb_array_elements(case when jsonb_typeof(u.data->'appliedReqs') = 'array'
                                     then u.data->'appliedReqs' else '[]'::jsonb end) e
      where e #>> '{}' ~ '^\d+$'
      union
      select (r.data->>'id')::numeric
      from public.docs r
      where r.path like 'pr/%' and r.data->>'u' = u.owner::text
        and r.data->>'st' = 'ok' and r.data->>'id' ~ '^\d+$') s), '[]'::jsonb))
from public.docs u
where u.owner is not null and u.path = 'u/' || u.owner::text
on conflict (path) do nothing;

-- 5. Служебный аккаунт darynaliakhova@gmail.com — все ступени открыты (free).
--    Если a/ уже есть — только добавляем free, остальное не трогаем;
--    если аккаунта нет — ничего не делаем.
insert into public.docs(path, owner, data)
select 'a/' || au.id::text, au.id,
       '{"owned":[],"fbUntil":null,"free":true,"sessions":0,"appliedReqs":[]}'::jsonb
from auth.users au
where lower(au.email) = 'darynaliakhova@gmail.com'
on conflict (path) do update set data = public.docs.data || '{"free":true}'::jsonb
  where public.docs.data->'free' is distinct from 'true'::jsonb;

-- 6. Видео уроков из программы p/program → v/<номер ступени>:
--    data.videos = { <id урока>: <ссылка> }; ссылки, уже лежащие в v/<n>, сохраняются
with vids as (
  select (s->>'n')::int as n, jsonb_object_agg(l->>'id', l->'video') as videos
  from public.docs p,
       jsonb_array_elements(case when jsonb_typeof(p.data->'program') = 'array'
                                 then p.data->'program' else '[]'::jsonb end) s,
       jsonb_array_elements(case when jsonb_typeof(s->'lessons') = 'array'
                                 then s->'lessons' else '[]'::jsonb end) l
  where p.path = 'p/program'
    and s->>'n' ~ '^[1-7]$'
    and coalesce(l->>'id', '') <> ''
    and jsonb_typeof(l->'video') = 'string' and btrim(l->>'video') <> ''
  group by 1
)
insert into public.docs(path, owner, data)
select 'v/' || n, null, jsonb_build_object('videos', videos) from vids
on conflict (path) do update
  set data = public.docs.data || jsonb_build_object('videos',
        coalesce(public.docs.data->'videos', '{}'::jsonb) || (excluded.data->'videos'))
  where public.docs.data is distinct from public.docs.data || jsonb_build_object('videos',
        coalesce(public.docs.data->'videos', '{}'::jsonb) || (excluded.data->'videos'));

-- 7. Убираем ключ video из уроков в p/program — программу читают все,
--    поэтому ссылок там быть не должно. Убираем только пустые ссылки и те,
--    что уже лежат в v/<n> (шаг 6), — так ни одна ссылка не потеряется.
--    Если убирать нечего — запись не меняется.
with fixed as (
  select p.path, jsonb_set(p.data, '{program}', coalesce((
    select jsonb_agg(
      case when jsonb_typeof(s->'lessons') = 'array' then jsonb_set(s, '{lessons}', coalesce((
        select jsonb_agg(
          case when l ? 'video' and (
                    jsonb_typeof(l->'video') <> 'string'
                 or btrim(l->>'video') = ''
                 or exists (select 1 from public.docs v
                            where v.path = 'v/' || (s->>'n')
                              and v.data->'videos'->(l->>'id') = l->'video'))
               then l - 'video' else l end
          order by li)
        from jsonb_array_elements(s->'lessons') with ordinality x(l, li)), '[]'::jsonb))
      else s end
      order by si)
    from jsonb_array_elements(p.data->'program') with ordinality y(s, si)), '[]'::jsonb)) as data
  from public.docs p
  where p.path = 'p/program' and jsonb_typeof(p.data->'program') = 'array'
)
update public.docs d set data = f.data
from fixed f
where d.path = f.path and d.data is distinct from f.data;

-- 7а. Пустые записи v/1 … v/7 для ступеней, где ссылок ещё нет: тогда первая
--     ссылка, которую мастер добавит в такую ступень, сразу попадёт в v/<n>,
--     а не в общую программу. Уже существующие v/<n> не трогаем.
insert into public.docs(path, owner, data)
select 'v/' || n, null, '{"videos":{}}'::jsonb from generate_series(1, 7) n
on conflict (path) do nothing;

-- 8. Проверка (результат появится внизу SQL Editor): ученицы, у которых открыта
--    ступень без подтверждённой оплаты в pay/ (оплата ступени n или всего курса —
--    он покрывает ступени 1–6), и те, у кого в профиле стояло free: true
--    (free больше не действует — при необходимости мастер откроет ступени сам).
select u.data->>'name' as name,
       u.data->>'email' as email,
       a.data->'owned' as owned,
       np.not_paid,
       coalesce(u.data->'free' = 'true'::jsonb, false) as legacy_free
from public.docs a
left join public.docs u on u.path = 'u/' || a.owner::text
cross join lateral (
  select coalesce(jsonb_agg(o order by o), '[]'::jsonb) as not_paid
  from jsonb_array_elements(case when jsonb_typeof(a.data->'owned') = 'array'
                                 then a.data->'owned' else '[]'::jsonb end) o
  where not exists (
    select 1 from public.docs pay
    where pay.path like 'pay/%' and pay.data->>'u' = a.owner::text
      and (   (pay.data #>> '{item,kind}' = 'stage' and pay.data #>> '{item,n}' = o #>> '{}')
           or (pay.data #>> '{item,kind}' = 'course' and o #>> '{}' in ('1','2','3','4','5','6'))))
) np
where a.owner is not null and a.path = 'a/' || a.owner::text
  and (jsonb_array_length(np.not_paid) > 0 or coalesce(u.data->'free' = 'true'::jsonb, false))
order by name, email;
