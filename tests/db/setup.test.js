// Правила доступа боевого supabase/setup.sql на настоящем Postgres
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, assertRlsError } = require('./harness');

test('ученица не может создать a/<свой id>', async (t) => {
  const db = await makeDb({ migrate: true });
  t.after(() => db.close());
  const uid = await db.addUser('s@example.com');
  const { error } = await db.as(uid,
    `insert into docs(path, owner, data) values ('a/' || $1::text, $1::uuid, '{"owned":[1,2,3,4,5,6]}')`, [uid]);
  assertRlsError(error);
  assert.equal(await db.doc('a/' + uid), null);
});

test('ученица видит свои документы и общие, но не чужие', async (t) => {
  const db = await makeDb();
  t.after(() => db.close());
  const s1 = await db.addUser('s1@example.com');
  const s2 = await db.addUser('s2@example.com');
  await db.root(`insert into docs(path, owner, data) values
    ('u/' || $1::text, $1::uuid, '{}'), ('u/' || $2::text, $2::uuid, '{}'), ('program', null, '{}')`, [s1, s2]);
  const { rows, error } = await db.as(s1, 'select path from docs order by path');
  assert.equal(error, null);
  assert.deepEqual(rows.map(r => r.path), ['program', 'u/' + s1].sort());
});

test('migrate:true загружает миграцию: есть has_stage и student_path_ok', async (t) => {
  const db = await makeDb({ migrate: true });
  t.after(() => db.close());
  const { rows } = await db.root(`select proname from pg_proc
    where pronamespace = 'public'::regnamespace and proname in ('has_stage', 'student_path_ok')
    order by proname`);
  assert.deepEqual(rows.map(r => r.proname), ['has_stage', 'student_path_ok']);
});
