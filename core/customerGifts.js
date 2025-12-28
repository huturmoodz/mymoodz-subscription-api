// core/customerGifts.js

/**
 * Stockage en mémoire :
 * key = subscriptionId (ou autre identifiant)
 * value = { giftCode, updatedAt, customerId? }
 *
 * ⚠️ MVP : ne survit pas à un redeploy Render.
 * On l'utilise pour valider le flow.
 */
const memoryStore = new Map();

/**
 * Sauvegarde le choix de cadeau pour un abonnement.
 */
function saveGiftChoice({ subscriptionId, customerId, giftCode }) {
  if (!subscriptionId || !giftCode) {
    throw new Error("subscriptionId et giftCode sont obligatoires");
  }

  const record = {
    subscriptionId,
    customerId: customerId || null,
    giftCode,
    updatedAt: new Date().toISOString(),
  };

  memoryStore.set(subscriptionId, record);
  return record;
}

/**
 * Récupère le choix de cadeau pour un abonnement.
 */
function getGiftChoiceForSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return memoryStore.get(subscriptionId) || null;
}

/**
 * Liste tous les choix en mémoire (debug uniquement).
 */
function listAllGiftChoices() {
  return Array.from(memoryStore.values());
}

module.exports = {
  saveGiftChoice,
  getGiftChoiceForSubscription,
  listAllGiftChoices,
};
