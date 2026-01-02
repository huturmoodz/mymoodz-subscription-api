// core/giftEngine.js
const { saveGiftChoice } = require('./customerGifts');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

/**
 * Mapping des cadeaux -> produits/variantes Shopify vus par Seal
 */
const GIFT_VARIANTS = {
  pod_bonne_nuit: {
    product_id: '10297464586581',
    variant_id: '52030628725077',
    title: 'PODS Bonnes Nuits - 1 Mois',
    sku: 'BN1',
  },
  pod_zero: {
    product_id: '10297464586581',
    variant_id: '52166742147413',
    title: 'PODS Zéro - 1 Mois',
    sku: 'ZERO1',
  },
  pod_bien_etre: {
    product_id: '10297464586581',
    variant_id: '52166741197141',
    title: 'PODS Bien-être - 1 Mois',
    sku: 'BE1',
  },
};

// Pour reconnaître tous les items cadeau déjà présents dans l’abonnement
const GIFT_VARIANT_ID_SET = new Set(
  Object.values(GIFT_VARIANTS).map((g) => String(g.variant_id))
);

/* ------------------ Helpers Seal ------------------ */

async function callSeal(path, options) {
  if (!SEAL_API_TOKEN) throw new Error('SEAL_API_TOKEN manquant');

  const url = `${SEAL_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...(options || {}),
    headers: {
      'Content-Type': 'application/json',
      'X-Seal-Token': SEAL_API_TOKEN,
      ...(options?.headers || {}),
    },
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json || json.success === false) {
    const err = new Error(
      (json && (json.message || json.error)) || `Seal error on ${path}`
    );
    err.seal = { url, status: res.status, body: json };
    throw err;
  }

  return json;
}

async function fetchSubscription(subscriptionId) {
  const idNumber = Number(subscriptionId);
  const json = await callSeal(`/subscription?id=${idNumber}`, { method: 'GET' });
  return json.payload || json;
}

/* ------------------ Notes merge (anti écrasement) ------------------ */

function mergeNoteAttributes(existing = [], toUpsert = []) {
  const map = new Map(
    existing.map((a) => [
      String(a.name),
      { name: String(a.name), value: String(a.value ?? '') },
    ])
  );

  for (const a of toUpsert) {
    map.set(String(a.name), {
      name: String(a.name),
      value: String(a.value ?? ''),
    });
  }

  return Array.from(map.values());
}

async function editNoteAttributesMerge(subscriptionId, attrsToUpsert) {
  const sub = await fetchSubscription(subscriptionId);
  const merged = mergeNoteAttributes(sub.note_attributes || [], attrsToUpsert);

  return callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: Number(subscriptionId),
      action: 'edit',
      edit: { note_attributes: merged },
    }),
  });
}

async function updateNoteAttribute(subscriptionId, giftCode) {
  return editNoteAttributesMerge(subscriptionId, [
    { name: 'mymoodz_free_gift_code', value: giftCode },
  ]);
}

async function setGiftOverride(subscriptionId) {
  return editNoteAttributesMerge(subscriptionId, [
    { name: 'mymoodz_gift_override', value: '1' },
  ]);
}

/* ------------------ Items gifts ------------------ */

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

function buildGiftItem(giftCode) {
  const cfg = GIFT_VARIANTS[giftCode];
  if (!cfg) return null;

  return {
    product_id: String(cfg.product_id),
    variant_id: String(cfg.variant_id),
    quantity: '1',
    title: cfg.title,
    sku: cfg.sku,
    price: '0.00',
    taxable: 0,
    requires_shipping: 1,
    one_time: 0, // ✅ RÉCURRENT (si tu veux récurrent via gérer mon cadeau aussi)
    total_discount: 0,
    subsc_discount_percent: 0,
    properties: [],
  };
}

async function addGiftItem(subscriptionId, giftCode) {
  const item = buildGiftItem(giftCode);
  if (!item) {
    console.warn('[giftEngine] Pas de config pour le giftCode', giftCode);
    return null;
  }

  console.log('[giftEngine] Ajout du cadeau', { subscriptionId, item });

  return callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: Number(subscriptionId),
      action: 'add_items',
      add_items: [item],
    }),
  });
}

/* ------------------ Main ------------------ */

async function applyGiftChange({ subscriptionId, customerEmail, giftCode }) {
  if (!subscriptionId || !giftCode) {
    throw new Error('subscriptionId et giftCode sont obligatoires');
  }

  const record = saveGiftChoice({
    subscriptionId,
    customerId: customerEmail || null,
    giftCode,
    updatedAt: new Date().toISOString(),
  });

  if (!SEAL_API_TOKEN) {
    return {
      success: true,
      data: { ...record, sealNoteUpdated: false, sealItemsUpdated: false },
    };
  }

  let subscription = null;
  let removedIds = [];
  let addResult = null;
  let noteResult = null;
  let overrideResult = null;

  try {
    subscription = await fetchSubscription(subscriptionId);
    removedIds = await removeExistingGiftItems(subscription);
    addResult = await addGiftItem(subscriptionId, giftCode);

    noteResult = await updateNoteAttribute(subscriptionId, giftCode);
    overrideResult = await setGiftOverride(subscriptionId); // ✅ bloque tout reset par webhook

  } catch (err) {
    console.error('[giftEngine] Erreur applyGiftChange', err);
    return {
      success: false,
      error: err.message || 'Erreur lors de la mise à jour du cadeau',
      data: { ...record, removedIds, subscriptionId, sealError: err.seal || null },
    };
  }

  return {
    success: true,
    data: { ...record, removedIds, addResult, noteResult, overrideResult },
  };
}

module.exports = {
  applyGiftChange,
};
