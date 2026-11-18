// Стенд для SQL-тестов: настоящий Postgres (PGlite, WASM) + заглушки Supabase + боевой setup.sql.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// Заглушки того, что в Supabase есть «из коробки»
const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

function readSql(relPath) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) throw new Error(`SQL-файл не найден: ${relPath}`);
  return fs.readFileSync(file, 'utf8');
}

class Db {
  constructor(pg) { this.pg = pg; }

  // Запрос от владельца таблиц (как SQL Editor): RLS не действует
  async root(sql, params) { return this.pg.query(sql, params); }

  // Выполнить SQL-файл целиком (в нём может быть несколько команд)
  async runFile(relPath) { return this.pg.exec(readSql(relPath)); }

  async addUser(email, id) {
    const { rows } = await this.pg.query(
      'insert into auth.users(id, email) values (coalesce($2::uuid, gen_random_uuid()), $1) returning id', [email, id ?? null]);
    return rows[0].id;
  }

  async makeMaster(uid) {
    await this.pg.query('insert into public.masters(uid) values ($1)', [uid]);
  }

  // Запрос от имени пользователя (uid или null = вошедший без id): RLS действует.
  // Ошибку не бросает, а возвращает: { rows, error }.
  // Запрос идёт в своей транзакции: при успехе изменения фиксируются (commit),
  // при ошибке — откатываются.
  async as(uid, sql, params) {
    try {
      const rows = await this.pg.transaction(async (tx) => {
        await tx.query('set local role authenticated');
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? '']);
        return (await tx.query(sql, params)).rows;
      });
      return { rows, error: null };
    } catch (error) {
      return { rows: [], error };
    }
  }

  // Закрыть базу (освободить экземпляр WASM) — вызывать в конце каждого теста
  async close() { await this.pg.close(); }

  async doc(p) {
    const { rows } = await this.pg.query('select * from public.docs where path = $1', [p]);
    return rows[0] ?? null;
  }
}

async function makeDb({ migrate = false } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  const db = new Db(pg);
  await db.runFile('supabase/setup.sql');
  if (migrate) await db.runFile('supabase/access-migration.sql');
  return db;
}

// Ошибка именно от правил доступа (RLS, код 42501), а не любая другая
function assertRlsError(error) {
  const assert = require('node:assert/strict');
  assert.notEqual(error, null, 'ожидалась ошибка RLS, а запрос прошёл');
  assert.equal(error.code, '42501', `ожидался код 42501, получено: ${error.code} ${error.message}`);
  assert.match(error.message, /row-level security/);
}

module.exports = { makeDb, assertRlsError };
