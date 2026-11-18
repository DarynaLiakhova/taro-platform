// Правила доступа боевого supabase/setup.sql на настоящем Postgres
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./harness');

test('ученица не может создать a/<свой id>', { todo: 'закрывается в задаче 2' }, async () => {
  const db = await makeDb();
  const uid = await db.addUser('s@example.com');
  const { error } = await db.as(uid,
    `insert into docs(path, owner, data) values ('a/' || $1::text, $1::uuid, '{"owned":[1,2,3,4,5,6]}')`, [uid]);
  assert.notEqual(error, null);
});

test('ученица видит свои документы и общие, но не чужие', async () => {
  const db = await makeDb();
  const s1 = await db.addUser('s1@example.com');
  const s2 = await db.addUser('s2@example.com');
  await db.root(`insert into docs(path, owner, data) values
    ('u/' || $1::text, $1::uuid, '{}'), ('u/' || $2::text, $2::uuid, '{}'), ('program', null, '{}')`, [s1, s2]);
  const { rows, error } = await db.as(s1, 'select path from docs order by path');
  assert.equal(error, null);
  assert.deepEqual(rows.map(r => r.path), ['program', 'u/' + s1].sort());
});

test('migrate:true без файла миграции даёт понятную ошибку', async () => {
  const fs = require('node:fs');
  if (fs.existsSync(require('node:path').join(__dirname, '../../supabase/access-migration.sql'))) return;
  await assert.rejects(makeDb({ migrate: true }), /access-migration\.sql/);
});
