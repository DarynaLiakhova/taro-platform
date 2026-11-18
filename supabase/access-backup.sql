-- Путь Таролога · резервная копия перед переносом доступов и видео
-- Что делает: сохраняет всю таблицу docs в таблицу docs_backup_20261118
--   (закрыта от учениц: правила RLS включены, прав у anon и authenticated нет),
--   и показывает число строк в обеих таблицах для сверки.
-- Когда запускать: ОДИН РАЗ перед access-migration.sql.
-- Первый запуск — строго ДО access-migration.sql, иначе в копии уже будут перенесённые данные.
-- Повторный запуск копию не перезаписывает (если она уже есть — остаётся прежней).
-- Вставь целиком в SQL Editor → Run.

create table if not exists public.docs_backup_20261118 as select * from public.docs;

-- В Supabase у новых таблиц в public по умолчанию есть доступ через API —
-- закрываем, иначе любая вошедшая ученица смогла бы прочитать копию целиком
alter table public.docs_backup_20261118 enable row level security;
revoke all on public.docs_backup_20261118 from anon, authenticated;

-- Сверка: числа должны совпасть (если ты уже что-то меняла после копии — копия старше)
select (select count(*) from public.docs) as docs,
       (select count(*) from public.docs_backup_20261118) as backup;
