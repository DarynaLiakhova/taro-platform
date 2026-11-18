-- Путь Таролога · «сироты» в доступах
-- Что делает: находит записи доступов a/<id>, у которых нет профиля u/<id>
--   (ученица удалена или профиль потерян), показывает их и удаляет.
-- Когда запускать: после access-migration.sql, когда проверила список и он верный.
--   Первая таблица внизу — то, что будет удалено; можно сначала выполнить
--   только первый select и посмотреть.
-- Повторный запуск ничего не делает (сирот больше нет).
-- Вставь целиком в SQL Editor → Run.

-- 1. Какие записи будут удалены
select a.path, a.data->'owned' as owned, a.data->'fbUntil' as "fbUntil"
from public.docs a
where a.path like 'a/%'
  and not exists (select 1 from public.docs u where u.path = 'u/' || substring(a.path from 3))
order by a.path;

-- 2. Удаляем ровно их
delete from public.docs a
where a.path like 'a/%'
  and not exists (select 1 from public.docs u where u.path = 'u/' || substring(a.path from 3));
