/** Renders the PNG app icons from assets/icons/app-icon.svg (needs Playwright's Chromium). */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile(new URL('../assets/icons/app-icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const targets = [
  ['icon-192.png', 192, 0.22], ['icon-512.png', 512, 0.22], ['apple-touch-icon.png', 180, 0], ['icon-maskable-512.png', 512, 0],
];
for (const [name, size, radius] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block;border-radius:${radius * size}px}</style>${svg}`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  await writeFile(new URL(`../assets/icons/${name}`, import.meta.url), png);
  console.log('wrote', name);
}
await browser.close();
