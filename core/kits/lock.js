// core/kits/lock.js
// Verrou en mémoire par clé (une commande, un abonnement) : deux webhooks qui arrivent
// en même temps pour la même commande sont traités l'un après l'autre, jamais en parallèle.
const chains = new Map();

function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

module.exports = { withLock };
