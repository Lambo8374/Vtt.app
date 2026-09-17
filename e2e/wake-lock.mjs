/**
 * Vérification du maintien de l'écran dans un vrai navigateur.
 *
 * Ce comportement ne peut pas être couvert par les tests unitaires : il dépend
 * de l'API Screen Wake Lock, du cycle de visibilité de la page et de la lecture
 * vidéo. Il est pourtant le plus critique de l'application — un écran qui
 * s'éteint troue la trace — et le plus facile à casser sans s'en apercevoir.
 *
 * L'API est instrumentée avant le chargement de la page : c'est le seul moyen
 * de provoquer une révocation par le système et un refus du verrou.
 */
import { PHONE, URL, stubTiles } from './lib.mjs';

export const name = 'Maintien de l\'écran';

export async function run({ browser, check }) {
  const ctx = await browser.newContext({
    viewport: PHONE,
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

  await stubTiles(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

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
  await ctx.close();
}
