/**
 * Identifiant unique, avec repli hors contexte sécurisé.
 *
 * `crypto.randomUUID` n'existe pas sur une origine non sécurisée : tester la
 * PWA depuis un téléphone sur `http://192.168.x.x` ferait échouer toute
 * création de circuit. Le repli n'a pas les garanties d’un vrai UUID v4, ce qui
 * est sans conséquence pour des clés locales à un appareil.
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
