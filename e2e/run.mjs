/**
 * Lance toutes les vérifications de bout en bout.
 *
 * Le serveur et le navigateur sont démarrés une seule fois ; chaque
 * vérification ouvre son propre contexte, pour que l'état de l'une (stockage
 * local, service worker, API instrumentée) n'influence pas les autres.
 *
 * Usage : npm run test:e2e
 */
import { createReporter, launchBrowser, startServer } from './lib.mjs';
import * as wakeLock from './wake-lock.mjs';
import * as finDeSortie from './fin-de-sortie.mjs';
import * as suiviDeTrace from './suivi-de-trace.mjs';

const checks = [wakeLock, finDeSortie, suiviDeTrace];
const server = await startServer();
const failed = [];

try {
  const browser = await launchBrowser();
  try {
    for (const suite of checks) {
      console.log(`\n${suite.name}`);
      const reporter = createReporter();
      await suite.run({ browser, check: reporter.check });
      failed.push(...reporter.failures.map((f) => `${suite.name} → ${f}`));
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}

if (failed.length) {
  console.error(`\n${failed.length} vérification(s) en échec :`);
  for (const f of failed) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nToutes les vérifications passent.');
