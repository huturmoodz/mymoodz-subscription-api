// core/giftEngine.js

const { saveGiftChoice } = require('./customerGifts');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL =
  'https://app.sealsubscriptions.com/shopify/merchant/api';

/**
 * Mapping des cadeaux -> produits/variantes Shopify vus par Seal
 * (IDs que tu as déjà remplis)
 */
const GIFT_VARIANTS = {
  pod_bonne_nuit: {
    product_id: '10297464586581',
    variant_id: '52030628725077',
    title: 'PODS Bonnes Nuits - 1 Mois',
    sku: null,
  },
  pod_zero: {
    product_id: '10297464586581',
    variant_id: '52166742147413',
    title: 'PODS Zéro - 1 Mois',
    sku: null,
  },
  pod_bien_etre: {
    product_id: '10297464586581',
    variant_id: '52166741197141',
    title: 'PODS Bien-être - 1 Mois',
    sku: null,
  },
};

// Pour reconnaître tous les items cadeau déjà présents dans l’abonnement
const GIFT_VARIANT_ID_SET = new Set(
  Object.values(GIFT_VARIANTS).map((g) => String(g.variant_id))
);

/* ------------------ Helpers Seal ------------------ */

async function callSeal(path, options) {
  if (!SEAL_API_TOKEN) {
    throw new Error('SEAL_API_TOKEN manquant');
  }

  const url = `${SEAL_BASE_URL}${path}`;

  const res = await fetch(url, {
    ...(options || {}),
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': SEAL_API_TOKEN,
      ...(options && options.headers),
    },
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    console.error('[giftEngine] Réponse Seal non-JSON', url);
  }

  if (!res.ok || !json || json.success === false) {
    const err = new Error(
      (json && json.message) ||
        (json && json.error) ||
        `Seal error on ${path}`
    );
    err.seal = {
      url,
      status: res.status,
      body: json,
    };
    console.error('[giftEngine] Erreur Seal', err.seal);
    throw err;
  }

  return json;
}

/**
 * Récupère la subscription complète (endpoint /subscription)
 */
async function fetchSubscription(subscriptionId) {
  const idNumber = Number(subscriptionId);
  const json = await callSeal(`/subscription?id=${idNumber}`, {
    method: 'GET',
  });

  return json.payload || json;
}

/**
 * Met à jour la note mymoodz_free_gift_code sur la subscription
 */
async function updateNoteAttribute(subscriptionId, giftCode) {
  const idNumber = Number(subscriptionId);

  return callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: idNumber,
      action: 'edit',
      edit: {
        note_attributes: [
          {
            name: 'mymoodz_free_gift_code',
            value: giftCode,
          },
        ],
      },
    }),
  });
}

/**
 * Supprime tous les items cadeau de la subscription
 */
async function removeExistingGiftItems(subscription) {
  const items = subscription.items || [];
  const toRemoveIds = items
    .filter((it) => GIFT_VARIANT_ID_SET.has(String(it.variant_id)))
    .map((it) => it.id);

  if (toRemoveIds.length === 0) {
    console.log('[giftEngine] Aucun ancien cadeau à retirer');
    return [];
  }

  console.log('[giftEngine] Retrait des cadeaux existants', toRemoveIds);

  await callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: subscription.id,
      action: 'remove_items',
      remove_items: toRemoveIds,
    }),
  });

  return toRemoveIds;
}

/**
 * Construit l’item cadeau à ajouter
 * → on colle au format de la doc, avec le max de champs safe
 */
function buildGiftItem(giftCode) {
  const cfg = GIFT_VARIANTS[giftCode];
  if (!cfg) return null;

  return {
    product_id: String(cfg.product_id),
    variant_id: String(cfg.variant_id),
    quantity: '1',
    title: cfg.title,
    sku: cfg.sku,
    price: '0.00',               // string, comme dans leur exemple
    taxable: 0,
    requires_shipping: 1,
    one_time: 1,                 // cadeau one-shot pour ce cycle
    total_discount: 0,
    subsc_discount_percent: 0,
    properties: [],
  };
}

/**
 * Ajoute le nouvel item cadeau via action: "add_items"
 */
async function addGiftItem(subscriptionId, giftCode) {
  const item = buildGiftItem(giftCode);
  if (!item) {
    console.warn('[giftEngine] Pas de config pour le giftCode', giftCode);
    return null;
  }

  console.log('[giftEngine] Ajout du cadeau', { subscriptionId, item });

  const idNumber = Number(subscriptionId);

  const res = await callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: idNumber,
      action: 'add_items',
      add_items: [item],
    }),
  });

  return res;
}

/* ------------------ Fonction principale ------------------ */

async function applyGiftChange({ subscriptionId, customerEmail, giftCode }) {
  if (!subscriptionId || !giftCode) {
    throw new Error('subscriptionId et giftCode sont obligatoires');
  }

  // 0) Trace côté serveur (debug + backup)
  const record = saveGiftChoice({
    subscriptionId,
    customerId: customerEmail || null,
    giftCode,
  });

  if (!SEAL_API_TOKEN) {
    console.warn(
      '[giftEngine] SEAL_API_TOKEN manquant, on ne touche pas à Seal.'
    );
    return {
      success: true,
      data: {
        ...record,
        sealNoteUpdated: false,
        sealItemsUpdated: false,
      },
    };
  }

  let subscription = null;
  let removedIds = [];
  let addResult = null;
  let noteResult = null;

  try {
    // 1) Récupérer la subscription complète
    subscription = await fetchSubscription(subscriptionId);

    // 2) Retirer tous les anciens cadeaux
    removedIds = await removeExistingGiftItems(subscription);

    // 3) Ajouter le nouveau cadeau
    addResult = await addGiftItem(subscriptionId, giftCode);

    // 4) Mettre à jour la note
    noteResult = await updateNoteAttribute(subscriptionId, giftCode);
  } catch (err) {
    console.error('[giftEngine] Erreur applyGiftChange', err);

    return {
      success: false,
      error: err.message || 'Erreur lors de la mise à jour du cadeau',
      data: {
        ...record,
        removedIds,
        subscriptionId,
        sealError: err.seal || null, // 👈 très important pour debug
      },
    };
  }

  return {
    success: true,
    data: {
      ...record,
      removedIds,
      addResult,
      noteResult,
    },
  };
}

module.exports = {
  applyGiftChange,
};
