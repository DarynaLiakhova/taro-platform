// Старая страница (d0234fe — то, что сейчас на сайте и в кэше браузеров) поверх базы после access-migration.sql.
// Требование: после SQL старая страница не ломается — максимум нет видео до обновления.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { SupabaseMock } = require('./mocks/supabase');

const ROOT = path.join(__dirname, '..');
const OLD_FILE = path.join(ROOT, 'old-page-d0234fe.test-tmp.html'); // рядом с index.html: те же пути к assets/ и theme.css; в .gitignore
const OLD = pathToFileURL(OLD_FILE).href;
const NEW = pathToFileURL(path.join(ROOT, 'index.html')).href;

test.setTimeout(120_000);
test.beforeAll(() => { fs.writeFileSync(OLD_FILE, execFileSync('git', ['show', 'd0234fe:index.html'], { cwd: ROOT })); });
test.afterAll(() => { fs.rmSync(OLD_FILE, { force: true }); });

let sb;
let wins = [];
test.afterEach(async () => {
  for (const c of wins) await c.close().catch(() => {});
  wins = [];
  await sb?.close(); sb = null;
});

const LENA = { email: 'lena@example.com', password: 'lena-pass', name: 'Лена' };
const POLL = { timeout: 20_000 };
const VID = (n) => 'https://kinescope.io/s' + n;
const ALL_VIDEOS = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, VID(n)]));

/** Окно со своей сессией. page.writes — записи в docs ("DELETE a/…"), page.toasts — все показанные тосты,
 *  page.warns — console.warn("supabase", …) старой страницы (так она сообщает об ошибке записи) */
async function openWindow(browser, testInfo, url) {
  const context = await browser.newContext({ ...testInfo.project.use });
  wins.push(context);
  await sb.attach(context);
  await context.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const t = document.getElementById('toast');
      if (t) new MutationObserver(() => window.__toasts.push(t.textContent)).observe(t, { childList: true, characterData: true, subtree: true });
    });
  });
  const page = await context.newPage();
  page.errors = []; page.writes = []; page.warns = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'warning' && /supabase/.test(m.text())) page.warns.push(m.text()); });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.endsWith('/rest/v1/docs') || r.method() === 'GET') return;
    let p = (u.searchParams.get('path') || '').replace(/^eq\./, '');
    if (r.method() === 'POST') { try { p = JSON.parse(r.postData()).path; } catch { /* */ } }
    page.writes.push(r.method() + ' ' + p);
  });
  await page.goto(url);
  return page;
}
const toasts = (page) => page.evaluate(() => window.__toasts);
const noRights = async (page) => (await toasts(page)).filter((t) => /нет прав|Связь с сервером/.test(t));

/** База «как в бою» (профили u/ с доступами, ссылки на видео в программе), потом SQL */
async function seed(page, students, { videos = ALL_VIDEOS } = {}) {
  const program = await page.evaluate(() => defaultProgram());
  for (const n in videos) program[n - 1].lessons[0].video = videos[n];
  await sb.db.root('insert into public.docs(path, owner, data) values ($1, null, $2)', ['p/program', { program, links: null }]);
  await sb.addUser(LENA.email, LENA.password, LENA.name, true);
  const ids = [];
  for (const s of students) {
    const id = await sb.addUser(s.email, 'Student123!', s.name);
    const u = { id, name: s.name, email: s.email, cur: s.cur || { stage: 1, lesson: 1 }, owned: s.owned || [], fbUntil: null,
      joined: '2026-10-01', active: '2026-11-17', streak: 0, drawn: '', reward: null, notes: {}, sessions: 0,
      prefs: { email: true, tg: false }, tg: '', fbWarned: '', appliedReqs: [] };
    await sb.db.root('insert into public.docs(path, owner, data) values ($1, $2, $3)', ['u/' + id, id, u]);
    ids.push(id);
  }
  await sb.db.runFile('supabase/access-migration.sql');
  return ids;
}

async function logIn(page, email, password = 'Student123!') {
  await page.locator('[data-auth="in"]').first().click();
  await expect(page.locator('#inEmail')).toBeFocused();
  await page.fill('#inEmail', email);
  await page.fill('#inPass', password);
  await page.click('#fIn button[type=submit]');
  await expect(page.locator('#fIn')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#syncOv')).toBeHidden({ timeout: 10_000 });
}
const stage = (page, n) => page.locator(`#stages .stg[data-s="${n}"]`);
const doc = async (p) => (await sb.db.doc(p))?.data ?? null;
/** Все a/ и v/ как есть в базе — для сравнения «до» и «после» */
const protectedRows = async () => (await sb.db.root("select path, owner, data from public.docs where path ~ '^(a|v)/' order by path")).rows;
async function addReq(uid, item, st = 'wait', id = Date.now()) {
  const r = { id, u: uid, item, amount: 1000, paid: 1000, cur: 'RUB', method: 'Tribute', note: '', at: '2026-11-18T10:00:00.000Z', st };
  await sb.db.root('insert into public.docs(path, owner, data) values ($1, $2, $3)', ['pr/' + id, uid, r]);
  return id;
}

test.describe('старая страница после SQL', () => {
  test('старая страница ученицы: кабинет открывается без ошибок, замки как раньше, видео нет', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti, OLD);
    await seed(page, [{ email: 'anna@example.com', name: 'Анна', owned: [1, 2], cur: { stage: 2, lesson: 2 } }]);
    expect(await page.evaluate(() => typeof SB_ON !== 'undefined' && SB_ON)).toBe(true); // старая страница идёт в «облако», а не в демо
    await logIn(page, 'anna@example.com');
    await page.click('.tabs button[data-v="path"]');
    await expect(stage(page, 1)).toHaveClass(/\bdone\b/);
    await expect(stage(page, 2)).toHaveClass(/\bnow\b/);
    await expect(stage(page, 2)).toContainText('лекция 2 из');
    await expect(stage(page, 3)).toHaveClass(/\block\b/);
    // видео больше нет в программе — у урока нет ссылки, но урок открывается
    await page.evaluate(() => openLesson(1, 1));
    await expect(page.locator('#player')).toBeVisible();
    await expect(page.locator('#player .vlink')).toHaveCount(0);
    expect(page.errors).toEqual([]);
  });

  test('старая страница ученицы не удаляет a/ и v/ и не показывает тост «нет прав» за 15 с опроса', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const page = await openWindow(browser, ti, OLD);
    const [id] = await seed(page, [{ email: 'anna@example.com', name: 'Анна', owned: [1] }]);
    const before = await protectedRows();
    expect(before.map((r) => r.path)).toEqual(['a/' + id, 'v/1', 'v/2', 'v/3', 'v/4', 'v/5', 'v/6', 'v/7']);
    await logIn(page, 'anna@example.com');
    for (let i = 0; i < 3; i++) { // ученица что-то делает — страница сохраняет всё, что видит
      await page.evaluate((k) => { S.streak = k; persist(); }, i + 1);
      await page.waitForTimeout(5_000);
    }
    expect((await doc('u/' + id)).streak).toBe(3);
    expect(await toasts(page)).toContainEqual(expect.stringContaining('С возвращением')); // тосты действительно ловятся
    expect(await protectedRows()).toEqual(before);
    expect(await noRights(page)).toEqual([]);
    expect(page.warns).toEqual([]);
    expect(page.errors).toEqual([]);
    // старая страница пытается удалить a/<своя> и видимые v/ — база молча не даёт (204, 0 строк), тоста нет
    const dels = page.writes.filter((w) => w.startsWith('DELETE'));
    expect(dels.every((w) => /^DELETE (a|v)\//.test(w))).toBe(true);
  });

  test('старая страница Лены не удаляет a/ и v/ за 15 с опроса', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const lena = await openWindow(browser, ti, OLD);
    const [id] = await seed(lena, [{ email: 'anna@example.com', name: 'Анна', owned: [1, 2] }, { email: 'vera@example.com', name: 'Вера', owned: [] }]);
    const before = await protectedRows();
    expect(before).toHaveLength(9); // a/ двух учениц и v/1…v/7
    await logIn(lena, LENA.email, LENA.password);
    for (let i = 0; i < 3; i++) { // серия сохранений: старая страница Лены удаляет всё, чего нет в её данных
      await lena.evaluate(([uid, k]) => { DB.users[uid].tg = '@anna' + k; persist(); }, [id, i]);
      await lena.waitForTimeout(5_000);
    }
    expect((await doc('u/' + id)).tg).toBe('@anna2');
    const dels = lena.writes.filter((w) => w.startsWith('DELETE'));
    expect(dels.length).toBeGreaterThan(0); // пытается — правило базы молча не даёт
    expect(dels.every((w) => /^DELETE (a|v)\//.test(w))).toBe(true);
    expect(await protectedRows()).toEqual(before);
    expect(await noRights(lena)).toEqual([]);
    expect(lena.warns).toEqual([]);
    expect(lena.errors).toEqual([]);
  });

  test('заявка, подтверждённая в старой вкладке Лены, применяется в a/ при открытии новой страницы Лены', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const old = await openWindow(browser, ti, OLD);
    const [id] = await seed(old, [{ email: 'anna@example.com', name: 'Анна', owned: [1], cur: { stage: 2, lesson: 1 } }]);
    const rid = await addReq(id, { kind: 'stage', n: 2 });
    await logIn(old, LENA.email, LENA.password);
    await old.click('.tabs button[data-v="mpay"]');
    await old.locator(`[data-rok="${rid}"]`).click();
    await expect.poll(async () => (await doc('pr/' + rid))?.st, POLL).toBe('ok');
    await expect.poll(async () => (await doc('u/' + id)).owned, POLL).toEqual([1, 2]); // старая страница пишет в u/
    expect((await doc('a/' + id)).owned).toEqual([1]); // a/ ей недоступна
    expect(old.errors).toEqual([]);
    expect(await noRights(old)).toEqual([]);
    // Лена обновила страницу — уже новая версия
    const lena = await openWindow(browser, ti, NEW);
    await logIn(lena, LENA.email, LENA.password);
    await expect.poll(async () => (await doc('a/' + id)).owned, POLL).toEqual([1, 2]);
    expect((await doc('a/' + id)).appliedReqs).toContain(rid);
    // ученица на новой странице видит 2-ю ступень открытой
    const page = await openWindow(browser, ti, NEW);
    await logIn(page, 'anna@example.com');
    await expect(stage(page, 2)).toHaveClass(/\bnow\b/);
    expect(lena.errors).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test('новая страница после изменения u/ новой ученицей: старая вкладка не падает', async ({ browser }, ti) => {
    sb = await SupabaseMock.create({ migrate: false });
    const old = await openWindow(browser, ti, OLD);
    const [id] = await seed(old, [{ email: 'anna@example.com', name: 'Анна', owned: [1] }]);
    await logIn(old, 'anna@example.com');
    await expect(stage(old, 1)).toHaveClass(/\bnow\b/);
    // та же ученица открыла сайт уже в новой версии и что-то сделала — новая страница переписала её u/
    const page = await openWindow(browser, ti, NEW);
    await logIn(page, 'anna@example.com');
    await page.evaluate(() => { S.streak = 7; persist(); });
    await expect.poll(async () => (await doc('u/' + id)).streak, POLL).toBe(7);
    expect((await doc('u/' + id)).owned).toEqual([1]); // зеркало из a/
    await expect.poll(() => old.evaluate(() => S.streak), POLL).toBe(7); // старая вкладка подхватила
    await old.waitForTimeout(5_000);
    await expect(stage(old, 1)).toHaveClass(/\bnow\b/);
    expect(await noRights(old)).toEqual([]);
    expect(old.errors).toEqual([]);
    expect(page.errors).toEqual([]);

    // новая ученица: зарегистрировалась на новой странице (a/ нет), потом открыла старую из кэша
    const fresh = await openWindow(browser, ti, NEW);
    await fresh.locator('[data-auth="up"]').first().click();
    await fresh.fill('#upName', 'Вера');
    await fresh.fill('#upEmail', 'vera@example.com');
    await fresh.fill('#upPass', 'Student123!');
    await fresh.click('#fUp button[type=submit]');
    await expect(fresh.locator('#fUp')).toBeHidden({ timeout: 10_000 });
    const { rows: [nu] } = await sb.db.root("select id from auth.users where email = 'vera@example.com'");
    await expect.poll(async () => !!(await doc('u/' + nu.id)), POLL).toBe(true);
    const oldFresh = await openWindow(browser, ti, OLD);
    await logIn(oldFresh, 'vera@example.com');
    await oldFresh.click('.tabs button[data-v="path"]');
    await expect(stage(oldFresh, 1)).toHaveClass(/\bpay\b/);
    await fresh.evaluate(() => { S.streak = 2; persist(); });
    await expect.poll(() => oldFresh.evaluate(() => S.streak), POLL).toBe(2);
    expect(await noRights(oldFresh)).toEqual([]);
    expect(oldFresh.errors).toEqual([]);
    expect(fresh.errors).toEqual([]);
  });
});
