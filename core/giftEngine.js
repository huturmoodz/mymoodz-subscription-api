// core/giftEngine.js

const GIFT_VARIANTS = {
  pod_bonne_nuit: {
    product_id: 'ID_PRODUIT_BN',
    variant_id: 'ID_VARIANT_BN',
    title: 'PODS Bonnes Nuits - 1 Mois',
  },
  pod_zero: {
    product_id: 'ID_PRODUIT_ZERO',
    variant_id: 'ID_VARIANT_ZERO',
    title: 'PODS Zéro - 1 Mois',
  },
  pod_bien_etre: {
    product_id: 'ID_PRODUIT_BE',
    variant_id: 'ID_VARIANT_BE',
    title: 'PODS Bien-être - 1 Mois',
  },
};

// core/giftEngine.js



const { saveGiftChoice } = require('./customerGifts');


const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

async function fetchSealSubscription(idNumber) {
  const res = await fetch(`${SEAL_BASE_URL}/subscription?id=${idNumber}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': SEAL_API_TOKEN,
    },
  });

  const json = await res.json();
  if (!res.ok || !json || !json.payload) {
    throw new Error('Erreur Seal /subscription');
  }
  return json.payload;
}

async function updateSealSubscriptionGiftItems({ subscriptionId, giftCode }) {
  if (!SEAL_API_TOKEN) {
    console.warn('[giftEngine] Pas de SEAL_API_TOKEN, skip update items');
    return { skipped: true, reason: 'NO_SEAL_TOKEN' };
  }

  const cfg = GIFT_VARIANTS[giftCode];
  if (!cfg) {
    console.warn('[giftEngine] Pas de mapping pour giftCode', giftCode);
    return { skipped: true, reason: 'NO_MAPPING' };
  }

  const idNumber = Number(subscriptionId);
  const sub = await fetchSealSubscription(idNumber);

  const items = sub.items || [];

  // On considère que le cadeau est la ligne à 0 €
  const existingGift = items.find((it) => Number(it.price) === 0);

  // Si déjà le bon variant -> rien à faire
  if (existingGift && String(existingGift.variant_id) === String(cfg.variant_id)) {
    return { changed: false, reason: 'ALREADY_OK' };
  }

  // 1) Supprimer l’ancien cadeau s’il existe
  if (existingGift) {
    await fetch(SEAL_BASE_URL + '/subscription', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Seal-Token': SEAL_API_TOKEN,
      },
      body: JSON.stringify({
        id: idNumber,
        action: 'remove_items',
        remove_items: [existingGift.id],
      }),
    });
  }

  // 2) Ajouter le nouveau cadeau
  await fetch(SEAL_BASE_URL + '/subscription', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': SEAL_API_TOKEN,
    },
    body: JSON.stringify({
      id: idNumber,
      action: 'add_items',
      add_items: [
        {
          product_id: cfg.product_id,
          variant_id: cfg.variant_id,
          quantity: 1,
          title: cfg.title,
          price: '0.0',
          taxable: 0,
          requires_shipping: 1,
          one_time: 0,
          properties: [],
        },
      ],
    }),
  });

  return { changed: true };
}



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
