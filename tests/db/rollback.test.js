// Резервная копия, откат и «сироты»: supabase/access-backup.sql,
// supabase/access-rollback.sql, supabase/access-orphans.sql
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./harness');

const BACKUP = 'supabase/access-backup.sql';
const ROLLBACK = 'supabase/access-rollback.sql';
const ORPHANS = 'supabase/access-orphans.sql';

const PROGRAM = {
  program: [
    { n: 1, title: 'Ступень 1', lessons: [
      { id: 'l1_1', title: 'Урок 1', video: 'https://v/1_1' },
      { id: 'l1_2', title: 'Урок 2', video: '' },
    ] },
    { n: 2, title: 'Ступень 2', lessons: [{ id: 'l2_1', title: 'Урок 1', video: 'https://v/2_1' }] },
  ],
  links: { tg: 'https://t.me/x' },
};

// Старая база → миграция (a/ и v/ созданы из u/ и p/program)
async function setup(t) {
  const db = await makeDb({ migrate: false });
  t.after(() => db.close());
  const A = await db.addUser('a@example.com');
  const B = await db.addUser('b@example.com');
  const M = await db.addUser('m@example.com');
  await db.makeMaster(M);
  const put = (p, owner, data) => db.root('insert into docs(path, owner, data) values ($1, $2, $3)', [p, owner, data]);
  await put('u/' + A, A, { id: A, name: 'Анна', owned: [1], fbUntil: '2026-12-31', sessions: 5, appliedReqs: [10] });
  await put('u/' + B, B, { id: B, name: 'Вера', owned: [], fbUntil: null });
  await put('p/program', null, PROGRAM);
  await db.runFile('supabase/access-migration.sql');
  return { db, A, B, M };
}

const paths = async (db, like) =>
  (await db.root('select path from docs where path like $1 order by path', [like])).rows.map(r => r.path);

test('копия закрыта от учениц', async (t) => {
  const { db, A } = await setup(t);
  await db.runFile(BACKUP);
  const { error } = await db.as(A, 'select * from public.docs_backup_20261118');
  assert.notEqual(error, null);
  const { rows } = await db.root(`select relrowsecurity from pg_class where oid = 'public.docs_backup_20261118'::regclass`);
  assert.equal(rows[0].relrowsecurity, true);
});

test('копия: совпадает по числу строк, повторный запуск её не перезаписывает', async (t) => {
  const { db, A } = await setup(t);
  const res = await db.runFile(BACKUP);
  const last = res[res.length - 1].rows[0];
  assert.equal(Number(last.docs), Number(last.backup));
  await db.root(`delete from docs where path = 'u/' || $1::text`, [A]);
  await db.runFile(BACKUP);
  const { rows } = await db.root(`select count(*)::int as n from docs_backup_20261118 where path = 'u/' || $1::text`, [A]);
  assert.equal(rows[0].n, 1);
});

test('после отката старая схема: правила как в setup.sql, видео в p/program, owned в u/, a/ и v/ нет', async (t) => {
  const { db, A, B } = await setup(t);
  await db.runFile(ROLLBACK);
  assert.deepEqual(await paths(db, 'a/%'), []);
  assert.deepEqual(await paths(db, 'v/%'), []);
  const { rows: pol } = await db.root(`select policyname from pg_policies where tablename = 'docs' order by 1`);
  assert.deepEqual(pol.map(r => r.policyname), ['docs_delete', 'docs_insert', 'docs_select', 'docs_update']);
  const { rows: fn } = await db.root(
    `select proname from pg_proc where proname in ('has_stage','student_path_ok')`);
  assert.deepEqual(fn, []);
  const prog = (await db.doc('p/program')).data;
  assert.deepEqual(prog, PROGRAM);
  const uA = (await db.doc('u/' + A)).data;
  assert.deepEqual([uA.owned, uA.fbUntil, uA.sessions, uA.appliedReqs], [[1], '2026-12-31', 5, [10]]);
  assert.equal(uA.name, 'Анна');
  const uB = (await db.doc('u/' + B)).data;
  assert.deepEqual([uB.owned, uB.fbUntil, uB.sessions, uB.appliedReqs], [[], null, 0, []]);
  // ученица видит программу с видео
  const { rows, error } = await db.as(A, `select data from docs where path = 'p/program'`);
  assert.equal(error, null);
  assert.equal(rows[0].data.program[0].lessons[0].video, 'https://v/1_1');
});

test('откат после того, как мастер открыл ступень в a/, переносит её в u/', async (t) => {
  const { db, A, M } = await setup(t);
  const up = await db.as(M, `update docs set data = jsonb_set(data, '{owned}', '[1,2,3]') where path = 'a/' || $1::text`, [A]);
  assert.equal(up.error, null);
  await db.root(`update docs set data = jsonb_set(data, '{videos,l1_2}', '"https://v/1_2"') where path = 'v/1'`);
  await db.runFile(ROLLBACK);
  assert.deepEqual((await db.doc('u/' + A)).data.owned, [1, 2, 3]);
  const prog = (await db.doc('p/program')).data.program;
  assert.equal(prog[0].lessons[1].video, 'https://v/1_2');
  assert.equal(prog[1].lessons[0].video, 'https://v/2_1');
});

test('после отката ученица снова пишет в u/ как раньше, has_stage нет', async (t) => {
  const { db, A } = await setup(t);
  await db.runFile(ROLLBACK);
  let r = await db.as(A, `update docs set data = jsonb_set(data, '{owned}', '[1,2]') where path = 'u/' || $1::text`, [A]);
  assert.equal(r.error, null);
  assert.deepEqual((await db.doc('u/' + A)).data.owned, [1, 2]);
  r = await db.as(A, `insert into docs(path, owner, data) values ('x/free', $1, '{}')`, [A]);
  assert.equal(r.error, null);
  r = await db.as(A, 'select public.has_stage(1)');
  assert.notEqual(r.error, null);
});

test('откат повторяемый и не ломает базу без миграции', async (t) => {
  const { db, A } = await setup(t);
  await db.runFile(ROLLBACK);
  const first = (await db.root('select path, data from docs order by path')).rows;
  await db.runFile(ROLLBACK);
  assert.deepEqual((await db.root('select path, data from docs order by path')).rows, first);
  const fresh = await makeDb({ migrate: false });
  t.after(() => fresh.close());
  await fresh.runFile(ROLLBACK);
  assert.ok(A);
});

test('сироты: удаляются только a/ без u/, остальные a/ на месте', async (t) => {
  const { db, A, B } = await setup(t);
  const X = await db.addUser('x@example.com');
  await db.root(`insert into docs(path, owner, data) values ('a/' || $1::text, $1::uuid, '{"owned":[2],"fbUntil":null}')`, [X]);
  const res = await db.runFile(ORPHANS);
  const listed = res.find(r => r.fields && r.fields.some(f => f.name === 'path'));
  assert.deepEqual(listed.rows.map(r => r.path), ['a/' + X]);
  assert.deepEqual(listed.rows[0].owned, [2]);
  assert.deepEqual(await paths(db, 'a/%'), ['a/' + A, 'a/' + B].sort());
  assert.notEqual(await db.doc('u/' + A), null);
  await db.runFile(ORPHANS);
  assert.deepEqual(await paths(db, 'a/%'), ['a/' + A, 'a/' + B].sort());
});
