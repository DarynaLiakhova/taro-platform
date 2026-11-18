// Перенос данных из supabase/access-migration.sql (часть 2):
// доступы u/<id> → a/<id>, видео уроков p/program → v/<n>, проверочный запрос в конце
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./harness');

const MIGRATION = 'supabase/access-migration.sql';
const DARYNA = 'darynaliakhova@gmail.com';

const PROGRAM = {
  program: [
    { n: 1, title: 'Ступень 1', price: 100, quiz: [], lessons: [
      { id: 'l1_1', title: 'Урок 1', kind: 'video', video: 'https://v/1_1', dur: 10, notes: '' },
      { id: 'l1_2', title: 'Урок 2', kind: 'video', video: '', dur: 12, notes: '' },
    ] },
    { n: 2, title: 'Ступень 2', price: 100, quiz: [], lessons: [
      { id: 'l2_1', title: 'Урок 1', kind: 'text', video: '', dur: 5, notes: '' },
    ] },
    { n: 3, title: 'Ступень 3', price: 100, quiz: [], lessons: [
      { id: 'l3_1', title: 'Урок 1', kind: 'video', video: 'https://v/3_1', dur: 20, notes: 'x' },
    ] },
  ],
  links: { tg: 'https://t.me/x' },
};

// «Как сейчас в боевой базе»: A — owned [1,2] и заявки, B — owned ["3"], C — free в u/,
// Дарина — есть в auth.users, но без u/; программа с видео в ступенях 1 и 3
async function setup(t) {
  const db = await makeDb({ migrate: false });
  t.after(() => db.close());
  const A = await db.addUser('a@example.com');
  const B = await db.addUser('b@example.com');
  const C = await db.addUser('c@example.com');
  const D = await db.addUser(DARYNA);
  const put = (p, owner, data) => db.root('insert into docs(path, owner, data) values ($1, $2, $3)', [p, owner, data]);
  await put('u/' + A, A, { id: A, name: 'Анна', email: 'a@example.com', cur: { stage: 2, lesson: 1 },
    owned: [1, 2, 1], fbUntil: '2026-12-31', sessions: 5, appliedReqs: [10], fbWarned: '', notes: {} });
  await put('u/' + B, B, { id: B, name: 'Вера', email: 'b@example.com', cur: { stage: 3, lesson: 1 },
    owned: ['3'], fbUntil: null });
  await put('u/' + C, C, { id: C, name: 'Света', email: 'c@example.com', cur: { stage: 1, lesson: 1 },
    owned: [], fbUntil: null, free: true });
  await put('pr/10', A, { id: 10, u: A, item: { kind: 'stage', n: 1 }, amount: 100, method: 'card', at: 'x', st: 'ok' });
  await put('pr/11', A, { id: 11, u: A, item: { kind: 'stage', n: 2 }, amount: 100, method: 'card', at: 'x', st: 'ok' });
  await put('pr/12', A, { id: 12, u: A, item: { kind: 'fb' }, amount: 50, method: 'card', at: 'x', st: 'wait' });
  await put('pr/13', B, { id: 13, u: B, item: { kind: 'course' }, amount: 500, method: 'card', at: 'x', st: 'no' });
  await put('pay/1', A, { id: 1, u: A, item: { kind: 'stage', n: 1 }, amount: 100, method: 'card', at: 'x' });
  await put('pay/2', B, { id: 2, u: B, item: { kind: 'course' }, amount: 500, method: 'card', at: 'x' });
  await put('p/program', null, PROGRAM);
  return { db, A, B, C, D };
}

// Проверочный запрос — последний результат файла
async function migrate(db) {
  const results = await db.runFile(MIGRATION);
  return results[results.length - 1].rows;
}

async function snapshot(db) {
  const { rows } = await db.root('select path, owner, data from docs order by path');
  return rows;
}

test('доступы перенесены в a/', async (t) => {
  const { db, A } = await setup(t);
  await migrate(db);
  const a = await db.doc('a/' + A);
  assert.equal(a.owner, A);
  assert.deepEqual(a.data, { owned: [1, 2], fbUntil: '2026-12-31', free: false, sessions: 5, appliedReqs: [10, 11] });
  // u/ не тронута
  assert.equal((await db.doc('u/' + A)).data.sessions, 5);
});

test('строки owned стали числами', async (t) => {
  const { db, B } = await setup(t);
  await migrate(db);
  assert.deepEqual((await db.doc('a/' + B)).data,
    { owned: [3], fbUntil: null, free: false, sessions: 0, appliedReqs: [] });
  const { rows, error } = await db.as(B, 'select public.has_stage(3) as s3, public.has_stage(1) as s1');
  assert.equal(error, null);
  assert.deepEqual(rows, [{ s3: true, s1: false }]);
});

test('free только у Дарины', async (t) => {
  const { db, A, B, C, D } = await setup(t);
  const report = await migrate(db);
  assert.deepEqual((await db.doc('a/' + D)).data,
    { owned: [], fbUntil: null, free: true, sessions: 0, appliedReqs: [] });
  assert.equal((await db.doc('a/' + D)).owner, D);
  for (const uid of [A, B, C]) assert.equal((await db.doc('a/' + uid)).data.free, false, uid);
  const { rows } = await db.root(`select count(*)::int as n from docs where path like 'a/%' and data->'free' = 'true'`);
  assert.equal(rows[0].n, 1);
  // ученица с u.free — в проверочном запросе
  assert.deepEqual(report.find(r => r.email === 'c@example.com'),
    { name: 'Света', email: 'c@example.com', owned: [], not_paid: [], legacy_free: true });
});

test('у Дарины с u/ доступы переносятся и добавляется free', async (t) => {
  const { db, D } = await setup(t);
  await db.root('insert into docs(path, owner, data) values ($1, $2, $3)',
    ['u/' + D, D, { id: D, name: 'Дарина', email: DARYNA, owned: ['2', 4], fbUntil: null, sessions: 1, free: true }]);
  await migrate(db);
  assert.deepEqual((await db.doc('a/' + D)).data,
    { owned: [2, 4], fbUntil: null, free: true, sessions: 1, appliedReqs: [] });
});

test('без аккаунта Дарины a/ с free не появляется', async (t) => {
  const { db, D } = await setup(t);
  await db.root('delete from auth.users where id = $1', [D]);
  await migrate(db);
  assert.equal(await db.doc('a/' + D), null);
  const { rows } = await db.root(`select count(*)::int as n from docs where path like 'a/%' and data->'free' = 'true'`);
  assert.equal(rows[0].n, 0);
});

test('видео разложены по v/1 и v/3, в p/program нет ни одного video', async (t) => {
  const { db } = await setup(t);
  // v/1 уже есть (ссылку добавил мастер) — она сохраняется
  await db.root(`insert into docs(path, owner, data) values ('v/1', null, '{"videos":{"l1_9":"https://v/old"}}')`);
  await migrate(db);
  const v1 = await db.doc('v/1');
  assert.equal(v1.owner, null);
  assert.deepEqual(v1.data, { videos: { l1_9: 'https://v/old', l1_1: 'https://v/1_1' } });
  assert.deepEqual((await db.doc('v/3')).data, { videos: { l3_1: 'https://v/3_1' } });
  // ступени без ссылок получают пустую v/<n> — первая ссылка сразу ляжет туда, а не в общую программу
  assert.deepEqual((await db.doc('v/2')).data, { videos: {} });
  const { rows: vs } = await db.root(`select path, owner from docs where path like 'v/%' order by path`);
  assert.deepEqual(vs, [1, 2, 3, 4, 5, 6, 7].map(n => ({ path: 'v/' + n, owner: null })));
  const p = (await db.doc('p/program')).data;
  assert.equal(p.program.some(s => s.lessons.some(l => 'video' in l)), false);
  // остальное в программе не изменилось
  const strip = (prog) => prog.program.map(s => ({ ...s, lessons: s.lessons.map(({ video, ...l }) => l) }));
  assert.deepEqual(p.program, strip(PROGRAM));
  assert.deepEqual(p.links, PROGRAM.links);
});

test('повторный запуск ничего не меняет и не затирает правку мастера в a/', async (t) => {
  const { db, A, D } = await setup(t);
  await migrate(db);
  // мастер между запусками: убрал ступень 2 у A, поменял видео в v/1
  await db.root(`update docs set data = jsonb_set(data, '{owned}', '[1]') where path = 'a/' || $1::text`, [A]);
  await db.root(`update docs set data = jsonb_set(data, '{videos,l1_1}', '"https://v/new"') where path = 'v/1'`);
  const before = await snapshot(db);
  const stamp = (await db.root('select path, updated_at from docs order by path')).rows;
  await migrate(db);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual((await db.doc('a/' + A)).data.owned, [1]);
  assert.equal((await db.doc('a/' + D)).data.free, true);
  // и строки даже не перезаписываются
  assert.deepEqual((await db.root('select path, updated_at from docs order by path')).rows, stamp);
});

test('проверочный запрос показывает ученицу с неоплаченной ступенью', async (t) => {
  const { db } = await setup(t);
  const report = await migrate(db);
  assert.deepEqual(Object.keys(report[0]), ['name', 'email', 'owned', 'not_paid', 'legacy_free']);
  // A: ступень 1 оплачена (pay/1), ступень 2 — нет; B оплатила курс; C — legacy free
  assert.deepEqual(report, [
    { name: 'Анна', email: 'a@example.com', owned: [1, 2], not_paid: [2], legacy_free: false },
    { name: 'Света', email: 'c@example.com', owned: [], not_paid: [], legacy_free: true },
  ]);
});

test('ссылка, которую некуда перенести, остаётся в p/program; id заявок вида Date.now() не ломаются', async (t) => {
  const { db, A } = await setup(t);
  const prog = structuredClone(PROGRAM);
  prog.program.push({ n: 'x', title: '?', lessons: [{ id: 'lx', title: '?', video: 'https://v/x' }] });
  prog.program[0].lessons.push({ title: 'без id', video: 'https://v/noid' });
  await db.root(`update docs set data = $1 where path = 'p/program'`, [prog]);
  await db.root('insert into docs(path, owner, data) values ($1, $2, $3)',
    ['pr/1763456789012', A, { id: 1763456789012, u: A, item: { kind: 'fb' }, st: 'ok' }]);
  await migrate(db);
  const p = (await db.doc('p/program')).data;
  assert.equal(p.program[3].lessons[0].video, 'https://v/x');
  assert.equal(p.program[0].lessons[2].video, 'https://v/noid');
  assert.equal('video' in p.program[0].lessons[0], false);
  assert.deepEqual((await db.doc('a/' + A)).data.appliedReqs, [10, 11, 1763456789012]);
});
