// core/sealWebhook.js
const crypto = require('crypto');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_WEBHOOK_SECRET = process.env.SEAL_WEBHOOK_SECRET;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';


// 👇 Product ID du diffuseur essentiel (one-shot uniquement)
const DIFFUSER_PRODUCT_ID_SET = new Set([
  "10299097940309",
]);

// 👇 Mapping saveur abonnement -> POD 1 mois à seed en récurrence
const POD_VARIANT_BY_FLAVOR = {
  BN: "52030628725077",
  ZERO: "52166742147413",
  BE: "52166741197141",
};


// ---- Mapping "en dur" variant_id -> infos nécessaires pour Seal add_items ----
// IMPORTANT : Seal exige product_id pour add_items
const GIFT_VARIANTS_BY_ID = {
  // Bonnes Nuits - 1 mois
  "52030628725077": {
    product_id: "10297464586581",
    variant_id: "52030628725077",
    title: "PODS Bonnes Nuits - 1 Mois",
    sku: "BN1",
  },

  // Zéro - 1 semaine
  "52166742147413": {
    product_id: "10297464586581",
    variant_id: "52166742147413",
    title: "PODS Zéro - 1 Mois",
    sku: "ZERO1",
  },

  // Bien-être - 1 mois
  "52166741197141": {
    product_id: "10297464586581",
    variant_id: "52166741197141",
    title: "PODS Bien-être - 1 Mois",
    sku: "BE1",
  },
};
 
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
    const err = new Error((json && (json.message || json.error)) || `Seal error on ${path}`);
    err.seal = { url, status: res.status, body: json };
    throw err;
  }

  return json;
}


function getNoteAttrValue(subscription, name) {
  const arr = subscription?.note_attributes || [];
  const found = arr.find((a) => a?.name === name);
  return found ? String(found.value ?? '') : '';
}

function setNoteAttr(subscription, name, value) {
  const arr = Array.isArray(subscription.note_attributes) ? [...subscription.note_attributes] : [];
  const idx = arr.findIndex((a) => a?.name === name);
  if (idx >= 0) arr[idx] = { name, value };
  else arr.push({ name, value });
  return arr;
}

function verifySealHmac(rawBodyBuffer, receivedHmac) {
  if (!SEAL_WEBHOOK_SECRET) {
    console.warn('[sealWebhook] SEAL_WEBHOOK_SECRET missing -> skip verify (DEV ONLY)');
    return true;
  }

  if (!receivedHmac || !rawBodyBuffer) return false;

  // HMAC SHA256 over RAW JSON body
  const digest = crypto
    .createHmac('sha256', SEAL_WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest(); // <-- Buffer (bytes)

  // Seal may send base64 or hex. Detect format.
  const isHex = /^[0-9a-fA-F]+$/.test(receivedHmac) && receivedHmac.length >= 64;
  const received = Buffer.from(receivedHmac, isHex ? 'hex' : 'base64');

  // timingSafeEqual requires same length
  if (received.length !== digest.length) return false;

  return crypto.timingSafeEqual(received, digest);
}


async function fetchSubscription(subscriptionId) {
  const idNumber = Number(subscriptionId);
  const json = await callSeal(`/subscription?id=${idNumber}`, { method: 'GET' });
  return json.payload || json;
}

/**
 * Lit la property et ajoute un cadeau récurrent UNE SEULE FOIS
 * - stop si override = 1
 * - stop si seeded = 1
 * - ne marque jamais seeded si property absente (created trop tôt)
 */
async function addRecurringGiftFromProperty(subscription) {
  const subId = subscription.id;

  // 1) Si le client a déjà utilisé "Gérer mon cadeau" -> ne jamais toucher
  const override = getNoteAttrValue(subscription, 'mymoodz_gift_override');
  if (override === '1') {
    return { skipped: true, reason: 'override_enabled' };
  }

  // 2) Anti-doublon (une fois)
  const seeded = getNoteAttrValue(subscription, 'mymoodz_gift_seeded');
  if (seeded === '1') {
    return { skipped: true, reason: 'already_seeded' };
  }

  // 3) Trouver subscription_free_gift_variant_id dans les properties des items
  const items = subscription.items || [];
  const giftVariantId =
    items?.[0]?.properties?.find((p) => p?.key === 'subscription_free_gift_variant_id')?.value ||
    items
      .find((it) => Array.isArray(it.properties) && it.properties.length)
      ?.properties?.find((p) => p?.key === 'subscription_free_gift_variant_id')?.value ||
    null;

  if (!giftVariantId) {
    return { skipped: true, reason: 'no_property_yet' };
  }

    const flavorCode =
    items?.[0]?.properties?.find((p) => p?.key === 'subscription_flavor_code')?.value ||
    items
      .find((it) => Array.isArray(it.properties) && it.properties.length)
      ?.properties?.find((p) => p?.key === 'subscription_flavor_code')?.value ||
    null;

  
  // 4) Si déjà présent, on seed quand même
  const alreadyInItems = items.some((it) => String(it.variant_id) === String(giftVariantId));
  if (alreadyInItems) {
    const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_seeded', '1');
    await callSeal('/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: Number(subId),
        action: 'edit',
        edit: { note_attributes: newAttrs },
      }),
    });
    return { skipped: true, reason: 'already_present_seeded', giftVariantId: String(giftVariantId) };
  }

  // 5) Ajouter cadeau récurrent

  const giftVariantIdStr = String(giftVariantId);

  // 🔍 On retrouve l’item cadeau original pour lire son product_id
  const giftItemSource = items.find(
    (it) => String(it.variant_id) === giftVariantIdStr
  );

  const giftProductId = giftItemSource
    ? String(giftItemSource.product_id)
    : null;

  // 🎯 Si le cadeau est un DIFFUSEUR → on seed un POD selon la saveur
  let effectiveVariantId = giftVariantIdStr;

  if (giftProductId && DIFFUSER_PRODUCT_ID_SET.has(giftProductId)) {
    const fallbackPodVariant =
      POD_VARIANT_BY_FLAVOR[String(flavorCode || "").toUpperCase()];

    if (!fallbackPodVariant) {
      return {
        skipped: true,
        reason: "diffuser_but_no_flavor_mapping",
        giftVariantId: giftVariantIdStr,
        flavorCode,
      };
    }

    effectiveVariantId = String(fallbackPodVariant);
  }

  // ✅ Sécurité anti-doublon sur le POD effectif
  const alreadyInItems = items.some(
    (it) => String(it.variant_id) === effectiveVariantId
  );

  if (alreadyInItems) {
    const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_seeded', '1');
    await callSeal('/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: Number(subId),
        action: 'edit',
        edit: { note_attributes: newAttrs },
      }),
    });

    return {
      skipped: true,
      reason: 'already_present_seeded',
      effectiveVariantId,
    };
  }

  const cfg = GIFT_VARIANTS_BY_ID[effectiveVariantId];

  if (!cfg) {
    const newAttrs = setNoteAttr(subscription, "mymoodz_gift_seeded", "1");

    await callSeal("/subscription", {
      method: "PUT",
      body: JSON.stringify({
        id: Number(subId),
        action: "edit",
        edit: { note_attributes: newAttrs },
      }),
    });

    return {
      skipped: true,
      reason: "gift_variant_not_mapped",
      giftVariantId: giftVariantIdStr,
      effectiveVariantId,
    };
  }

  const giftItem = {
    product_id: String(cfg.product_id),
    variant_id: String(cfg.variant_id),
    quantity: "1",
    title: cfg.title,
    sku: cfg.sku,
    price: "0.00",
    taxable: 0,
    requires_shipping: 1,
    one_time: 0, // ✅ toujours récurrent ici
    total_discount: 0,
    subsc_discount_percent: 0,
    properties: [],
  };



  await callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: Number(subId),
      action: 'add_items',
      add_items: [giftItem],
    }),
  });

  // 6) Marquer seedé après succès
  const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_seeded', '1');
  await callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: Number(subId),
      action: 'edit',
      edit: { note_attributes: newAttrs },
    }),
  });

  return { added: true, giftVariantId: String(giftVariantId) };
}

/**
 * ✅ Retry: Seal peut envoyer "created" avant d'avoir les properties.
 * On refetch 3 fois max.
 */
async function addRecurringGiftFromPropertyWithRetry(initialSubscription, attempts = 3, delayMs = 1200) {
  let last = null;

  for (let i = 0; i < attempts; i++) {
    const sub = i === 0 ? initialSubscription : await fetchSubscription(initialSubscription.id);
    last = await addRecurringGiftFromProperty(sub);

    if (last?.reason === 'no_property_yet') {
      // attendre puis réessayer
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return last;
  }

  return { skipped: true, reason: 'no_property_after_retries', last };
}

module.exports = {
  verifySealHmac,
  fetchSubscription,
  addRecurringGiftFromProperty,
  addRecurringGiftFromPropertyWithRetry,
};
