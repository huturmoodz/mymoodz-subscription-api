// core/kits/shopify.js
// Client minimal de l'API Admin GraphQL de Shopify + vérification des webhooks.

const crypto = require('crypto');

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // ex. testshopilol.myshopify.com
const TOKEN = process.env.SHOPIFY_KITS_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const VERSION = process.env.SHOPIFY_KITS_API_VERSION || '2025-10';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);
const legacyId = (g) => String(g || '').split('/').pop();

async function graphql(query, variables = {}, attempt = 1) {
  if (!DOMAIN || !TOKEN) throw new Error('SHOPIFY_STORE_DOMAIN / jeton Admin manquant');
  const res = await fetch(`https://${DOMAIN}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
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
  if (!WEBHOOK_SECRET || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
        fulfillmentHolds { id handle }
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
  graphql, gid, legacyId, verifyShopifyWebhook,
  getOrder, holdFulfillmentOrder, releaseFulfillmentOrderHold, addVariantsToOrder, addTags,
};
