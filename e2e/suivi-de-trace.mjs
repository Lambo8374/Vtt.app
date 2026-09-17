/**
 * Choix de la trace à suivre.
 *
 * Défaut remonté en usage réel : après avoir enregistré une sortie, la liste
 * « Suivre une trace » ne proposait que « Aucune ». Elle ne listait que les
 * circuits dessinés dans l'onglet Créer, jamais les sorties enregistrées —
 * alors que refaire une trace déjà roulée est l'usage le plus courant.
 *
 * La vérification couvre les deux origines, et va jusqu'à l'armement réel du
 * suivi : une entrée présente dans la liste mais qui ne déclenche rien ne vaut
 * pas mieux qu'une liste vide.
 */
import { PHONE, URL, ride, stubTiles } from './lib.mjs';

export const name = 'Suivi de trace';

export async function run({ browser, check }) {
  const ctx = await browser.newContext({
    viewport: PHONE,
    locale: 'fr-FR',
    permissions: ['geolocation'],
    geolocation: { latitude: 45, longitude: 6.1, accuracy: 6 },
  });
  await stubTiles(ctx);
  // Le service de calcul d'itinéraire n'est pas joignable ici : le tracé du
  // circuit se fait en ligne droite, ce qui suffit à cette vérification.
  await ctx.route('**/brouter**', (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const options = async () => {
    await page.getByRole('button', { name: 'Rouler' }).click();
    await page.waitForTimeout(600);
    return page.locator('select').first().locator('option').allTextContents();
  };

  await page.goto(URL, { waitUntil: 'networkidle' });
  check('liste vide au départ', (await options()).length, 1);

  // Une sortie enregistrée doit devenir suivable.
  await page.getByRole('button', { name: /D.marrer/ }).click();
  await ride(ctx, page, { to: 40 });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Terminer' }).click();
  await page.waitForTimeout(700);
  await page.locator('.modal__card input[type=text]').fill('Sortie à refaire');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.waitForTimeout(1500);

  const afterRide = await options();
  check('sortie enregistrée proposée au suivi', afterRide.some((o) => o.startsWith('Sortie à refaire')), true);

  // Un circuit dessiné doit l'être aussi, sans faire disparaître la sortie.
  await page.getByRole('button', { name: /^Cr.er$/ }).click();
  await page.waitForTimeout(800);
  await page.locator('select').filter({ has: page.locator('option[value="none"]') }).selectOption('none');
  const box = await page.locator('.map').boundingBox();
  for (const [dx, dy] of [
    [0.35, 0.35],
    [0.6, 0.45],
    [0.6, 0.7],
  ]) {
    await page.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await page.waitForTimeout(450);
  }
  await page.locator('input[type=text]').fill('Circuit dessiné');
  await page.getByRole('button', { name: /Enregistrer le circuit/ }).click();
  await page.waitForTimeout(1500);

  const afterRoute = await options();
  check('circuit proposé au suivi', afterRoute.some((o) => o.startsWith('Circuit dessiné')), true);
  check('sortie toujours proposée', afterRoute.some((o) => o.startsWith('Sortie à refaire')), true);

  // Sélectionner une sortie doit réellement armer le suivi.
  const select = page.locator('select').first();
  const trackOption = await select.locator('option[value^="track:"]').first().getAttribute('value');
  check('sortie identifiable dans la liste', typeof trackOption === 'string', true);
  await select.selectOption(trackOption);
  await page.waitForTimeout(600);

  await page.getByRole('button', { name: /D.marrer/ }).click();
  await ride(ctx, page, { to: 25 });
  await page.waitForTimeout(2200);

  const panel = page.locator('.panel', { hasText: 'Suivi de' });
  check('panneau de suivi affiché', await panel.count(), 1);
  const title = (await panel.locator('.panel__title').textContent())?.trim();
  check('trace suivie nommée', title, 'Suivi de « Sortie à refaire »');
  check('avancement calculé', (await panel.locator('.tile').count()) >= 4, true);

  // Le suivi doit être lisible sans faire défiler : à vélo on ne fait pas défiler.
  const panelBox = await panel.boundingBox();
  check('suivi visible sans défilement', panelBox !== null && panelBox.y < PHONE.height, true);

  check('aucune erreur de page', errors.length, 0);
  await ctx.close();
}
