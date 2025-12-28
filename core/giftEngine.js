// core/giftEngine.js

const { saveGiftChoice } = require('./customerGifts');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;

/**
 * Appelle l'API Merchant de Seal pour écrire le code cadeau
 * dans les note_attributes de l'abonnement.
 */
async function updateSealSubscriptionNote({ subscriptionId, giftCode }) {
  if (!SEAL_API_TOKEN) {
    console.warn('[giftEngine] SEAL_API_TOKEN manquant, on saute l’appel Seal.');
    return { skipped: true, reason: 'NO_SEAL_TOKEN' };
  }

  if (!subscriptionId || !giftCode) {
    throw new Error('subscriptionId et giftCode sont obligatoires pour Seal.');
  }

  const url =
    'https://app.sealsubscriptions.com/shopify/merchant/api/subscription';

  // Seal attend un ID numérique
  const idNumber = Number(subscriptionId);

  const body = {
    id: idNumber,
    action: 'edit',
    edit: {
      // On écrase ce note_attributes avec notre clé
      note_attributes: [
        {
          name: 'mymoodz_free_gift_code',
          value: giftCode,
        },
      ],
    },
  };

  console.log('[giftEngine] Appel Seal /subscription', {
    id: idNumber,
    giftCode,
  });

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': SEAL_API_TOKEN,
    },
    body: JSON.stringify(body),
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    console.error('[giftEngine] Impossible de parser la réponse Seal en JSON');
  }

  if (!res.ok || !json || json.success === false) {
    console.error('[giftEngine] Erreur Seal API', {
      status: res.status,
      body: json,
    });
    throw new Error('Seal API returned an error');
  }

  return json;
}

/**
 * Fonction principale appelée par /change-gift
 */
async function applyGiftChange({ subscriptionId, customerEmail, giftCode }) {
  if (!subscriptionId || !giftCode) {
    throw new Error('subscriptionId et giftCode sont obligatoires');
  }

  // 1) On garde une trace en mémoire (debug + backup)
  const record = saveGiftChoice({
    subscriptionId,
    customerId: customerEmail || null,
    giftCode,
  });

  // 2) On tente la mise à jour dans Seal
  let sealResult = null;
  try {
    sealResult = await updateSealSubscriptionNote({ subscriptionId, giftCode });
  } catch (err) {
    console.error('[giftEngine] Erreur lors de l’update Seal:', err.message);
  }

  // ⚠️ On ne bloque pas le succès UI même si Seal a raté,
  // mais on garde l’info dans sealResult pour debug.
  return {
    success: true,
    data: {
      ...record,
      sealResult,
    },
  };
}

module.exports = {
  applyGiftChange,
};
