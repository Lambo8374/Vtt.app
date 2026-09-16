/**
 * Vérification du maintien de l'écran dans un vrai navigateur.
 *
 * Ce comportement ne peut pas être couvert par les tests unitaires : il dépend
 * de l'API Screen Wake Lock, du cycle de visibilité de la page et de la lecture
 * vidéo. Il est pourtant le plus critique de l'application — un écran qui
 * s'éteint troue la trace — et le plus facile à casser sans s'en apercevoir.
 *
 * L'API est instrumentée avant le chargement de la page, ce qui permet de
 * simuler une révocation par le système et un refus, deux cas impossibles à
 * provoquer autrement.
 *
 * Usage : npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:4173/';
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'OK  ' : 'ECHEC'}  ${label} : ${actual}${ok ? '' : ` (attendu ${expected})`}`);
  if (!ok) failures.push(label);
}

async function waitForServer(timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(URL);
      if (res.ok) return true;
    } catch {
      // Le serveur n'écoute pas encore.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function launchBrowser() {
  // Certains environnements fournissent Chromium hors de l'arborescence que
  // Playwright interroge par défaut.
  const executablePath = process.env.CHROMIUM_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
  stdio: 'ignore',
  detached: false,
});

try {
  if (!(await waitForServer())) throw new Error(`Serveur injoignable sur ${URL} — lancez « npm run build ».`);

  const browser = await launchBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    locale: 'fr-FR',
    permissions: ['geolocation'],
    geolocation: { latitude: 45, longitude: 6.1, accuracy: 6 },
  });

  await ctx.addInitScript(() => {
    window.__wake = { requests: 0, locks: [] };
    const api = {
      async request(type) {
        window.__wake.requests++;
        if (window.__wakeShouldFail) throw new Error('refusé par le système (test)');
        const listeners = [];
        const lock = {
          type,
          released: false,
          addEventListener: (_e, fn) => listeners.push(fn),
          removeEventListener: () => {},
          async release() {
            this.released = true;
            listeners.forEach((f) => f());
          },
          /** Simule une reprise du verrou par le système d'exploitation. */
          __revoke() {
            this.released = true;
            listeners.forEach((f) => f());
          },
        };
        window.__wake.locks.push(lock);
        return lock;
      },
    };
    Object.defineProperty(navigator, 'wakeLock', { value: api, configurable: true });
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Les tuiles distantes ne sont pas nécessaires ici.
  await ctx.route('**/*.png', (r) =>
    r.request().url().includes('tile')
      ? r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>' })
      : r.continue(),
  );

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const badge = () => page.locator('.badge').nth(1).textContent().then((t) => t?.trim());

  // Aucun verrou tant que la sortie n'a pas commencé.
  check('aucun verrou avant le départ', await page.evaluate(() => window.__wake.requests), 0);

  await page.getByRole('button', { name: /D.marrer/ }).click();
  await page.waitForTimeout(1000);
  check('verrou pris au démarrage', await page.evaluate(() => window.__wake.requests), 1);
  check('écran annoncé maintenu', await badge(), 'Écran maintenu');

  // La pause fait partie de la sortie : le verrou doit tenir.
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(700);
  check('verrou conservé en pause', await page.evaluate(() => window.__wake.locks.some((l) => !l.released)), true);

  // Révocation par le système, sans changement de visibilité.
  await page.evaluate(() => window.__wake.locks.filter((l) => !l.released).forEach((l) => l.__revoke()));
  await page.waitForTimeout(800);
  check('verrou repris immédiatement', await page.evaluate(() => window.__wake.requests), 2);
  check('écran de nouveau maintenu', await badge(), 'Écran maintenu');

  // Refus persistant : le repli vidéo prend le relais et l'interface le dit.
  await page.evaluate(() => {
    window.__wakeShouldFail = true;
  });
  await page.evaluate(() => window.__wake.locks.filter((l) => !l.released).forEach((l) => l.__revoke()));
  await page.waitForTimeout(2500);
  check(
    'repli vidéo en lecture',
    await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? !v.paused : false;
    }),
    true,
  );
  check('repli annoncé comme tel', await badge(), 'Écran maintenu (secours)');

  check('aucune erreur de page', errors.length, 0);
  await browser.close();
} finally {
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} vérification(s) en échec : ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nToutes les vérifications passent.');
