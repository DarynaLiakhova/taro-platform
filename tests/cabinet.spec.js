// Кабинет «Мой путь» в новом оформлении (превью): проверяем, что дизайн на месте,
// а всё, что работало, работает как раньше. Запускается на демо-данных, без Supabase.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(() => { window.__NO_SB = true; window.__DEMO = true; window.__PAL2 = true; });
  await page.goto(APP);
  await page.evaluate(() => { loginStudent(Object.values(DB.users)[0]); showView('path'); });
  await expect(page.locator('#v-path')).toBeVisible();
});

test.afterEach(async ({ page }) => { expect(page.errors).toEqual([]); });

test('общая тема подключена: цвета берутся из theme.css', async ({ page }) => {
  const velvet = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tp-velvet').trim());
  expect(velvet).toBe('#2a4132');
});

test('баннер: высота 270 на планшете и ноутбуке, текст и кнопка на месте', async ({ page }) => {
  const hero = page.locator('#v-path .hero.me');
  if (page.viewportSize().width > 760) {
    expect((await hero.boundingBox()).height).toBeCloseTo(270, 0);
  }
  await expect(hero.locator('.h-title')).toContainText('продолжим путь');
  await expect(hero.locator('.hbtn')).toBeVisible();
  const btn = await hero.locator('.hbtn').boundingBox();
  const hb = await hero.boundingBox();
  expect(btn.y + btn.height).toBeLessThanOrEqual(hb.y + hb.height);
});

test('карточки «ты здесь», «Карта дня», «Новое», «Мои заметки» в рамке-картуше', async ({ page }) => {
  await expect(page.locator('#v-path .panel')).toHaveClass(/tp-cart/);
  await expect(page.locator('#v-path .qc.tp-cart')).toHaveCount(2);
  await expect(page.locator('#v-path .newsbar.tp-cart')).toHaveCount(1);
});

test('семь ступеней, у закрытых замок, у текущей бейдж «лекция N из 9»', async ({ page }) => {
  const st = page.locator('#stages .stg');
  await expect(st).toHaveCount(7);
  await expect(page.locator('#stages .stg.lock')).toHaveCount(5);
  await expect(page.locator('#stages .stg.now')).toContainText(/лекция \d из 9/);
});

test('клик по пройденной ступени открывает её лекции в панели', async ({ page }) => {
  await page.locator('#stages .stg').first().click();
  await expect(page.locator('#panel')).toContainText('Освобождение');
});

test('кнопка в баннере ведёт к текущему уроку', async ({ page }) => {
  await page.locator('#v-path .hero.me .hbtn').click();
  await expect(page.locator('#v-path')).toBeHidden();
});
