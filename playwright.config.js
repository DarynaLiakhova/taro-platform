// Тесты платформы «Путь Таролога». Запуск: npm test
const { defineConfig, devices } = require('@playwright/test');

// Chrome подставляет вместо микрофона тестовый звук и не спрашивает разрешения
const fakeMic = { launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } };

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', ...fakeMic },
  projects: [
    { name: 'телефон 412', use: { ...devices['Pixel 7'], viewport: { width: 412, height: 860 }, ...fakeMic } },
    { name: 'ноутбук 1366', use: { viewport: { width: 1366, height: 800 }, ...fakeMic } },
  ],
});
