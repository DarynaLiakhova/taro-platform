// В РАБОТЕ: тесты чата ещё не дописаны (кнопка «Отправить Лене» у новой ученицы неактивна — разбираюсь). Чтобы включить, переименуй в chat.spec.js
// Чат ученицы и Лены: сообщения, фото, видео, голосовые — в обе стороны.
// В одном тесте два отдельных браузера: в одном ученица, в другом Лена.
// База подменена (tests/mocks/supabase.js), настоящий Supabase не трогается.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const { SupabaseMock } = require('./mocks/supabase');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const FX = (f) => path.join(__dirname, 'fixtures', f);
const LENA = { email: 'lena.test@example.com', password: 'lena-test-pass', name: 'Лена' };
const STUDENT = { email: 'student.test@example.com', password: 'Student123!', name: 'Анна' };
const POLL = { timeout: 20_000 }; // переписка обновляется раз в 4 секунды

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

let sb, student, lena;

async function openWindow(browser, testInfo) {
  const context = await browser.newContext({ ...testInfo.project.use, permissions: ['microphone'] });
  await sb.attach(context);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(APP);
  return page;
}

async function signUpStudent(page) {
  await page.locator('[data-auth="up"]').first().click();
  await page.fill('#upName', STUDENT.name);
  await page.fill('#upEmail', STUDENT.email);
  await page.fill('#upPass', STUDENT.password);
  await page.click('#fUp button[type=submit]');
  await expect(page.locator('#fUp')).toBeHidden({ timeout: 10_000 });
}

async function logInLena(page) {
  await page.locator('[data-auth="in"]').first().click();
  await page.fill('#inEmail', LENA.email);
  await page.fill('#inPass', LENA.password);
  await page.click('#fIn button[type=submit]');
  await expect(page.locator('#fIn')).toBeHidden({ timeout: 10_000 });
}

/** Ученица задаёт вопрос Лене и открывает переписку */
async function studentAsks(page, question) {
  await page.click('.tabs button[data-v="spreads"]');
  await page.click('#spAsk');
  await page.fill('#qT', question);
  await page.click('#qSend');
  await page.locator('#spGrid .sp', { hasText: question }).click();
  await expect(page.locator('#cTxt')).toBeVisible();
}

/** Лена открывает переписку с этим вопросом */
async function lenaOpens(page, question) {
  const item = page.locator('#mq .mi', { hasText: question });
  await expect(item).toBeVisible(POLL);
  await item.locator('[data-open]').click();
  await expect(page.locator('#cTxt')).toBeVisible();
}

async function send(page, text) {
  if (text) await page.fill('#cTxt', text);
  await page.click('#cSend');
}

/** Записать голосовое: Chrome подставляет вместо микрофона тестовый звук */
async function recordVoice(page, seconds = 2) {
  await page.click('#cMic');
  await expect(page.locator('#cRec')).toBeVisible();
  await page.waitForTimeout(seconds * 1000);
  await page.click('#cStop');
}

const bubbles = (page) => page.locator('#vBox .msg');

test.beforeAll(async ({ browser }, testInfo) => {
  sb = await SupabaseMock.create();
  await sb.addUser(LENA.email, LENA.password, LENA.name, true);
  student = await openWindow(browser, testInfo);
  lena = await openWindow(browser, testInfo);
  await signUpStudent(student);
  await logInLena(lena);
});

test.afterAll(async () => {
  await sb?.close();
  await student?.context().close();
  await lena?.context().close();
});

test('ученица пишет — Лена получает текст', async () => {
  await studentAsks(student, 'Тестовый вопрос про расклад');
  await send(student, 'Привет! Вот мой расклад');
  await expect(bubbles(student).filter({ hasText: 'Вот мой расклад' })).toHaveCount(1);

  await lenaOpens(lena, 'Тестовый вопрос про расклад');
  await expect(bubbles(lena).filter({ hasText: 'Вот мой расклад' })).toHaveCount(1, POLL);
});

test('Лена отвечает — ученица получает текст', async () => {
  await send(lena, 'Привет, Анна! Смотрю');
  await expect(bubbles(student).filter({ hasText: 'Привет, Анна! Смотрю' })).toHaveCount(1, POLL);
});

test('ученица отправляет 3 фото — Лена видит все три', async () => {
  await student.setInputFiles('#cPhotoIn', [FX('photo1.jpg'), FX('photo2.jpg'), FX('photo3.jpg')]);
  await send(student, 'три фото');
  await expect(student.locator('#vBox .album').last().locator('img')).toHaveCount(3);
  await expect.poll(async () => sb.filesOf('chat', await userId(student)).length, POLL).toBeGreaterThanOrEqual(3);

  const album = lena.locator('#vBox .msg', { hasText: 'три фото' }).locator('img');
  await expect(album).toHaveCount(3, POLL);
  await expectImagesLoaded(album);
});

test('Лена отправляет фото — ученица его видит', async () => {
  await lena.setInputFiles('#cPhotoIn', [FX('photo2.jpg')]);
  await send(lena, 'фото от Лены');
  const img = student.locator('#vBox .msg', { hasText: 'фото от Лены' }).locator('img');
  await expect(img).toHaveCount(1, POLL);
  await expectImagesLoaded(img);
});

test('ученица отправляет одно видео — загрузка видна, Лена может его открыть', async () => {
  await student.setInputFiles('#cPhotoIn', [FX('clip.mp4')]);
  await send(student, 'видео от ученицы');
  await expect.poll(async () => sb.filesOf('media', await userId(student)).length, POLL).toBe(1);

  const vid = lena.locator('#vBox .msg', { hasText: 'видео от ученицы' }).locator('video');
  await expect(vid).toHaveCount(1, POLL);
  await expect(vid).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/media\//, POLL);
});

test('Лена отправляет одно видео — ученица может его открыть', async () => {
  await lena.setInputFiles('#cPhotoIn', [FX('clip.mp4')]);
  await send(lena, 'видео от Лены');
  const vid = student.locator('#vBox .msg', { hasText: 'видео от Лены' }).locator('video');
  await expect(vid).toHaveCount(1, POLL);
  await expect(vid).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/media\//, POLL);
});

test('голосовое ученицы приходит Лене и проигрывается', async () => {
  const before = await lena.locator('#vBox .vmsg').count();
  await recordVoice(student);
  await expect(student.locator('#vBox .vmsg')).toHaveCount(1, POLL);
  await expect(lena.locator('#vBox .vmsg')).toHaveCount(before + 1, POLL);
  await expectVoicePlays(lena.locator('#vBox .vmsg').last());
});

test('голосовое Лены приходит ученице и проигрывается', async () => {
  await recordVoice(lena);
  await expect(student.locator('#vBox .vmsg')).toHaveCount(2, POLL);
  await expectVoicePlays(student.locator('#vBox .vmsg').last());
});

test('расшифровка голосового показывает текст', async () => {
  const voice = lena.locator('#vBox .vmsg').first();
  await voice.locator('.tr-btn').click();
  await expect(voice.locator('.tr-txt')).toHaveText(sb.transcript, POLL);
});

test('в окнах не было ошибок в коде', async () => {
  expect(student.errors).toEqual([]);
  expect(lena.errors).toEqual([]);
});

// --- вспомогательные проверки
function userId(page) { return page.evaluate(() => S.id); }

async function expectImagesLoaded(imgs) {
  await expect.poll(() => imgs.evaluateAll((list) => list.every((i) => i.complete && i.naturalWidth > 0)), POLL).toBe(true);
}

async function expectVoicePlays(box) {
  await box.locator('.vplay').click();
  await expect(box).toHaveClass(/playing/, { timeout: 10_000 });
}
