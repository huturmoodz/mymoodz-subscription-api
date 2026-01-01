// core/sealWebhook.js
const crypto = require('crypto');

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_WEBHOOK_SECRET = process.env.SEAL_WEBHOOK_SECRET;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

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

function getNoteAttrValue(subscription, name) {
  const arr = subscription?.note_attributes || [];
  const found = arr.find((a) => a?.name === name);
  return found ? String(found.value ?? '') : '';
}

function setNoteAttr(subscription, name, value) {
  const arr = Array.isArray(subscription.note_attributes)
    ? [...subscription.note_attributes]
    : [];
  const idx = arr.findIndex((a) => a?.name === name);
  if (idx >= 0) arr[idx] = { name, value };
  else arr.push({ name, value });
  return arr;
}

function verifySealHmac(rawBodyBuffer, receivedHmac) {
  if (!SEAL_WEBHOOK_SECRET) {
    // Si tu veux forcer la vérif, retire ce fallback.
    console.warn('[sealWebhook] SEAL_WEBHOOK_SECRET manquant -> skip hmac verify');
    return true;
  }
  if (!receivedHmac) return false;

  const computed = crypto
    .createHmac('sha256', SEAL_WEBHOOK_SECRET)
    .update(rawBodyBuffer)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHmac),
      Buffer.from(computed)
    );
  } catch {
    return false;
  }
}

async function fetchSubscription(subscriptionId) {
  const idNumber = Number(subscriptionId);
  const json = await callSeal(`/subscription?id=${idNumber}`, { method: 'GET' });
  return json.payload || json;
}

/**
 * Ajoute un cadeau récurrent à la subscription
 * en se basant sur subscription_free_gift_variant_id (line item property remontée)
 */
async function addRecurringGiftFromProperty(subscription) {
  const subId = subscription.id;

  // SAFE RULE #1 : déjà initialisé ?
  const initialized = getNoteAttrValue(subscription, 'mymoodz_gift_initialized');
  if (initialized === '1') {
    console.log('[sealWebhook] Gift already initialized -> skip', subId);
    return { skipped: true, reason: 'already_initialized' };
  }

  // SAFE RULE #2 : si un client a déjà choisi un cadeau via ta page -> ne pas écraser
  const customGift = getNoteAttrValue(subscription, 'mymoodz_free_gift_code');
  if (customGift) {
    console.log('[sealWebhook] Customer already has gift choice -> skip init', {
      subId,
      customGift,
    });

    // on marque initialisé quand même pour éviter re-triggers
    const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_initialized', '1');
    await callSeal('/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: Number(subId),
        action: 'edit',
        edit: { note_attributes: newAttrs },
      }),
    });

    return { skipped: true, reason: 'customer_already_chosen_gift' };
  }

  // récupérer la variant id cadeau depuis property
  const giftVariantId =
    subscription?.items?.[0]?.properties?.find(
      (p) => p?.key === 'subscription_free_gift_variant_id'
    )?.value ||
    // OU parfois Seal renvoie properties comme array d'objets {key,value} sur item parent
    subscription?.items?.find((it) => it?.properties?.length)?.properties?.find(
      (p) => p?.key === 'subscription_free_gift_variant_id'
    )?.value ||
    null;

  if (!giftVariantId) {
    console.warn('[sealWebhook] No subscription_free_gift_variant_id found', subId);

    // on marque initialisé pour éviter boucle
    const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_initialized', '1');
    await callSeal('/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: Number(subId),
        action: 'edit',
        edit: { note_attributes: newAttrs },
      }),
    });

    return { skipped: true, reason: 'no_property' };
  }

  // SAFE RULE #3 : ne pas ajouter si déjà présent dans les items
  const alreadyInItems = (subscription.items || []).some(
    (it) => String(it.variant_id) === String(giftVariantId)
  );
  if (alreadyInItems) {
    console.log('[sealWebhook] Gift variant already present in subscription', {
      subId,
      giftVariantId,
    });

    const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_initialized', '1');
    await callSeal('/subscription', {
      method: 'PUT',
      body: JSON.stringify({
        id: Number(subId),
        action: 'edit',
        edit: { note_attributes: newAttrs },
      }),
    });

    return { skipped: true, reason: 'already_present' };
  }

  // On a besoin des infos produit pour add_items : à défaut on envoie "minimal safe"
  // (Seal accepte en général variant_id + quantity + one_time, mais on garde plus de champs)
  const giftItem = {
    product_id: '', // optionnel mais safe si tu le connais; on laisse vide si inconnu
    variant_id: String(giftVariantId),
    quantity: '1',
    title: 'Cadeau MyMOODz', // fallback
    sku: null,
    price: '0.00',
    taxable: 0,
    requires_shipping: 1,
    one_time: 0, // ✅ récurrent
    total_discount: 0,
    subsc_discount_percent: 0,
    properties: [],
  };

  console.log('[sealWebhook] Adding recurring gift to subscription', {
    subId,
    giftVariantId,
  });

  await callSeal('/subscription', {
    method: 'PUT',
    body: JSON.stringify({
      id: Number(subId),
      action: 'add_items',
      add_items: [giftItem],
    }),
  });

  // Marquer initialisé
  const newAttrs = setNoteAttr(subscription, 'mymoodz_gift_initialized', '1');
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

module.exports = {
  verifySealHmac,
  fetchSubscription,
  addRecurringGiftFromProperty,
};
