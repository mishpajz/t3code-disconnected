// Drives the web UI in headless Chromium so browser-side requests are covered:
// pairs through the pairing URL, opens the main screens, then stays idle so
// background timers get a chance to fire.
// Usage: node drive.mjs <pairing-url> <idle-seconds> <out-dir>
import { createRequire } from "node:module";

const require = createRequire("/app/apps/web/package.json");
const { chromium } = require("playwright");

const [pairingUrl, idleSecondsArg, outDir] = process.argv.slice(2);
const idleSeconds = Number(idleSecondsArg);
const origin = new URL(pairingUrl).origin;
const routes = [
  "/",
  "/settings/general",
  "/settings/providers",
  "/settings/connections",
  "/settings/appearance",
  "/settings/integrations",
  "/settings/source-control",
  "/settings/diagnostics",
  "/usage",
  "/",
];

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (message) => {
  if (message.type() === "error") console.log(`[browser] ${message.text()}`);
});

console.log(`pairing via ${pairingUrl}`);
await page.goto(pairingUrl, { waitUntil: "load" });
await page.waitForTimeout(5_000);

for (const route of routes) {
  console.log(`visiting ${route}`);
  await page
    .goto(origin + route, { waitUntil: "load" })
    .catch((error) => console.log(`  ${error.message}`));
  await page.waitForTimeout(4_000);
}
await page.screenshot({ path: `${outDir}/ui.png`, fullPage: true });

console.log(`idling for ${idleSeconds}s`);
await page.waitForTimeout(idleSeconds * 1_000);
await browser.close();
