// Ограничивающие правила из supabase/access-migration.sql:
// белый список путей для ученицы, a/ пишет только мастер, v/<n> видно только при has_stage(n)
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, assertRlsError } = require('./harness');

// Стенд: ученица A (куплена ступень 1), ученица B, мастер M; уроки v/1..v/7 и программа
async function setup(t) {
  const db = await makeDb({ migrate: true });
  t.after(() => db.close());
  const A = await db.addUser('a@example.com');
  const B = await db.addUser('b@example.com');
  const M = await db.addUser('m@example.com');
  await db.makeMaster(M);
  await db.root(`insert into docs(path, owner, data) values
    ('a/' || $1::text, $1::uuid, '{"owned":[1]}'),
    ('a/' || $2::text, $2::uuid, '{"owned":[]}'),
    ('u/' || $1::text, $1::uuid, '{"name":"A"}'),
    ('p/program', null, '{"stages":7}')`, [A, B]);
  for (let n = 1; n <= 7; n++) {
    // миграция уже создала пустые v/1…v/7 — заполняем их
    await db.root(`insert into docs(path, owner, data) values ($1, null, $2) on conflict (path) do update set data = excluded.data`, ['v/' + n, { url: 'https://x/' + n }]);
  }
  return { db, A, B, M };
}

async function videos(db, uid) {
  const { rows, error } = await db.as(uid, `select path from docs where path like 'v/%' order by path`);
  assert.equal(error, null);
  return rows.map(r => r.path);
}

const ALL_V = ['v/1', 'v/2', 'v/3', 'v/4', 'v/5', 'v/6', 'v/7'];

test('чтение v/ не вызывает рекурсию', async (t) => {
  const { db, A } = await setup(t);
  const { rows, error } = await db.as(A, `select path from docs where path like 'v/%'`);
  assert.equal(error, null);
  assert.deepEqual(rows.map(r => r.path), ['v/1']);
});

test('A не видит v/2 и v/7; после owned [1..6] видит v/7; free видит всё; мастер видит всё', async (t) => {
  const { db, A, B, M } = await setup(t);
  assert.deepEqual(await videos(db, A), ['v/1']);
  assert.deepEqual(await videos(db, B), []);

  await db.root(`update docs set data = '{"owned":[1,2,3,4,5]}' where path = 'a/' || $1::text`, [A]);
  assert.deepEqual(await videos(db, A), ['v/1', 'v/2', 'v/3', 'v/4', 'v/5']);

  await db.root(`update docs set data = '{"owned":[1,2,3,4,5,6]}' where path = 'a/' || $1::text`, [A]);
  assert.deepEqual(await videos(db, A), ALL_V);

  await db.root(`update docs set data = '{"owned":[],"free":true}' where path = 'a/' || $1::text`, [B]);
  assert.deepEqual(await videos(db, B), ALL_V);

  assert.deepEqual(await videos(db, M), ALL_V);
});

test('A не может удалить свою a/ и создать заново', async (t) => {
  const { db, A } = await setup(t);
  const del = await db.as(A, `delete from docs where path = 'a/' || $1::text returning path`, [A]);
  assert.equal(del.error, null);
  assert.deepEqual(del.rows, []);
  assert.deepEqual((await db.doc('a/' + A)).data, { owned: [1] });

  await db.root(`delete from docs where path = 'a/' || $1::text`, [A]);
  const ins = await db.as(A,
    `insert into docs(path, owner, data) values ('a/' || $1::text, $1::uuid, '{"owned":[1,2,3,4,5,6]}')`, [A]);
  assertRlsError(ins.error);
  assert.equal(await db.doc('a/' + A), null);
});

test('A не может создать a/… и v/… со своим owner', async (t) => {
  const { db, A, B } = await setup(t);
  await db.root(`delete from docs where path = 'a/' || $1::text`, [B]);
  for (const p of ['a/' + B, 'a/xyz', 'v/3', 'v/8']) {
    await db.root(`delete from docs where path = $1`, [p]);
    const { error } = await db.as(A,
      `insert into docs(path, owner, data) values ($1, $2::uuid, '{"owned":[1,2,3,4,5,6]}')`, [p, A]);
    assertRlsError(error);
    assert.equal(await db.doc(p), null, p);
  }
});

test('A не может поменять owner у существующей записи', async (t) => {
  const { db, A } = await setup(t);
  const r1 = await db.as(A, `update docs set owner = null where path = 'u/' || $1::text`, [A]);
  assertRlsError(r1.error);
  assert.equal((await db.doc('u/' + A)).owner, A);

  const r2 = await db.as(A, `update docs set owner = $1::uuid where path = 'p/program' returning path`, [A]);
  assert.equal(r2.error, null);
  assert.deepEqual(r2.rows, []);
  assert.equal((await db.doc('p/program')).owner, null);
});

test('A не может перевести свою заявку из wait в ok', async (t) => {
  const { db, A, B } = await setup(t);
  const ins = await db.as(A, `insert into docs(path, owner, data) values ('pr/1', $1::uuid, $2)`,
    [A, { st: 'wait', u: A }]);
  assert.equal(ins.error, null);

  const upd = await db.as(A, `update docs set data = jsonb_set(data, '{st}', '"ok"') where path = 'pr/1'`);
  assertRlsError(upd.error);
  assert.equal((await db.doc('pr/1')).data.st, 'wait');

  const ok = await db.as(A, `insert into docs(path, owner, data) values ('pr/2', $1::uuid, $2)`,
    [A, { st: 'ok', u: A }]);
  assertRlsError(ok.error);
  assert.equal(await db.doc('pr/2'), null);

  const other = await db.as(A, `insert into docs(path, owner, data) values ('pr/3', $1::uuid, $2)`,
    [A, { st: 'wait', u: B }]);
  assertRlsError(other.error);
  assert.equal(await db.doc('pr/3'), null);
});

test('A не может писать pay/…, p/…, u/<B>, s/<B>~1', async (t) => {
  const { db, A, B } = await setup(t);
  for (const p of ['pay/1', 'p/x', 'u/' + B, 's/' + B + '~1', 'u/' + A + 'x', 'program']) {
    const { error } = await db.as(A, `insert into docs(path, owner, data) values ($1, $2::uuid, '{}')`, [p, A]);
    assertRlsError(error);
    assert.equal(await db.doc(p), null, p);
  }
  // и не может переименовать свою запись в чужой путь
  const mv = await db.as(A, `update docs set path = 'pay/1' where path = 'u/' || $1::text`, [A]);
  assertRlsError(mv.error);
  assert.notEqual(await db.doc('u/' + A), null);
});

test('A может писать u/A, s/A~1, m/A~1~img~0, n/x, pr/… со st wait', async (t) => {
  const { db, A } = await setup(t);
  const paths = ['s/' + A + '~1', 'm/' + A + '~1~img~0', 'n/x'];
  for (const p of paths) {
    const { error } = await db.as(A, `insert into docs(path, owner, data) values ($1, $2::uuid, '{"v":1}')`, [p, A]);
    assert.equal(error, null, `${p}: ${error?.message}`);
  }
  const pr = await db.as(A, `insert into docs(path, owner, data) values ('pr/9', $1::uuid, $2)`,
    [A, { st: 'wait', u: A }]);
  assert.equal(pr.error, null);
  paths.push('pr/9');

  const upd = await db.as(A, `update docs set data = '{"name":"A2"}' where path = 'u/' || $1::text`, [A]);
  assert.equal(upd.error, null);
  assert.deepEqual((await db.doc('u/' + A)).data, { name: 'A2' });

  // upsert, как делает платформа
  const up = await db.as(A, `insert into docs(path, owner, data) values ('n/x', $1::uuid, '{"v":2}')
    on conflict (path) do update set data = excluded.data`, [A]);
  assert.equal(up.error, null);
  assert.deepEqual((await db.doc('n/x')).data, { v: 2 });

  for (const p of paths) assert.notEqual(await db.doc(p), null, p);

  const del = await db.as(A, `delete from docs where path = 'n/x' returning path`);
  assert.equal(del.error, null);
  assert.deepEqual(del.rows.map(r => r.path), ['n/x']);
  assert.equal(await db.doc('n/x'), null);
});

test('мастер пишет a/ и v/, но не может их удалить', async (t) => {
  const { db, A, B, M } = await setup(t);
  const upd = await db.as(M, `update docs set data = '{"owned":[1,2]}' where path = 'a/' || $1::text`, [A]);
  assert.equal(upd.error, null);
  assert.deepEqual((await db.doc('a/' + A)).data, { owned: [1, 2] });

  await db.root(`delete from docs where path = 'a/' || $1::text`, [B]);
  const ins = await db.as(M, `insert into docs(path, owner, data) values ('a/' || $1::text, $1::uuid, '{"owned":[3]}')`, [B]);
  assert.equal(ins.error, null);
  assert.deepEqual((await db.doc('a/' + B)).data, { owned: [3] });

  const v = await db.as(M, `update docs set data = '{"url":"https://y/1"}' where path = 'v/1'`);
  assert.equal(v.error, null);
  assert.equal((await db.doc('v/1')).data.url, 'https://y/1');

  const del = await db.as(M, `delete from docs where path in ('a/' || $1::text, 'v/1') returning path`, [A]);
  assert.equal(del.error, null);
  assert.deepEqual(del.rows, []);
  assert.notEqual(await db.doc('a/' + A), null);
  assert.notEqual(await db.doc('v/1'), null);

  // прочее мастер удалять может
  const delU = await db.as(M, `delete from docs where path = 'u/' || $1::text returning path`, [A]);
  assert.deepEqual(delU.rows.map(r => r.path), ['u/' + A]);
});

test('владелец таблицы (SQL Editor) может удалить a/', async (t) => {
  const { db, A } = await setup(t);
  await db.root(`delete from docs where path = 'a/' || $1::text`, [A]);
  assert.equal(await db.doc('a/' + A), null);
});

test('миграцию можно запустить повторно', async (t) => {
  const { db, A } = await setup(t);
  await db.runFile('supabase/access-migration.sql');
  await db.runFile('supabase/access-migration.sql');
  assert.deepEqual(await videos(db, A), ['v/1']);
  const { error } = await db.as(A,
    `insert into docs(path, owner, data) values ('a/x', $1::uuid, '{}')`, [A]);
  assertRlsError(error);
});

test('has_stage и student_path_ok: права на запуск только у authenticated', async (t) => {
  const { db } = await setup(t);
  const { rows } = await db.root(`select p.proname,
      has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      p.prosecdef, p.provolatile
    from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('has_stage', 'student_path_ok') order by p.proname`);
  assert.deepEqual(rows.map(r => [r.proname, r.auth_exec, r.anon_exec]),
    [['has_stage', true, false], ['student_path_ok', true, false]]);
  const hs = rows.find(r => r.proname === 'has_stage');
  assert.equal(hs.prosecdef, true);
  assert.equal(hs.provolatile, 's');
});
