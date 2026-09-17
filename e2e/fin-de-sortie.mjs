/**
 * Fin de sortie : l'appui sur « Terminer » doit être visible et arrêter le relevé.
 *
 * Défaut constaté en usage réel : le formulaire d'enregistrement était ajouté à
 * la suite des autres blocs, donc sous la carte et sous toutes les mesures. Sur
 * un téléphone il apparaissait à plus de 1200 px, hors écran. L'appui semblait
 * sans effet — et surtout le relevé continuait, si bien que la distance montait
 * encore après qu'on avait décidé d'arrêter.
 *
 * Ces deux points ne sont vérifiables que dans un vrai navigateur : le premier
 * dépend de la mise en page effective, le second de l'enchaînement des états.
 */
import { PHONE, URL, ride, stubTiles } from './lib.mjs';

export const name = 'Fin de sortie';

export async function run({ browser, check }) {
  const ctx = await browser.newContext({
    viewport: PHONE,
    locale: 'fr-FR',
    permissions: ['geolocation'],
    geolocation: { latitude: 45, longitude: 6.1, accuracy: 6 },
  });
  await stubTiles(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /D.marrer/ }).click();
  await ride(ctx, page, { to: 40 });
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: 'Terminer' }).click();
  await page.waitForTimeout(800);

  const card = page.locator('.modal__card');
  check('boîte de fin de sortie ouverte', await card.count(), 1);

  // Le cœur du défaut : la boîte doit être dans l'écran, sans défilement.
  const box = await card.boundingBox();
  check('boîte visible sans faire défiler', box !== null && box.y >= 0 && box.y < PHONE.height, true);

  // Les commandes du bas laisseraient sinon deux jeux d'actions contradictoires.
  check('commandes du bas masquées', await page.locator('.controls .btn').count(), 0);

  // Le relevé doit être arrêté : toute distance ajoutée après coup fausserait
  // le chiffre que le cycliste vient de lire.
  const readDistance = () => page.locator('.tile').first().textContent();
  const before = await readDistance();
  await ride(ctx, page, { from: 40, to: 60 });
  await page.waitForTimeout(2500);
  check('distance gelée après « Terminer »', (await readDistance()) === before, true);

  // Reprendre doit être possible : un appui par erreur ne doit pas coûter la sortie.
  await page.getByRole('button', { name: 'Continuer la sortie' }).click();
  await page.waitForTimeout(600);
  check('reprise possible', await page.locator('.modal__card').count(), 0);
  check('commandes du bas revenues', await page.locator('.controls .btn').count(), 2);

  // Puis terminer pour de bon, et vérifier que la sortie est bien enregistrée.
  await page.getByRole('button', { name: 'Terminer' }).click();
  await page.waitForTimeout(700);
  await page.locator('.modal__card input[type=text]').fill('Sortie de vérification');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.waitForTimeout(1500);

  check('boîte refermée après enregistrement', await page.locator('.modal__card').count(), 0);
  const saved = await page.locator('.list__name').first().textContent();
  check('sortie présente dans la bibliothèque', saved?.trim(), 'Sortie de vérification');

  check('aucune erreur de page', errors.length, 0);
  await ctx.close();
}
