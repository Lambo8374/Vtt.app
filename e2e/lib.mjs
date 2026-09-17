/**
 * Outils communs aux vérifications de bout en bout.
 *
 * Certains comportements ne peuvent pas être couverts par les tests unitaires :
 * ils dépendent de la mise en page réelle, du cycle de vie de la page ou d'API
 * du navigateur. Ce sont précisément ceux qui cassent sans qu'on s'en aperçoive,
 * d'où cette seconde ligne de vérification.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

export const URL = 'http://127.0.0.1:4173/';

/** Écran de référence : un téléphone courant, en portrait. */
export const PHONE = { width: 414, height: 896 };

export function createReporter() {
  const failures = [];
  return {
    failures,
    check(label, actual, expected) {
      const ok = actual === expected;
      console.log(`  ${ok ? 'OK  ' : 'ECHEC'}  ${label} : ${actual}${ok ? '' : ` (attendu ${expected})`}`);
      if (!ok) failures.push(label);
    },
  };
}

export async function startServer() {
  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], { stdio: 'ignore' });
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    try {
      const res = await fetch(URL);
      if (res.ok) return server;
    } catch {
      // Le serveur n'écoute pas encore.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  server.kill();
  throw new Error(`Serveur injoignable sur ${URL} — lancez « npm run build ».`);
}

export function launchBrowser() {
  // Certains environnements fournissent Chromium hors de l'arborescence que
  // Playwright interroge par défaut.
  const executablePath = process.env.CHROMIUM_PATH;
  return chromium.launch(executablePath ? { executablePath } : {});
}

/** Remplace les tuiles distantes : elles ne servent à aucune vérification. */
export async function stubTiles(ctx) {
  await ctx.route('**/*.png', (r) =>
    r.request().url().includes('tile')
      ? r.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>',
        })
      : r.continue(),
  );
}

/** Mètres par degré de latitude, pour déplacer la position simulée. */
export const M_PER_DEG = 111_194.9;

/**
 * Simule un déplacement vers le nord à vitesse réaliste.
 *
 * Aller plus vite ferait rejeter les points par le filtre d'aberrations, qui
 * plafonne à 25 m/s : la trace resterait vide et la vérification ne prouverait
 * rien.
 */
export async function ride(ctx, page, { from = 0, to = 40, lat = 45, lon = 6.1, stepMeters = 1, delayMs = 200 } = {}) {
  for (let i = from + 1; i <= to; i++) {
    await ctx.setGeolocation({ latitude: lat + (i * stepMeters) / M_PER_DEG, longitude: lon, accuracy: 6 });
    await page.waitForTimeout(delayMs);
  }
}
