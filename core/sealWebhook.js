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
    console.warn('[sealWebhook] SEAL_WEBHOOK_SECRET manquant -> skip hmac verify');
    return true;
  }
  if (!receivedHmac) return false;

  const computed = crypto.createHmac('sha256', SEAL_WEBHOOK_SECRET).update(rawBodyBuffer).digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(computed));
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
  const giftItem = {
    variant_id: String(giftVariantId),
    quantity: '1',
    title: 'Cadeau MyMOODz',
    price: '0.00',
    taxable: 0,
    requires_shipping: 1,
    one_time: 0, // ✅ récurrent
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
