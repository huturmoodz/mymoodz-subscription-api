// core/kits/seal.js
// Appels à l'API marchand de Seal Subscriptions utilisés par les kits.

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

async function callSeal(path, options = {}, attempt = 1) {
  if (!SEAL_API_TOKEN) throw new Error('SEAL_API_TOKEN manquant');
  const res = await fetch(`${SEAL_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Seal-Token': SEAL_API_TOKEN, ...(options.headers || {}) },
  });
  // Seal autorise 10 requêtes simultanées ; au-delà : 503 → on réessaie
  if ((res.status === 503 || res.status === 429) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 800 * attempt));
    return callSeal(path, options, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    const err = new Error((json && (json.message || json.error)) || `Seal error on ${path}`);
    err.seal = { status: res.status, body: json };
    throw err;
  }
  return json;
}

async function getSubscription(id) {
  const json = await callSeal(`/subscription?id=${Number(id)}`, { method: 'GET' });
  return json.payload || json;
}

async function findSubscriptionsByEmail(email) {
  const json = await callSeal(
    `/subscriptions?query=${encodeURIComponent(email)}&with-items=true&active-only=true`,
    { method: 'GET' }
  );
  if (json.payload && Array.isArray(json.payload.subscriptions)) return json.payload.subscriptions;
  if (Array.isArray(json.payload)) return json.payload;
  if (Array.isArray(json.subscriptions)) return json.subscriptions;
  return [];
}

const put = (body) => callSeal('/subscription', { method: 'PUT', body: JSON.stringify(body) });

const addItems = (id, items) => put({ id: Number(id), action: 'add_items', add_items: items });
const removeItems = (id, itemIds) => put({ id: Number(id), action: 'remove_items', remove_items: itemIds.map(Number) });
const editItems = (id, items) => put({ id: Number(id), action: 'edit_items', edit_items: items });

/** Fusionne des note_attributes sans écraser celles des autres fonctions (cadeau, etc.). */
async function upsertNotes(id, upserts) {
  const sub = await getSubscription(id);
  const map = new Map((sub.note_attributes || []).map((a) => [String(a.name), String(a.value ?? '')]));
  for (const { name, value } of upserts) map.set(String(name), String(value));
  const note_attributes = [...map.entries()].map(([name, value]) => ({ name, value }));
  return put({ id: Number(id), action: 'edit', edit: { note_attributes } });
}

/**
 * Abonne le serveur au webhook Seal « abonnement modifié » (changement de durée dans l'espace client…).
 * Idempotent. Seal ne permet de gérer ses webhooks que par l'API, pas dans son interface.
 */
async function ensureSealWebhook(topic, address) {
  let list = null;
  for (const path of ['/webhooks', '/webhook']) {
    try {
      list = await callSeal(path, { method: 'GET' });
      if (JSON.stringify(list).includes(address)) return { exists: true };
      try {
        await callSeal(path, { method: 'POST', body: JSON.stringify({ topic, address }) });
        return { created: true };
      } catch (e) {
        if (e.seal?.status !== 404) throw e;
      }
    } catch (e) {
      if (e.seal?.status !== 404) throw e;
    }
  }
  throw new Error('API webhooks Seal introuvable');
}

const getNote = (sub, name) => {
  const f = (sub?.note_attributes || []).find((a) => a?.name === name);
  return f ? String(f.value ?? '') : '';
};

const getItemProp = (item, key) => {
  const props = item?.properties;
  if (Array.isArray(props)) {
    const f = props.find((p) => p?.key === key || p?.name === key);
    return f ? String(f.value ?? '') : '';
  }
  if (props && typeof props === 'object') return props[key] != null ? String(props[key]) : '';
  return '';
};

module.exports = {
  ensureSealWebhook, callSeal, getSubscription, findSubscriptionsByEmail, addItems, removeItems, editItems, upsertNotes, getNote, getItemProp };
