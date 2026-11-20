// Чат и отправка — на демо-данных, без Supabase (быстро, без сети).
// Что проверяем: отправку текста, лимиты, фото, голосовое, доставку
// вопросов и раскладов Лене, и доступ ко второму разбору («Ещё ждут»).
// Видео и расшифровка голоса требуют сервера — они в отдельном наборе chat.todo.js.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const FX = (f) => path.join(__dirname, 'fixtures', f);

async function boot(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(() => { window.__NO_SB = true; window.__DEMO = true; window.__PAL2 = true; });
  await page.goto(APP);
  await page.waitForFunction(() => typeof DB !== 'undefined' && DB.users && typeof loginMaster === 'function' && typeof openPerson === 'function');
}

// Лена открывает переписку с ученицей (по id демо-ученицы) нужного типа
async function masterOpen(page, who, type = 'spread') {
  await page.evaluate((t) => { loginMaster(); showView('mchats'); chatsType = t; renderChats(); }, type);
  await page.evaluate((id) => openPerson(id), who);
  await expect(page.locator('#cTxt')).toBeVisible();
}

// Ученица anna (у неё есть обратная связь) отправляет новый расклад
async function studentSendsSpread(page, q) {
  await page.evaluate(() => { loginStudent(DB.users.anna); showView('spreads'); });
  await page.click('#spAdd');
  await expect(page.locator('#fQ')).toBeVisible();
  await page.fill('#fQ', q);
  await page.fill('#fCards', 'Шут, Маг, Звезда');
  await page.fill('#fDesc', 'Моя трактовка для теста доставки.');
  await page.click('#fSend');
}

// Ученица anna задаёт вопрос по лекции
async function studentAsks(page, q, idx = 3) {
  await page.evaluate(({ q, idx }) => {
    loginStudent(DB.users.anna);
    openQ({ stage: 2, idx, title: 'Лекция ' + idx });
    document.getElementById('qT').value = q;
    document.getElementById('qSend').click();
  }, { q, idx });
}

test.describe('Чат: отправка', () => {
  test('Лена отвечает текстом — сообщение появляется в ленте', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.fill('#cTxt', 'Смотрю твой расклад — отвечаю по картам.');
    await expect(page.locator('#cSend')).toBeVisible();
    await page.click('#cSend');
    await expect(page.locator('#thread .msg.m').filter({ hasText: 'отвечаю по картам' })).toHaveCount(1);
    expect(page.errors).toEqual([]);
  });

  test('пустое сообщение отправить нельзя (кнопка скрыта)', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await expect(page.locator('#cSend')).toBeHidden();      // пусто
    await page.fill('#cTxt', '   ');                         // одни пробелы
    await expect(page.locator('#cSend')).toBeHidden();
    await page.fill('#cTxt', 'есть текст');                  // появился текст
    await expect(page.locator('#cSend')).toBeVisible();
    expect(page.errors).toEqual([]);
  });

  test('лимит фото: из 6 остаётся не больше 5', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.setInputFiles('#cPhotoIn', [
      FX('photo1.jpg'), FX('photo2.jpg'), FX('photo3.jpg'),
      FX('photo1.jpg'), FX('photo2.jpg'), FX('photo3.jpg'),
    ]);
    await expect(page.locator('#cImgBox .att')).toHaveCount(5);
    expect(page.errors).toEqual([]);
  });

  test('отправка 3 фото — в сообщении три картинки', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.setInputFiles('#cPhotoIn', [FX('photo1.jpg'), FX('photo2.jpg'), FX('photo3.jpg')]);
    await expect(page.locator('#cImgBox .att')).toHaveCount(3);
    await page.click('#cSend');
    await expect(page.locator('#thread .msg.m').last().locator('img')).toHaveCount(3);
    expect(page.errors).toEqual([]);
  });

  test('удаление сообщения — остаётся пометка «Сообщение удалено»', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.fill('#cTxt', 'Удаляемое сообщение');
    await page.click('#cSend');
    const msg = page.locator('#thread .msg.m', { hasText: 'Удаляемое сообщение' }).first();
    await expect(msg).toHaveCount(1);
    await msg.locator('.bub').click({ button: 'right' });   // правый клик — меню как в телеге
    await expect(page.locator('#pcCtx')).toBeVisible();
    await page.locator('#pcCtx [data-act="del"]').click();
    await expect(page.locator('#thread .bub.del', { hasText: 'Сообщение удалено' })).toHaveCount(1);
    await expect(page.locator('#thread .msg.m', { hasText: 'Удаляемое сообщение' })).toHaveCount(0);
    expect(page.errors).toEqual([]);
  });

  test('голосовое: перемотка по волне меняет позицию', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.click('#cMic');
    await expect(page.locator('#cRec')).toBeVisible();
    await page.waitForTimeout(1500);
    await page.click('#cStop');
    await expect(page.locator('#thread .vmsg')).toHaveCount(1, { timeout: 15000 });
    const wave = page.locator('#thread .vmsg .vwave').last();
    const box = await wave.boundingBox();
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);  // перемотка на ~70%
    await page.waitForTimeout(300);
    const ct = await page.evaluate(() => +document.querySelector('#thread .vmsg audio').currentTime);
    expect(ct).toBeGreaterThan(0.3);   // позиция сдвинулась к клику
    expect(page.errors).toEqual([]);
  });

  test('выбрать несколько сообщений и удалить разом', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.fill('#cTxt', 'Сообщение один'); await page.click('#cSend');
    await page.fill('#cTxt', 'Сообщение два'); await page.click('#cSend');
    await page.locator('#thread .msg.m', { hasText: 'Сообщение один' }).locator('.bub').click({ button: 'right' });
    await page.locator('#pcCtx [data-act="sel"]').click();          // «Выбрать»
    await page.locator('#thread .msg.m', { hasText: 'Сообщение два' }).locator('.bub').click();  // левый клик — отметка
    await expect(page.locator('.pc-seln')).toContainText('2');
    await page.locator('#pcSelDel').click();
    await expect(page.locator('#thread .bub.del')).toHaveCount(2);
    expect(page.errors).toEqual([]);
  });

  test('голосовое: запись и отправка — в ленте появляется голосовое', async ({ page }) => {
    await boot(page);
    await masterOpen(page, 'maria', 'spread');
    await page.click('#cMic');
    await expect(page.locator('#cRec')).toBeVisible();
    await page.waitForTimeout(1500);                         // fake-mic пишет тестовый звук
    await page.click('#cStop');                              // «Готово» — голосовое уходит само
    await expect(page.locator('#thread .msg.m .vmsg')).toHaveCount(1, { timeout: 15000 });
    expect(page.errors).toEqual([]);
  });
});

test.describe('Чат: доставка Лене', () => {
  test('ученица отправляет расклад — он доходит до Лены', async ({ page }) => {
    await boot(page);
    const q = 'Расклад доходит до Лены ' + Date.now();
    await studentSendsSpread(page, q);
    await masterOpen(page, 'anna', 'spread');
    await expect(page.locator('#vBox')).toContainText(q);
    expect(page.errors).toEqual([]);
  });

  test('ученица задаёт вопрос — он доходит до Лены в «Вопросы»', async ({ page }) => {
    await boot(page);
    const q = 'Вопрос доходит до Лены ' + Date.now();
    await studentAsks(page, q, 3);
    await masterOpen(page, 'anna', 'question');
    await expect(page.locator('#vBox')).toContainText(q);
    expect(page.errors).toEqual([]);
  });

  test('два вопроса подряд — оба видны карточками в единой ленте', async ({ page }) => {
    await boot(page);
    await studentAsks(page, 'Вопрос-один про Жрицу?', 3);
    await studentAsks(page, 'Вопрос-два про Луну?', 4);
    await masterOpen(page, 'anna', 'question');
    // в единой ленте оба вопроса — отдельными карточками, ни один не прячется
    await expect(page.locator('#thread .msg.orig', { hasText: 'Вопрос-один про Жрицу?' })).toHaveCount(1);
    await expect(page.locator('#thread .msg.orig', { hasText: 'Вопрос-два про Луну?' })).toHaveCount(1);
    expect(page.errors).toEqual([]);
  });
});
