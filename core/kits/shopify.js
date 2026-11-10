// core/kits/shopify.js
// Client minimal de l'API Admin GraphQL de Shopify + vérification des webhooks.

const crypto = require('crypto');

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // ex. testshopilol.myshopify.com
const STATIC_TOKEN = process.env.SHOPIFY_KITS_ACCESS_TOKEN || '';
const CLIENT_ID = process.env.SHOPIFY_KITS_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_KITS_CLIENT_SECRET || '';
const VERSION = process.env.SHOPIFY_KITS_API_VERSION || '2025-10';
// Webhooks créés dans l'admin (Paramètres > Notifications) : signés avec le secret de la boutique.
// Webhooks créés par l'app du Dev Dashboard : signés avec le secret client de l'app.
const WEBHOOK_SECRETS = [process.env.SHOPIFY_WEBHOOK_SECRET, CLIENT_SECRET].filter(Boolean);

// Jeton d'accès : app du Dev Dashboard (identifiants client, jeton renouvelé automatiquement)
// ou, à défaut, jeton fixe d'une app personnalisée héritée.
let cached = { token: '', expiresAt: 0 };
let pending = null;

async function fetchClientCredentialsToken() {
  const res = await fetch(`https://${DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  });
  if (!res.ok) throw new Error(`Jeton Shopify refusé (HTTP ${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Jeton Shopify absent de la réponse');
  const ttl = Number(json.expires_in || 3600);
  cached = { token: json.access_token, expiresAt: Date.now() + Math.max(60, ttl - 300) * 1000 };
  return cached.token;
}

async function getToken(force = false) {
  if (CLIENT_ID && CLIENT_SECRET) {
    if (!force && cached.token && Date.now() < cached.expiresAt) return cached.token;
    if (!pending) pending = fetchClientCredentialsToken().finally(() => { pending = null; });
    return pending;
  }
  return STATIC_TOKEN;
}

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);
const legacyId = (g) => String(g || '').split('/').pop();

async function graphql(query, variables = {}, attempt = 1) {
  const token = DOMAIN ? await getToken() : '';
  if (!DOMAIN || !token) throw new Error('SHOPIFY_STORE_DOMAIN / accès Admin manquant');
  const res = await fetch(`https://${DOMAIN}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  // Jeton expiré ou révoqué : on en redemande un une fois
  if (res.status === 401 && CLIENT_ID && attempt === 1) {
    await getToken(true);
    return graphql(query, variables, attempt + 1);
  }
  // Limite de débit : on réessaie avec un délai croissant
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`Shopify HTTP ${res.status} après ${attempt} tentatives`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return graphql(query, variables, attempt + 1);
  }
  const json = await res.json();
  if (json.errors) {
    const throttled = json.errors.some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return graphql(query, variables, attempt + 1);
    }
    const err = new Error('Shopify GraphQL: ' + JSON.stringify(json.errors).slice(0, 500));
    err.shopify = json.errors;
    throw err;
  }
  return json.data;
}

/** Lève une erreur si une mutation renvoie des userErrors. */
function assertNoUserErrors(payload, label) {
  const errs = payload?.userErrors || [];
  if (errs.length) {
    const err = new Error(`${label}: ${errs.map((e) => e.message).join(' ; ')}`);
    err.userErrors = errs;
    throw err;
  }
  return payload;
}

/** Vérifie la signature d'un webhook Shopify (corps BRUT obligatoire). */
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRETS.length || !hmacHeader || !rawBody) return false;
  const b = Buffer.from(String(hmacHeader));
  return WEBHOOK_SECRETS.some((secret) => {
    const a = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('base64'));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/**
 * Abonne l'app au webhook « commande créée » (signé avec le secret client de l'app).
 * Idempotent : ne crée rien si l'abonnement existe déjà.
 */
async function ensureOrderWebhook(callbackUrl) {
  if (!CLIENT_ID || !CLIENT_SECRET) return { skipped: 'pas d\'app Dev Dashboard configurée' };
  const data = await graphql(`{ webhookSubscriptions(first: 50, topics: [ORDERS_CREATE]) {
    nodes { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  const exists = (data.webhookSubscriptions?.nodes || []).some((n) => n.endpoint?.callbackUrl === callbackUrl);
  if (exists) return { exists: true };
  const created = await graphql(
    `mutation Sub($url: URL!) {
      webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { callbackUrl: $url, format: JSON }) {
        webhookSubscription { id }
        userErrors { field message }
      }
    }`,
    { url: callbackUrl }
  );
  assertNoUserErrors(created.webhookSubscriptionCreate, 'webhookSubscriptionCreate');
  return { created: true };
}

const ORDER_QUERY = `
query KitOrder($id: ID!) {
  order(id: $id) {
    id
    name
    tags
    cancelledAt
    displayFulfillmentStatus
    lineItems(first: 100) {
      nodes {
        id
        quantity
        currentQuantity
        variant { id }
        customAttributes { key value }
      }
    }
    fulfillmentOrders(first: 20) {
      nodes {
        id
        status
        fulfillmentHolds { id handle reasonNotes }
        lineItems(first: 50) { nodes { id remainingQuantity lineItem { variant { id } } } }
      }
    }
  }
}`;

async function getOrder(orderId) {
  const data = await graphql(ORDER_QUERY, { id: gid('Order', orderId) });
  return data.order;
}

async function holdFulfillmentOrder(foId, notes) {
  const data = await graphql(
    `mutation Hold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
      fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
        fulfillmentHold { id handle }
        userErrors { field message }
      }
    }`,
    { id: foId, hold: { reason: 'OTHER', reasonNotes: notes, handle: 'mmz-kit', notifyMerchant: false } }
  );
  return assertNoUserErrors(data.fulfillmentOrderHold, 'fulfillmentOrderHold');
}

async function releaseFulfillmentOrderHold(foId, holdIds) {
  const data = await graphql(
    `mutation Release($id: ID!, $holdIds: [ID!]) {
      fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
        fulfillmentOrder { id status }
        userErrors { field message }
      }
    }`,
    { id: foId, holdIds }
  );
  return assertNoUserErrors(data.fulfillmentOrderReleaseHold, 'fulfillmentOrderReleaseHold');
}

/** Ajoute des variantes à une commande existante (édition de commande), sans prévenir le client. */
async function addVariantsToOrder(orderId, additions, staffNote) {
  const begin = await graphql(
    `mutation Begin($id: ID!) {
      orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } }
    }`,
    { id: gid('Order', orderId) }
  );
  assertNoUserErrors(begin.orderEditBegin, 'orderEditBegin');
  const calcId = begin.orderEditBegin.calculatedOrder.id;

  for (const { variantId, quantity } of additions) {
    const add = await graphql(
      `mutation Add($id: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
          calculatedLineItem { id }
          userErrors { field message }
        }
      }`,
      { id: calcId, variantId: gid('ProductVariant', variantId), quantity }
    );
    assertNoUserErrors(add.orderEditAddVariant, 'orderEditAddVariant');
  }

  const commit = await graphql(
    `mutation Commit($id: ID!, $note: String) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: $note) {
        order { id }
        userErrors { field message }
      }
    }`,
    { id: calcId, note: staffNote }
  );
  return assertNoUserErrors(commit.orderEditCommit, 'orderEditCommit');
}

/** Marque une demande d'expédition comme traitée (sans suivi, sans e-mail au client). */
async function fulfillWithoutShipping(foId, message) {
  const data = await graphql(
    `mutation Close($f: FulfillmentInput!, $m: String) {
      fulfillmentCreate(fulfillment: $f, message: $m) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: foId }] }, m: message }
  );
  return assertNoUserErrors(data.fulfillmentCreate, 'fulfillmentCreate');
}

async function addTags(orderId, tags) {
  const data = await graphql(
    `mutation Tags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }`,
    { id: gid('Order', orderId), tags }
  );
  return assertNoUserErrors(data.tagsAdd, 'tagsAdd');
}

module.exports = {
  graphql, getToken, gid, legacyId, verifyShopifyWebhook, ensureOrderWebhook,
  getOrder, holdFulfillmentOrder, releaseFulfillmentOrderHold, addVariantsToOrder, addTags, fulfillWithoutShipping,
};
