# Доступы и видео уроков под защитой базы — план работ

> **Для исполнителя:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Шаги отмечаются чекбоксами (`- [ ]`).

**Цель:** доступы ученицы (`a/<uid>`) и ссылки на видео (`v/<n>`) меняет и выдаёт только база по правилам RLS; страница работает как раньше.

**Архитектура:** всё остаётся в таблице `public.docs`. Новые адреса `a/<uid>` (доступы, owner = ученица, пишет только мастер) и `v/<n>` (видео ступени, owner = null, читает мастер или тот, у кого `has_stage(n)`). Поверх существующих разрешающих правил из `setup.sql` добавляются ограничивающие (`as restrictive`) правила: белый список адресов для ученицы на insert/update/delete, чтение `v/` через security definer функцию, запрет удаления `a/` и `v/` для всех. Страница накладывает `a/` на профиль при загрузке и раскладывает видео по `v/` при сохранении.

**Стек:** один файл `index.html` (свой мини-клиент Supabase, синхронизация документов), Supabase Postgres + RLS, тесты: Playwright, PGlite (`@electric-sql/pglite`, Postgres в WASM) + `node --test`.

**Спека:** `docs/superpowers/specs/2026-11-18-access-and-videos-design.md` + уточнения Дарины от 2026-11-18 (в этом плане учтены, при расхождении действует план).

## Общие ограничения

- Только ветка `fix/access-and-videos`, в `main` не коммитить.
- Ключ `service_role` не используется нигде, в т.ч. в тестах и инструкциях.
- Все SQL-файлы безопасно запускать повторно в SQL Editor.
- Проверка ступени — только через `public.has_stage(n int) returns boolean`, `security definer`, `set search_path = public`, `stable`; в политиках `docs` нет подзапросов к `docs`.
- Ступень 7 по `has_stage`: открыта, если в `owned` есть все 1, 2, 3, 4, 5, 6 (или `free`, или мастер).
- `free = true` ставится только аккаунту `darynaliakhova@gmail.com`. Устаревшее поле `free` из `u/…` при переносе игнорируется.
- Покупка «весь курс» → `owned` ⊇ [1..6]; «обратная связь» → `fbUntil` в `a/<uid>`; «5 сессий» → `sessions += 5` в `a/<uid>`.
- У новой ученицы нет `a/<uid>`: страница считает «ничего не куплено» (`owned [] , fbUntil null, free false, sessions 0, appliedReqs []`) и не падает.
- Старая закэшированная страница после SQL не ломается: максимум — нет видео до обновления.
- Тексты для Дарины — по-русски, простым языком.

## Решения, которые уточняют спеку

1. **Поля доступа остаются зеркалом в `u/…`.** Новая страница читает доступы только из `a/`, но продолжает писать `owned/fbUntil/sessions/appliedReqs` в `u/` (значения из `a/`). Иначе старая открытая вкладка, получив `u/` без `owned`, упадёт на `u.owned.includes`. Зеркалу никто не доверяет: ни страница, ни база.
2. **`a/` и `v/` не удаляет никто** (ограничивающее правило на delete). Причина: старая страница Лены удаляет из базы всё, чего нет в её сериализации — без запрета она стёрла бы все `a/` и `v/` сразу после SQL.
3. **Мастер создаёт `a/<uid>` только при непустых доступах** или если запись уже есть на сервере. Так, если страницу выкатят раньше SQL, она не заполнит базу пустыми `a/`, которые миграция потом не перезапишет (`on conflict do nothing`).
4. **Заявки применяет только мастер** (`syncReqs` вызывается только при `IS_M`). Заявки, подтверждённые в старой вкладке Лены после SQL, применятся в `a/` при первом открытии новой страницы Лены (их id не будет в `a/.appliedReqs`).
5. **Миграция кладёт в `appliedReqs` объединение** `u.appliedReqs` и id всех заявок `pr/…` этой ученицы со статусом `ok` — чтобы новая страница Лены не применила старую заявку на обратную связь второй раз (+30 дней).
6. **`STAFF` в коде убирается**, «без оплат» = `a/.free` (один источник правды с базой).
7. **В интерфейсе 7-я ступень остаётся «подарком»** (`owns(u,7)` = true, как сейчас), база отдаёт видео 7-й по правилу 1–6. Расхождение возможно, только если Лена вручную перевела прогресс ученицы на 7-ю без оплаты 1–6 — см. «На что смотреть при проверке».
8. **Удаление ученицы.** Кнопки удаления ученицы в интерфейсе нет; удалить можно только в Supabase (строку `u/…` или пользователя в Authentication). Тогда `a/<id>` остаётся «сиротой»: её видит только мастер, страница такие записи пропускает (нет `u/` — нет ученицы), ступени никому не открываются (uid удалённого пользователя больше никто не получит; при повторной регистрации будет новый id). Запрет на удаление действует только через API: в SQL Editor (владелец таблицы, RLS не применяется) сирот можно удалить файлом `supabase/access-orphans.sql`. Если в интерфейс позже добавят удаление ученицы, `a/` так же останется сиротой — это безопасно.
9. **Резервная копия** — отдельный файл. В `create table docs_backup as select * from docs` новая таблица в `public` без RLS доступна через API всем вошедшим, поэтому в файле сразу `enable row level security` и `revoke all ... from anon, authenticated`.

## На что смотреть при проверке

1. Ученица с `owned` в виде строк (`["1","2"]`) после переноса: `has_stage` должен видеть ступени (миграция приводит к числам) — тест в задаче 3.
2. Лена убрала последнюю ссылку на видео ступени: `v/<n>` переписывается пустым `{videos:{}}`, а не удаляется (удаление запрещено) — тест в задаче 7.
3. Ученица отправила заявку, Лена подтвердила её в старой вкладке после SQL: доступ применяется при открытии новой страницы Лены — тест в задаче 8.
4. Старая вкладка ученицы получает `a/` и `v/` при опросе: не пытается их удалить с ошибкой-тостом и не падает — тест в задаче 8.
5. Лена вручную перевела прогресс на 7-ю, а 1–6 не оплачены: интерфейс показывает 7-ю открытой, но без видео. Тестом не закрываем; если это нужно — отдельная задача.

---

## Карта файлов

| Файл | Что делает |
|---|---|
| `supabase/access-migration.sql` (новый) | функции `has_stage`, `student_path_ok`; ограничивающие правила; перенос доступов и видео; проверочный запрос |
| `supabase/access-backup.sql` (новый) | резервная копия `docs` в закрытую таблицу `docs_backup_20261118` |
| `supabase/access-orphans.sql` (новый) | показать и удалить `a/<id>`, у которых нет `u/<id>` (для SQL Editor) |
| `supabase/access-rollback.sql` (новый) | откат: убрать правила и функции, вернуть видео в `p/program`, поля доступа в `u/`, удалить `a/` и `v/` |
| `tests/db/harness.js` (новый) | PGlite с заглушками Supabase (`auth.uid()`, роли), запуск SQL-файлов, `as(uid, sql)` |
| `tests/db/*.test.js` (новые) | тесты SQL через `node --test` |
| `tests/mocks/supabase.js` | таблица `docs` в подмене идёт в PGlite с настоящими правилами |
| `index.html` | `ownerOf`, `mayWrite/mayDelete`, `rSerialize/rDeserialize`, `syncReqs`, `noPay` |
| `tests/access.spec.js` (новый) | Playwright: доступы, заявки, видео на новой странице |
| `tests/old-page.spec.js` (новый) | Playwright: старая страница (`git show d0234fe:index.html`) поверх новой базы |
| `package.json`, `playwright.config.js` | `@electric-sql/pglite` в devDependencies, скрипт `test:db`, Playwright не трогает `tests/db/` |

---

### Задача 1: PGlite-стенд с настоящим `setup.sql`

**Файлы:** создать `tests/db/harness.js`, `tests/db/setup.test.js`; изменить `package.json`, `playwright.config.js`.

**Интерфейсы (производит):**
- `makeDb({ migrate = false } = {}) -> Promise<Db>`: новый PGlite, заглушки Supabase, `supabase/setup.sql`, при `migrate` ещё `supabase/access-migration.sql`.
- `Db.addUser(email) -> Promise<uuid>`: строка в `auth.users`.
- `Db.makeMaster(uid)`: строка в `public.masters`.
- `Db.as(uid | null, sql, params?) -> Promise<{rows, error}>`: транзакция с `set local role authenticated` и `set_config('request.jwt.claim.sub', uid, true)`; ошибку возвращает, а не бросает.
- `Db.root(sql, params?)`: запрос от владельца таблиц (как SQL Editor).
- `Db.runFile(relPath)`: выполнить SQL-файл целиком.
- `Db.doc(path) -> Promise<row|null>`: прочитать строку от владельца.

Заглушки Supabase: роли `anon`, `authenticated` (nologin); схема `auth`, таблица `auth.users(id uuid primary key, email text)`, функция `auth.uid()` = `nullif(current_setting('request.jwt.claim.sub', true), '')::uuid`.

- [ ] **Шаг 1:** `npm i -D @electric-sql/pglite@<последняя 0.x старше двух недель>`; в `package.json` скрипт `"test:db": "node --test tests/db/"`; в `playwright.config.js` `testIgnore: 'db/**'`.
- [ ] **Шаг 2: Тест, фиксирующий текущий баг (должен упасть)** — `setup.test.js`:
  - `ученица не может создать a/<свой id>`: `as(student, insert into docs(path,owner,data) values ('a/'||uid, uid, '{"owned":[1,2,3,4,5,6]}'))` → `error` не null.
  - `ученица видит свои документы и общие, но не чужие` (должен пройти и сейчас).
- [ ] **Шаг 3:** `npm run test:db` → первый тест FAIL (запись прошла), второй PASS. Так проверяем, что стенд и правда исполняет RLS.
- [ ] **Шаг 4: Коммит** `test: PGlite harness running real setup.sql`. (Падающий тест отмечаем `{ todo: 'закрывается в задаче 2' }`, чтобы в коммите набор был зелёным.)

### Задача 2: Правила доступа в `access-migration.sql`

**Файлы:** создать `supabase/access-migration.sql` (часть 1 — функции и правила); тест `tests/db/policies.test.js`.

**Интерфейсы (производит):**
- `public.has_stage(n int) returns boolean` — security definer, stable, `set search_path = public`, `grant execute ... to authenticated`, `revoke ... from public`. Логика: `is_master()` или в `docs` есть `a/<auth.uid()>`, где `free = true`, или (`n` 1–6 и `owned @> to_jsonb(n)`), или (`n = 7` и `owned @> '[1,2,3,4,5,6]'`).
- `public.student_path_ok(p text, o uuid, d jsonb) returns boolean` — без обращений к таблицам; true только если `o = auth.uid()` и одно из: `p = 'u/'||uid`; `p like 's/'||uid||'~%'`; `p like 'm/'||uid||'~%'`; `p like 'n/%'`; `p like 'pr/%'` и `d->>'u' = uid::text` и `d->>'st' = 'wait'`.
- Ограничивающие правила на `public.docs` (все `drop policy if exists` перед `create`):
  - `docs_v_select` (select): `path !~ '^v/' or public.is_master() or case when path ~ '^v/[1-7]$' then public.has_stage(substring(path from 3)::int) else false end`.
  - `docs_paths_insert` (insert, with check): `is_master() or student_path_ok(path, owner, data)`.
  - `docs_paths_update` (update): using и with check — то же выражение (using проверяет старую строку, check — новую).
  - `docs_paths_delete` (delete, using): `path !~ '^(a|v)/' and (is_master() or student_path_ok(path, owner, data))`.

- [ ] **Шаг 1: Тесты (падают)** — `policies.test.js`, стенд `makeDb({migrate:true})`, ученица A (owned [1]), ученица B, мастер; данные засевает `root`:
  - `чтение v/ не вызывает рекурсию`: `as(A, select path from docs where path like 'v/%')` → `error` null и вернулось ровно `['v/1']` (это тот самый случай «infinite recursion detected in policy»).
  - `A не видит v/2 и v/7; после owned [1..6] видит v/7; free видит всё; мастер видит всё`.
  - `A не может удалить свою a/ и создать заново`: delete → в базе строка осталась; insert новой `a/A` → error.
  - `A не может создать a/… и v/… со своим owner`: `a/A`, `a/xyz`, `v/3` → error.
  - `A не может поменять owner у существующей записи`: `update docs set owner = null where path = 'u/'||A` → строка не изменилась или error; `update ... set owner = A where path = 'p/program'` → 0 строк.
  - `A не может перевести свою заявку из wait в ok`: insert `pr/1` с `st:'wait', u:A` → ок; update на `st:'ok'` → error/0 строк; insert `pr/2` сразу с `st:'ok'` → error; insert `pr/3` с `u: B` → error.
  - `A не может писать pay/…, p/…, u/<B>, s/<B>~1`.
  - `A может писать u/A, s/A~1, m/A~1~img~0, n/x, pr/… со st wait` (обычная работа не сломана).
  - `мастер пишет a/ и v/, но не может их удалить`.
  - `владелец таблицы (SQL Editor) может удалить a/` — `root(delete ... 'a/'||A)` → строки нет.
- [ ] **Шаг 2:** `npm run test:db` → FAIL (файла нет / правила не действуют).
- [ ] **Шаг 3:** Написать часть 1 `access-migration.sql` по интерфейсам выше. Заголовок файла — по образцу `setup.sql` (что делает, «вставь целиком → Run», «перед запуском сделай копию: access-backup.sql»).
- [ ] **Шаг 4:** `npm run test:db` → PASS; повторный `runFile` той же миграции без ошибок.
- [ ] **Шаг 5: Коммит** `db: restrictive RLS — student path whitelist, has_stage for lesson videos`.

### Задача 3: Перенос данных в `access-migration.sql`

**Файлы:** дописать `supabase/access-migration.sql` (часть 2); тест `tests/db/migration.test.js`.

Шаги переноса (все повторяемые):
1. Для каждой строки `u/<uid>` с `owner is not null` — `insert a/<uid>`, owner = uid, `data = {owned: числа из u.owned без дублей, по возрастанию, fbUntil: u.fbUntil или null, free: false, sessions: u.sessions или 0, appliedReqs: u.appliedReqs ∪ id заявок pr/ с u = uid и st = 'ok'}`, `on conflict (path) do nothing`.
2. Аккаунт `darynaliakhova@gmail.com` (из `auth.users`): upsert `a/<id>` с `free: true` (при конфликте `data = data || '{"free":true}'`), остальные поля как в п.1 или пустые.
3. Для каждой ступени из `p/program.data.program`, у которой есть хоть одна непустая `video`: upsert `v/<n>`, owner null, `videos = старые videos || {<id урока>: <ссылка>}`.
4. Убрать ключ `video` у всех уроков в `p/program` (если ключей нет — строка не меняется).
5. В конце — проверочный `select`: ученицы (имя, почта из `u/`), у которых в `a/.owned` есть ступень без подтверждённой оплаты (`pay/` с `item.kind = 'stage'` и тем же `n`, или `item.kind = 'course'` для 1–6), плюс у кого в `u/` стояло `free: true`. Колонки: `name, email, owned, not_paid, legacy_free`.

- [ ] **Шаг 1: Тесты (падают)** — засеять «как сейчас в боевой базе»: ученица с `owned [1,2]`, `fbUntil`, `sessions 5`, `appliedReqs [10]`, заявка `pr/11` ok; ученица с `owned ["3"]`; ученица с `free: true` в `u/`; Дарина; программа с видео в ступенях 1 и 3:
  - `доступы перенесены в a/` (точные значения, `appliedReqs` = [10, 11]).
  - `строки owned стали числами`, `has_stage(3)` у второй ученицы true.
  - `free только у Дарины`, у ученицы с `u.free` — false и она есть в проверочном запросе.
  - `видео разложены по v/1 и v/3, в p/program нет ни одного video`.
  - `повторный запуск ничего не меняет` (снимок всех строк до и после второго запуска, без учёта `updated_at`) и не затирает правку мастера в `a/` между запусками.
  - `проверочный запрос показывает ученицу с неоплаченной ступенью`.
- [ ] **Шаг 2:** `npm run test:db` → FAIL.
- [ ] **Шаг 3:** Дописать часть 2.
- [ ] **Шаг 4:** `npm run test:db` → PASS.
- [ ] **Шаг 5: Коммит** `db: migrate existing access to a/<uid> and lesson videos to v/<n>`.

### Задача 4: Резервная копия, откат и «сироты»

**Файлы:** создать `supabase/access-backup.sql`, `supabase/access-rollback.sql`, `supabase/access-orphans.sql`; тест `tests/db/rollback.test.js`.

- `access-backup.sql`: `create table if not exists public.docs_backup_20261118 as select * from public.docs;` + `enable row level security` + `revoke all ... from anon, authenticated` + `select count(*)` из обеих таблиц для сверки. Повторный запуск не перезаписывает копию (`if not exists`).
- `access-rollback.sql`: убрать 4 правила и 2 функции; вернуть `video` в уроки `p/program` из `v/`; в каждый `u/<uid>` записать `owned, fbUntil, sessions, appliedReqs` из `a/<uid>`; удалить `a/` и `v/`. Вариант «полностью вернуть таблицу из копии» — закомментированный блок с предупреждением: пропадёт всё, что ученицы написали после копии.

- `access-orphans.sql`: сначала `select` сирот (`a/<id>` без `u/<id>`: путь, owned, fbUntil), затем `delete` тех же строк; повторный запуск ничего не делает.

- [ ] **Шаг 1: Тесты (падают):** `сироты: удаляются только a/ без u/, остальные a/ на месте`; `копия закрыта от учениц` (`as(A, select from docs_backup_20261118)` → error); `после отката старая схема: правила как в setup.sql, видео в p/program, owned в u/, a/ и v/ нет`; `откат после того, как мастер открыл ступень в a/, переносит её в u/`.
- [ ] **Шаг 2:** FAIL → **Шаг 3:** написать файлы → **Шаг 4:** PASS.
- [ ] **Шаг 5: Коммит** `db: backup and rollback scripts for access migration`.

### Задача 5: Подмена Supabase в Playwright на настоящих правилах

**Файлы:** изменить `tests/mocks/supabase.js`.

**Интерфейсы:**
- Потребляет: `makeDb` из задачи 1.
- Производит: `SupabaseMock.create({ migrate = true }) -> Promise<SupabaseMock>` (асинхронный конструктор); `addUser(email, password, name, master) -> Promise<uuid>` (пишет и в `auth.users`, и в `masters`); `mock.db` — тот же `Db` для засева и проверок в тестах.
- Обработчик `/rest/v1/docs` переводит запросы страницы в SQL через `db.as(uid, …)`: GET (`select`, `path=eq.`, `path=in.(…)`, `order=path`, `offset`, `limit`), POST upsert (`on conflict (path) do update`), PATCH с `path=eq.` и необязательным `updated_at=eq.`, DELETE. Ошибка RLS → 403 `{code:'42501'}`, как PostgREST. `updated_at` из базы передаётся строкой без изменений.
- `/rest/v1/rpc/is_master` → `select public.is_master()` от имени пользователя.

- [ ] **Шаг 1: Тест** `tests/access.spec.js` → `подмена: ученица регистрируется и видит кабинет без ошибок` (вход через форму `#fUp`, `page.errors` пуст, в базе есть `u/<id>`).
- [ ] **Шаг 2:** `npx playwright test tests/access.spec.js` → PASS. `npm test` → `cabinet.spec.js` зелёный, как до изменений.
- [ ] **Шаг 3: Коммит** `test: Supabase mock stores docs in PGlite with real RLS`.

### Задача 6: Страница — доступы из `a/<uid>`

**Файлы:** изменить `index.html` (`ownerOf` ~3943, `mayWrite` ~3976, `rSerialize` ~3951, `rDeserialize` ~3958, `rPush` ~4000, `rApply` ~4044, `noPay`/`STAFF` ~2334); тест `tests/access.spec.js`.

**Интерфейсы (производит):**
- `ACCESS_KEYS = ["owned","fbUntil","free","sessions","appliedReqs"]`; `accessOf(u) -> {owned, fbUntil, free, sessions, appliedReqs}` с умолчаниями.
- `ownerOf("a/<id>") = id`, `ownerOf("v/<n>") = null`.
- `mayWrite(p)`: мастер — всё; ученица — только `u/ s/ m/ n/ pr/`.
- `mayDelete(p) = mayWrite(p) && !/^(a|v)\//.test(p)`; цикл удаления в `rPush` использует `mayDelete`.
- `rSerialize`: `a/<id>` = `accessOf(u)` (для мастера — только если доступы непустые или путь есть в `rRemote`, решение 3); `u/<id>` сохраняет поля доступа как зеркало (решение 1).
- `rDeserialize`: после `u/` накладывает `a/<id>` на `db.users[id]`, при отсутствии — умолчания; поля доступа из `u/` в расчёт не идут.
- `syncReqs` вызывается из `rApply` только при `IS_M`.
- `noPay(u) = !!u && !!u.free`; массив `STAFF` удалён.

- [ ] **Шаг 1: Тесты (падают)** — в `access.spec.js` (база засеяна через `mock.db.root` и `runFile` миграции, как в бою):
  - `новая ученица без a/: всё закрыто, страница не падает` (`page.errors` пуст, ступень 1 в состоянии «оплатить»).
  - `ученица с a/.owned [1] видит 1-ю ступень открытой, 2-ю закрытой, прогресс как в u/.cur`.
  - `ученица дописала себе owned в u/ — после обновления страницы ступени всё равно закрыты` (запись через `page.evaluate(() => sbRaw(...))`).
  - `ученица не может записать a/ из страницы` (ответ 403, тост «нет прав» не обязателен).
  - `Лена подтверждает заявку на ступень → a/.owned содержит n`; `на весь курс → a/.owned = [1..6]`; `на обратную связь → a/.fbUntil = сегодня + 30`; в каждом случае у ученицы в открытой вкладке в течение 20 с открывается ступень / появляется «обратная связь до …».
  - `Лена вручную открывает ступень (#cStage) → a/.owned`.
  - `браузер ученицы не применяет подтверждённую заявку сам` (в её запросах нет записи `a/`).
  - `Дарина (free в a/) видит все ступени открытыми`.
  - `ученицу удалили в Supabase (строка u/ удалена, a/ осталась): страница Лены открывается без ошибок, ученицы нет в списке, a/ не пересоздаёт u/ и не удаляется`.
- [ ] **Шаг 2:** FAIL.
- [ ] **Шаг 3:** Реализовать по интерфейсам.
- [ ] **Шаг 4:** `npm test` → PASS (включая `cabinet.spec.js` в демо-режиме: там `CLOUD` выключен и поля доступа живут в `u`, как раньше).
- [ ] **Шаг 5: Коммит** `Access records a/<uid>: students read, only Lena writes`.

### Задача 7: Страница — видео из `v/<n>`

**Файлы:** изменить `index.html` (`rSerialize`, `rDeserialize`); тест `tests/access.spec.js`.

**Интерфейсы:**
- `rSerialize`: `p/program` — программа без `video` у уроков; `v/<n>` = `{videos:{<lesson.id>: <video>}}` для каждой ступени программы, всегда (даже пустой, решение 2). Пишет только мастер (через `mayWrite`).
- `rDeserialize`: `video` урока = `v/<n>.data.videos[lesson.id]` или `""`.

- [ ] **Шаг 1: Тесты (падают):**
  - `ученица с owned [1]: в уроке 1-й ступени есть «Открыть видео ↗» с нужной ссылкой; в базе ей не видны v/2…v/7`.
  - `после покупки курса, подтверждённой Леной, видны видео 7-й ступени` (запрос `v/7` от ученицы возвращает строку).
  - `Лена меняет ссылку урока в редакторе программы → меняется v/<n>, в p/program ссылки нет`.
  - `Лена стирает единственную ссылку ступени → v/<n> = {videos:{}}, строка не удалена`.
  - `Дарина видит видео всех ступеней`.
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализовать → **Шаг 4:** `npm test` PASS.
- [ ] **Шаг 5: Коммит** `Lesson videos in v/<n>, readable only for paid stages`.

### Задача 8: Старая страница поверх новой базы + инструкция по выкату

**Файлы:** создать `tests/old-page.spec.js`; инструкция — в шапке `supabase/access-migration.sql` и в итоговом сообщении Дарине.

Старая страница берётся в тесте командой `git show d0234fe:index.html` во временный файл рядом с `index.html` (те же относительные пути к `assets/`, `theme.css`); файл удаляется в `afterAll`.

- [ ] **Шаг 1: Тесты** (база засеяна как в бою и прогнана миграция):
  - `старая страница ученицы: кабинет открывается без ошибок, замки как раньше, видео нет` (`page.errors` пуст).
  - `старая страница ученицы не удаляет a/ и v/ и не показывает тост «нет прав» за 15 с опроса`.
  - `старая страница Лены не удаляет a/ и v/ за 15 с опроса` (после серии `persist`).
  - `заявка, подтверждённая в старой вкладке Лены, применяется в a/ при открытии новой страницы Лены` (Review Focus 3).
  - `новая страница после изменения u/ новой ученицей: старая вкладка не падает` (зеркало, решение 1).
- [ ] **Шаг 2:** `npx playwright test tests/old-page.spec.js` → PASS (если что-то падает — чинить в новой странице или SQL, не в старой).
- [ ] **Шаг 3:** Порядок выката — в шапку `access-migration.sql`: 1) `access-backup.sql`; 2) `access-migration.sql`, посмотреть проверочный запрос; 3) сразу слить ветку в `main` (GitHub Pages обновится за 1–2 минуты); 4) Лене и ученицам обновить страницу; 5) если что-то не так — `access-rollback.sql` и откат коммита в `main`.
- [ ] **Шаг 4:** Полный прогон `npm run test:db && npm test` → всё PASS.
- [ ] **Шаг 5: Коммит** `test: old cached page keeps working after migration; rollout notes`.

---

### Задача 9 (НА ПОТОМ, через 1–2 недели после выката — сейчас не выполнять): убрать зеркало доступов из `u/`

Когда у всех обновилась страница (Лена и ученицы хотя бы раз зашли после выката), зеркало (решение 1) больше не нужно.

**Файлы:** `index.html` (`rSerialize`: из `u/<id>` убрать `ACCESS_KEYS`); новый `supabase/access-cleanup-u.sql` (убрать `owned, fbUntil, free, sessions, appliedReqs` из всех `u/…`, повторяемо); тесты в `tests/access.spec.js` и `tests/db/`.

- [ ] **Шаг 1: Тесты:** `u/ после сохранения не содержит полей доступа`; `ступени и видео у ученицы как раньше`; `SQL очистки убирает поля из всех u/ и не трогает a/`.
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализовать → **Шаг 4:** PASS.
- [ ] **Шаг 5:** Тест `tests/old-page.spec.js` про зеркало удалить (старая страница больше не поддерживается), остальные оставить.
- [ ] **Шаг 6: Коммит** `Stop mirroring access fields into u/ profile`. Выкат: сначала страница, потом SQL очистки.
