
// core/giftEngine.js

const { saveGiftChoice } = require('./customerGifts');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL =
  'https://app.sealsubscriptions.com/shopify/merchant/api';

/**
 * Mapping des cadeaux -> produits/variantes Shopify vus par Seal
 * ⚠️ REMPLACE les IDs ci-dessous par les vrais (ce que tu as déjà fait).
 */
const GIFT_VARIANTS = {
  pod_bonne_nuit: {
    product_id: '10339299262805',
    variant_id: '52143294251349',
    title: 'PODS Bonnes Nuits - 1 Mois',
  },
  pod_zero: {
    product_id: '10339299656021',
    variant_id: '52143295037781',
    title: 'PODS Zéro - 1 Mois',
  },
  pod_bien_etre: {
    product_id: '10339299623253',
    variant_id: '52143294939477',
    title: 'PODS Bien-être - 1 Mois',
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
    console.error('[giftEngine] Erreur Seal', {
      url,
      status: res.status,
      body: json,
    });
    throw new Error(`Seal error on ${path}`);
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
 * Supprime tous les items cadeau (toutes nos variantes cadeau) de la subscription
 * --> utilise action: "remove_items", comme dans la doc
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
 * Construit l’item cadeau à ajouter (format conforme à "add_items" dans la doc)
 */
function buildGiftItem(giftCode) {
  const cfg = GIFT_VARIANTS[giftCode];
  if (!cfg) return null;

  return {
    product_id: String(cfg.product_id),
    variant_id: String(cfg.variant_id),
    quantity: '1',
    title: cfg.title,
    sku: null,
    price: 0, // cadeau = 0€
    taxable: 0,
    requires_shipping: 1,
    one_time: 1, // 1 = item one-shot, on le remettra à chaque cycle via webhook
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

  // 0) On garde une trace côté serveur (debug + backup)
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
