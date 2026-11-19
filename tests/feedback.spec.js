// Три состояния аккаунта и отправка расклада Лене на разбор.
// Проверяем: кнопка «Отправить на проверку» активна только при обратной связи
// (или флаге free), и расклад доходит до Лены только из активной кнопки.
// Работает на демо-данных (__DEMO), без Supabase.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

// В демо: Ольга — без обратной связи (fb=null), Анна — с обратной связью (fb=+18 дней).
async function boot(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(() => { window.__NO_SB = true; window.__DEMO = true; window.__PAL2 = true; });
  await page.goto(APP);
  await page.waitForFunction(() => typeof DB !== 'undefined' && DB.users && typeof loginStudent === 'function');
}

// Войти demo-ученицей по id, либо создать free-ученицу
async function loginAs(page, who) {
  await page.evaluate((who) => {
    let u;
    if (who === 'free') {
      u = mkU('free_test', 'Даша Free', 'free@test', 3, 1, [1, 2, 3], null, 0, 0, {});
      u.free = true; u.spreads = u.spreads || []; u.notes = u.notes || {};
      DB.users[u.id] = u;
    } else {
      u = DB.users[who];
    }
    loginStudent(u);
    showView('spreads');
  }, who);
  await expect(page.locator('#spAdd')).toBeVisible();
}

// Открыть форму «Новый расклад» и заполнить вопрос + карты
async function fillSpread(page, question) {
  await page.click('#spAdd');
  await expect(page.locator('#fQ')).toBeVisible();
  await page.fill('#fQ', question);
  await page.fill('#fCards', 'Колесница, Восьмёрка Мечей, Туз Пентаклей');
  await page.fill('#fDesc', 'Моя трактовка: похоже на перемены и выбор.'); // отправка требует трактовку
}

// Состояние кнопки отправки: активна ли, виден ли замок
async function sendState(page) {
  return page.evaluate(() => ({
    disabled: document.getElementById('fSend').getAttribute('aria-disabled') === 'true',
    lock: !document.getElementById('fLock').hidden,
    saveVisible: !document.getElementById('fSave').hidden,
  }));
}

async function inLenaQueue(page, question) {
  await page.evaluate(() => loginMaster());
  await expect(page.locator('#mq')).toBeVisible();
  await page.waitForTimeout(200);
  return page.locator('#mq', { hasText: question }).count();
}

test.describe('Отправка Лене по тарифу', () => {
  test('free-аккаунт: кнопка активна, расклад уходит Лене', async ({ page }) => {
    await boot(page);
    await loginAs(page, 'free');
    const q = 'FREE тест ' + Date.now();
    await fillSpread(page, q);
    const s = await sendState(page);
    expect(s.disabled).toBe(false);
    expect(s.lock).toBe(false);
    await page.click('#fSend');
    expect(await inLenaQueue(page, q)).toBeGreaterThan(0);
    expect(page.errors).toEqual([]);
  });

  test('ученица без обратной связи: кнопка серая, замок виден, Лене не уходит', async ({ page }) => {
    await boot(page);
    await loginAs(page, 'olga');
    const q = 'БЕЗ ОС тест ' + Date.now();
    await fillSpread(page, q);
    const s = await sendState(page);
    expect(s.disabled).toBe(true);     // «Отправить на проверку» недоступна
    expect(s.lock).toBe(true);         // видна строка про тариф
    expect(s.saveVisible).toBe(true);  // «Сохранить в журнал» доступно
    await page.click('#fSave');        // сохраняем в журнал
    expect(await inLenaQueue(page, q)).toBe(0); // у Лены не появилось
    expect(page.errors).toEqual([]);
  });

  test('ученица с обратной связью: кнопка активна, расклад уходит Лене', async ({ page }) => {
    await boot(page);
    await loginAs(page, 'anna');
    const q = 'С ОС тест ' + Date.now();
    await fillSpread(page, q);
    const s = await sendState(page);
    expect(s.disabled).toBe(false);
    expect(s.lock).toBe(false);
    await page.click('#fSend');
    expect(await inLenaQueue(page, q)).toBeGreaterThan(0);
    expect(page.errors).toEqual([]);
  });
});
