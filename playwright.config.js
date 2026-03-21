import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: false,
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--use-angle=d3d11'
      ]
    }
  },
  webServer: {
    command: 'npm run serve',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120000
  }
});
