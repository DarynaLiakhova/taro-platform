// Доступ и видео: подмена Supabase на настоящем Postgres (PGlite) с боевыми правилами.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const { SupabaseMock } = require('./mocks/supabase');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

test.setTimeout(90_000);

let sb;
test.afterEach(async () => { await sb?.close(); sb = null; });

test('подмена: ученица регистрируется и видит кабинет без ошибок', async ({ page, context }) => {
  sb = await SupabaseMock.create();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await sb.attach(context);
  await page.goto(APP);
  await page.locator('[data-auth="up"]').first().click();
  await page.fill('#upName', 'Анна');
  await page.fill('#upEmail', 'anna@example.com');
  await page.fill('#upPass', 'Student123!');
  await page.click('#fUp button[type=submit]');
  await expect(page.locator('#fUp')).toBeHidden({ timeout: 10_000 });
  const { rows: [u] } = await sb.db.root("select id from auth.users where email = 'anna@example.com'");
  await expect.poll(async () => !!(await sb.db.doc('u/' + u.id)), { timeout: 15_000 }).toBe(true);
  expect(page.errors).toEqual([]);
});

test('подмена: правила как в PostgREST (чужое скрыто, 403, версия, параллельно)', async () => {
  sb = await SupabaseMock.create();
  const a = await sb.addUser('a@x.io', 'p', 'A');
  const b = await sb.addUser('b@x.io', 'p', 'B');
  const lena = await sb.addUser('l@x.io', 'p', 'L', true);
  const tok = (id) => { const t = 't-' + id; sb.tokens.set(t, id); return { authorization: 'Bearer ' + t }; };
  const call = (m, url, uid, body, prefer) => new Promise((res) => {
    const q = new URL('https://x' + url);
    sb.docsRequest(m, q.searchParams, body || {}, prefer || '', uid).then(res);
  });
  const row = (id, p) => ({ path: p, owner: id, data: { n: p } });
  const first = await call('POST', '/rest/v1/docs?select=updated_at', a, row(a, 'u/' + a));
  expect(first.body[0].updated_at).toMatch(/^\d{4}-\d\d-\d\dT.*[+-]\d\d(:\d\d)?$/);
  const bad = await call('POST', '/rest/v1/docs', a, row(b, 'u/' + b));
  expect(bad.status).toBe(403); expect(bad.body.code).toBe('42501');
  await call('POST', '/rest/v1/docs', b, row(b, 'u/' + b));
  await call('POST', '/rest/v1/docs', lena, row(null, 'p/program'));
  const seenA = (await call('GET', '/rest/v1/docs?select=path&order=path&offset=0&limit=500', a)).body.map((r) => r.path);
  expect(seenA).toEqual(['p/program', 'u/' + a]);
  const inList = await call('GET', '/rest/v1/docs?select=path,data,updated_at&path=in.(' + ['u/' + a, 'u/' + b].map((p) => encodeURIComponent('"' + p + '"')).join(',') + ')', a);
  expect(inList.body.map((r) => r.path)).toEqual(['u/' + a]);
  // оптимистичная запись: версия из GET подходит, старая — нет
  const v = (await call('GET', `/rest/v1/docs?select=updated_at&path=eq.u%2F${a}`, a)).body[0].updated_at;
  const ok = await call('PATCH', `/rest/v1/docs?path=eq.u%2F${a}&updated_at=eq.${encodeURIComponent(v)}&select=updated_at`, a, { data: { n: 2 }, owner: a });
  expect(ok.body).toHaveLength(1); expect(ok.body[0].updated_at).not.toBe(v);
  const stale = await call('PATCH', `/rest/v1/docs?path=eq.u%2F${a}&updated_at=eq.${encodeURIComponent(v)}&select=updated_at`, a, { data: { n: 3 }, owner: a });
  expect(stale.body).toEqual([]);
  expect((await call('PATCH', `/rest/v1/docs?path=eq.u%2F${b}&select=updated_at`, a, { data: {} })).body).toEqual([]);
  expect((await call('PATCH', `/rest/v1/docs?path=eq.u%2F${a}&select=updated_at`, a, { owner: b })).status).toBe(403);
  expect((await call('DELETE', `/rest/v1/docs?path=eq.u%2F${b}`, a)).status).toBe(204);
  expect(await sb.db.doc('u/' + b)).not.toBeNull();
  // параллельные запросы не ломают транзакции
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/rest/v1/docs', i % 2 ? a : b, row(i % 2 ? a : b, 'n/c' + i))));
  expect(rs.every((r) => r.status === 201)).toBe(true);
  expect(await sb.isMaster(lena)).toBe(true);
  expect(await sb.isMaster(a)).toBe(false);
});

// ── Задача 6: страница берёт доступы из a/<id>, пишет их только Лена ─────────
const LENA = { email: 'lena@example.com', password: 'lena-pass', name: 'Лена' };
const POLL = { timeout: 20_000 }; // страница забирает изменения с сервера раз в 4 секунды
let wins = [];
test.afterEach(async () => { for (const c of wins) await c.close().catch(() => {}); wins = []; });

/** Окно браузера со своей сессией; page.writes — все записи в docs ("POST a/…", "DELETE u/…") */
async function openWindow(browser, testInfo) {
  const context = await browser.newContext({ ...testInfo.project.use });
  wins.push(context);
  await sb.attach(context);
  const page = await context.newPage();
  page.errors = []; page.writes = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.endsWith('/rest/v1/docs') || r.method() === 'GET') return;
    let p = (u.searchParams.get('path') || '').replace(/^eq\./, '');
    if (r.method() === 'POST') { try { p = JSON.parse(r.postData()).path; } catch { /* */ } }
    page.writes.push(r.method() + ' ' + p);
  });
  await page.goto(APP);
  return page;
}
const aWrites = (page) => page.writes.filter((w) => / a\//.test(w));

/** База «как в бою»: старые профили u/ без a/, потом SQL-перенос доступов */
async function seed(page, students, { migrate = true } = {}) {
  const program = await page.evaluate(() => defaultProgram());
  await sb.db.root('insert into public.docs(path, owner, data) values ($1, null, $2)', ['p/program', { program, links: null }]);
  await sb.addUser(LENA.email, LENA.password, LENA.name, true);
  const ids = [];
  for (const s of students) {
    const id = await sb.addUser(s.email, 'Student123!', s.name);
    const u = { id, name: s.name, email: s.email, cur: s.cur || { stage: 1, lesson: 1 }, owned: s.owned || [], fbUntil: null,
      joined: '2026-10-01', active: '2026-11-17', streak: 0, drawn: '', reward: null, notes: {}, sessions: 0,
      prefs: { email: true, tg: false }, tg: '', fbWarned: '', appliedReqs: [], ...(s.extra || {}) };
    await sb.db.root('insert into public.docs(path, owner, data) values ($1, $2, $3)', ['u/' + id, id, u]);
    ids.push(id);
  }
  if (migrate) await sb.db.runFile('supabase/access-migration.sql');
  return ids;
}

async function logIn(page, email, password = 'Student123!') {
  await page.locator('[data-auth="in"]').first().click();
  await expect(page.locator('#inEmail')).toBeFocused(); // окно ставит фокус с задержкой — иначе пароль уедет в почту
  await page.fill('#inEmail', email);
  await page.fill('#inPass', password);
  await page.click('#fIn button[type=submit]');
  await expect(page.locator('#fIn')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#syncOv')).toBeHidden({ timeout: 10_000 });
}
const stage = (page, n) => page.locator(`#stages .stg[data-s="${n}"]`);
const a = async (id) => (await sb.db.doc('a/' + id))?.data ?? null;
const owns = (page, n) => page.evaluate((k) => owns(S, k), n);
/** Заявка ученицы pr/ (как после «Я оплатила»), вставлена в базу напрямую */
async function addReq(uid, item, st = 'wait', id = Date.now()) {
  const r = { id, u: uid, item, amount: 1000, paid: 1000, cur: 'RUB', method: 'Tribute', note: '', at: '2026-11-18T10:00:00.000Z', st };
  await sb.db.root('insert into public.docs(path, owner, data) values ($1, $2, $3)', ['pr/' + id, uid, r]);
  return id;
}
async function lenaConfirms(lena, rid) {
  await lena.click('.tabs button[data-v="mpay"]');
  const b = lena.locator(`[data-rok="${rid}"]`);
  await expect(b).toBeVisible(POLL);
  await b.click();
}

test.describe('доступы из a/', () => {
  test('новая ученица без a/: всё закрыто, страница не падает', async ({ browser }, ti) => {
    sb = await SupabaseMock.create();
    const page = await openWindow(browser, ti);
    await page.locator('[data-auth="up"]').first().click();
    await page.fill('#upName', 'Анна');
    await page.fill('#upEmail', 'anna@example.com');
    await page.fill('#upPass', 'Student123!');
    await page.click('#fUp button[type=submit]');
    await expect(page.locator('#fUp')).toBeHidden({ timeout: 10_000 });
    await page.click('.tabs button[data-v="path"]');
    await expect(stage(page, 1)).toHaveClass(/\bpay\b/);
    expect(await page.evaluate(() => [1, 2, 3, 4, 5, 6].some((n) => owns(S, n)))).toBe(false);
    const { rows: [u] } = await sb.db.root("select id from auth.users where email = 'anna@example.com'");
    await expect.poll(async () => !!(await sb.db.doc('u/' + u.id)), POLL).toBe(true);
    expect(await a(u.id)).toBeNull();
    expect(aWrites(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test('ученица с a/.owned [1] видит 1-ю ступень открытой, 2-ю закрытой, прогресс как в u/.cur', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна', owned: [1], cur: { stage: 1, lesson: 3 } }]);
    expect((await a(id)).owned).toEqual([1]);
    await logIn(page, 'anna@example.com');
    await expect(stage(page, 1)).toHaveClass(/\bnow\b/);
    await expect(stage(page, 1)).toContainText('лекция 3 из');
    await expect(stage(page, 2)).toHaveClass(/\block\b/);
    expect(await owns(page, 2)).toBe(false);
    expect(page.errors).toEqual([]);
  });

  test('ученица дописала себе owned в u/ — после обновления страницы ступени всё равно закрыты', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна' }]);
    await logIn(page, 'anna@example.com');
    await expect(stage(page, 1)).toHaveClass(/\bpay\b/);
    const st = await page.evaluate(async (uid) => {
      const u = Object.assign({}, S); delete u.spreads; u.owned = [1, 2, 3, 4, 5, 6]; u.free = true;
      try { await sbRaw('/rest/v1/docs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ path: 'u/' + uid, owner: uid, data: u }) }); return 'ok'; }
      catch (e) { return e.status; }
    }, id);
    expect(st).toBe('ok'); // свой профиль писать можно — но ему не верят
    expect((await sb.db.doc('u/' + id)).data.owned).toEqual([1, 2, 3, 4, 5, 6]);
    await page.reload();
    await expect(page.locator('#syncOv')).toBeHidden({ timeout: 10_000 });
    await expect(stage(page, 1)).toHaveClass(/\bpay\b/);
    expect(await page.evaluate(() => [1, 2, 3, 4, 5, 6].some((n) => owns(S, n)) || FREE)).toBe(false);
    expect(page.errors).toEqual([]);
  });

  test('ученица не может записать a/ из страницы', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна' }]);
    await logIn(page, 'anna@example.com');
    const st = await page.evaluate(async (uid) => {
      try { await sbRaw('/rest/v1/docs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ path: 'a/' + uid, owner: uid, data: { owned: [1, 2, 3, 4, 5, 6], free: true } }) }); return 'ok'; }
      catch (e) { return e.status; }
    }, id);
    expect(st).toBe(403);
    expect((await a(id)).owned).toEqual([]);
    expect((await a(id)).free).toBe(false);
  });

  for (const [kind, item, check] of [
    ['ступень', { kind: 'stage', n: 1 }, async (page, d) => { expect(d.owned).toContain(1); await expect(stage(page, 1)).toHaveClass(/\bnow\b/, POLL); }],
    ['весь курс', { kind: 'course' }, async (page, d) => { expect(d.owned).toEqual([1, 2, 3, 4, 5, 6]); await expect(stage(page, 1)).toHaveClass(/\bnow\b/, POLL); }],
    ['обратную связь', { kind: 'fb' }, async (page, d, lena) => {
      expect(d.fbUntil).toBe(await lena.evaluate(() => addDays(30)));
      await page.click('.tabs button[data-v="spreads"]');
      await expect(page.locator('#spTarif')).toContainText('Обратная связь до', POLL);
    }],
  ]) {
    test(`Лена подтверждает заявку на ${kind} → a/ ученицы, у неё всё открывается`, async ({ browser }, ti) => {
      sb = await SupabaseMock.create({ migrate: false });
      const page = await openWindow(browser, ti);
      const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна', owned: item.kind === 'fb' ? [1] : [] }]);
      await logIn(page, 'anna@example.com');
      const rid = await addReq(id, item);
      const lena = await openWindow(browser, ti);
      await logIn(lena, LENA.email, LENA.password);
      await lenaConfirms(lena, rid);
      await expect.poll(async () => (await a(id)).appliedReqs, POLL).toContain(rid);
      await check(page, await a(id), lena);
      expect(aWrites(page)).toEqual([]);
      expect(page.errors).toEqual([]);
      expect(lena.errors).toEqual([]);
    });
  }

  test('Лена вручную открывает ступень (#cStage) → a/.owned', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const lena = await openWindow(browser, ti);
    const [id] = await seed(lena, [{ email: 'anna@example.com', name: 'Анна', owned: [1] }]);
    await logIn(lena, LENA.email, LENA.password);
    await lena.click('.tabs button[data-v="mstudents"]');
    await lena.click(`[data-card="${id}"]`);
    await lena.selectOption('#cStageSel', '2');
    await lena.click('#cStage');
    await expect.poll(async () => (await a(id)).owned, POLL).toEqual([1, 2]);
    expect(lena.errors).toEqual([]);
  });

  test('браузер ученицы не применяет подтверждённую заявку сам', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна' }]);
    const rid = await addReq(id, { kind: 'stage', n: 1 }, 'ok'); // подтверждена в старой вкладке Лены после SQL
    await logIn(page, 'anna@example.com');
    await page.waitForTimeout(5_000);
    expect(aWrites(page)).toEqual([]);
    expect((await a(id)).owned).toEqual([]);
    expect(await owns(page, 1)).toBe(false);
    // применит Лена, когда откроет новую страницу (решение 4)
    const lena = await openWindow(browser, ti);
    await logIn(lena, LENA.email, LENA.password);
    await expect.poll(async () => (await a(id)).owned, POLL).toEqual([1]);
    expect((await a(id)).appliedReqs).toContain(rid);
    await expect(stage(page, 1)).toHaveClass(/\bnow\b/, POLL);
    expect(page.errors).toEqual([]);
  });

  test('Дарина (free в a/) видит все ступени открытыми', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    await seed(page, [
      { email: 'darynaliakhova@gmail.com', name: 'Дарина' },
      { email: 'old@example.com', name: 'Старая', extra: { free: true } }, // free в u/ больше не действует
    ]);
    await logIn(page, 'darynaliakhova@gmail.com');
    await expect(stage(page, 1)).toHaveClass(/\bnow\b/);
    expect(await page.evaluate(() => FREE && [1, 2, 3, 4, 5, 6, 7].every((n) => owns(S, n)))).toBe(true);
    const old = await openWindow(browser, ti);
    await logIn(old, 'old@example.com');
    await expect(stage(old, 1)).toHaveClass(/\bpay\b/);
    expect(await old.evaluate(() => FREE)).toBe(false);
    expect(page.errors).toEqual([]);
    expect(old.errors).toEqual([]);
  });

  test('страницу выложили раньше SQL: старые доступы в u/ не затираются и переносятся в a/', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна', owned: [1, 2], cur: { stage: 2, lesson: 1 },
      extra: { fbUntil: '2026-12-01', sessions: 5, appliedReqs: [7] } }], { migrate: false });
    const legacy = { owned: [1, 2], fbUntil: '2026-12-01', sessions: 5, appliedReqs: [7] };
    const access = async () => { const d = (await sb.db.doc('u/' + id)).data; return { owned: d.owned, fbUntil: d.fbUntil, sessions: d.sessions, appliedReqs: d.appliedReqs }; };
    await logIn(page, 'anna@example.com');
    await expect(stage(page, 2)).toHaveClass(/\bpay\b/); // без a/ — ничего не куплено
    const lena = await openWindow(browser, ti);
    await logIn(lena, LENA.email, LENA.password);
    // обе страницы сохраняют профиль ученицы
    await page.evaluate(() => { S.streak = 3; persist(); });
    await expect.poll(async () => (await sb.db.doc('u/' + id)).data.streak, POLL).toBe(3);
    await lena.evaluate((uid) => { DB.users[uid].tg = '@anna'; persist(); }, id);
    await expect.poll(async () => (await sb.db.doc('u/' + id)).data.tg, POLL).toBe('@anna');
    await page.waitForTimeout(5_000);
    expect(await access()).toEqual(legacy);
    expect(await a(id)).toBeNull();
    await sb.db.runFile('supabase/access-migration.sql');
    expect((await a(id)).owned).toEqual([1, 2]);
    expect((await a(id)).fbUntil).toBe('2026-12-01');
    expect((await a(id)).sessions).toBe(5);
    await expect(stage(page, 2)).toHaveClass(/\bnow\b/, POLL);
    expect(page.errors).toEqual([]);
    expect(lena.errors).toEqual([]);
  });

  test('страницу выложили раньше SQL: Лена не применяет старые заявки второй раз', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const lena = await openWindow(browser, ti);
    const R1 = 1700000000001, R2 = 1700000000002, F = '2026-12-01';
    const [id] = await seed(lena, [{ email: 'anna@example.com', name: 'Анна', owned: [1, 2], cur: { stage: 2, lesson: 1 },
      extra: { fbUntil: F, appliedReqs: [R1, R2] } }], { migrate: false });
    await addReq(id, { kind: 'stage', n: 2 }, 'ok', R1);
    await addReq(id, { kind: 'fb' }, 'ok', R2);
    await logIn(lena, LENA.email, LENA.password);
    await lena.waitForTimeout(10_000); // несколько циклов опроса
    expect(await a(id)).toBeNull();
    const u = (await sb.db.doc('u/' + id)).data;
    expect(u.owned).toEqual([1, 2]);
    expect(u.fbUntil).toBe(F);
    expect(lena.writes.filter((w) => / a\//.test(w))).toEqual([]);
    await sb.db.runFile('supabase/access-migration.sql');
    const d = await a(id);
    expect(d.owned).toEqual([1, 2]);
    expect(d.fbUntil).toBe(F);
    expect(d.appliedReqs).toEqual(expect.arrayContaining([R1, R2]));
    expect(lena.errors).toEqual([]);
  });

  test('ученицу удалили в Supabase (u/ удалена, a/ осталась): у Лены без ошибок, a/ не трогается', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const lena = await openWindow(browser, ti);
    const [gone, stay] = await seed(lena, [
      { email: 'gone@example.com', name: 'Удалённая', owned: [1, 2] },
      { email: 'stay@example.com', name: 'Осталась', owned: [1] },
    ]);
    await sb.db.root('delete from public.docs where path = $1', ['u/' + gone]);
    await logIn(lena, LENA.email, LENA.password);
    await lena.click('.tabs button[data-v="mstudents"]');
    await expect(lena.locator('#mStud')).toContainText('Осталась');
    await expect(lena.locator('#mStud')).not.toContainText('Удалённая');
    await lena.waitForTimeout(6_000);
    expect(await sb.db.doc('u/' + gone)).toBeNull();
    expect((await a(gone)).owned).toEqual([1, 2]);
    expect(lena.writes.filter((w) => w.includes(gone))).toEqual([]);
    expect(lena.errors).toEqual([]);
    expect(stay).toBeTruthy();
  });
});
