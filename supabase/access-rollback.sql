-- Путь Таролога · откат переноса доступов и видео
-- Что делает: возвращает базу к тому виду, с которым работает старая страница:
--   • видео уроков возвращаются из v/<n> в ссылки video внутри p/program
--     (урокам без ссылки в v/ остаётся прежняя ссылка или пустая строка);
--   • доступы owned, fbUntil, sessions, appliedReqs из a/<id> копируются в
--     профиль u/<id> (данные из a/ главнее: мастер мог открыть ступень уже после
--     переноса); поле free из a/ не переносится;
--   • записи a/ и v/ удаляются;
--   • убираются 4 ограничивающих правила и функции has_stage, student_path_ok.
-- Когда запускать: если после access-migration.sql что-то пошло не так.
-- Повторный запуск ничего не ломает. Резервная копия не затрагивается.
-- Вставь целиком в SQL Editor → Run.

-- 1. Видео обратно в уроки p/program (пока v/ ещё на месте)
with fixed as (
  select p.path, jsonb_set(p.data, '{program}', coalesce((
    select jsonb_agg(
      case when jsonb_typeof(s->'lessons') = 'array' then jsonb_set(s, '{lessons}', coalesce((
        select jsonb_agg(
          jsonb_set(l, '{video}', to_jsonb(coalesce(
            (select v.data->'videos'->>(l->>'id') from public.docs v
              where v.path = 'v/' || (s->>'n')),
            case when jsonb_typeof(l->'video') = 'string' then l->>'video' end,
            '')))
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

-- 2. Доступы из a/<id> в существующие профили u/<id>
update public.docs u
set data = u.data || jsonb_build_object(
  'owned',       case when jsonb_typeof(a.data->'owned') = 'array' then a.data->'owned' else '[]'::jsonb end,
  'fbUntil',     coalesce(a.data->'fbUntil', 'null'::jsonb),
  'sessions',    case when jsonb_typeof(a.data->'sessions') = 'number' then a.data->'sessions' else '0'::jsonb end,
  'appliedReqs', case when jsonb_typeof(a.data->'appliedReqs') = 'array' then a.data->'appliedReqs' else '[]'::jsonb end)
from public.docs a
where a.path like 'a/%' and u.path = 'u/' || substring(a.path from 3);

-- 3. Удаляем a/ и v/
delete from public.docs where path like 'a/%' or path like 'v/%';

-- 4. Убираем правила и функции (правила — раньше функций, они на них ссылаются)
drop policy if exists docs_v_select on public.docs;
drop policy if exists docs_paths_insert on public.docs;
drop policy if exists docs_paths_update on public.docs;
drop policy if exists docs_paths_delete on public.docs;
drop function if exists public.has_stage(int);
drop function if exists public.student_path_ok(text, uuid, jsonb);

-- ── Вариант «полностью вернуть таблицу из резервной копии» ───────────────────
-- ВНИМАНИЕ: пропадёт ВСЁ, что ученицы и мастер записали после копии
-- (уроки, заметки, заявки, оплаты, новые ученицы). Используй только если
-- вариант выше не помог. Чтобы включить — убери «-- » в начале строк блока.
-- begin;
-- delete from public.docs;
-- insert into public.docs select * from public.docs_backup_20261118;
-- commit;
