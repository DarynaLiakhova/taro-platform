// Доступ и видео: подмена Supabase на настоящем Postgres (PGlite) с боевыми правилами.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const { SupabaseMock } = require('./mocks/supabase');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

test.setTimeout(90_000);

let sb;
test.beforeEach(async () => { sb = await SupabaseMock.create(); });
test.afterEach(async () => { await sb.close(); });

test('подмена: ученица регистрируется и видит кабинет без ошибок', async ({ page, context }) => {
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
