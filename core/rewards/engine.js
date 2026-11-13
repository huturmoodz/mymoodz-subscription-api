// core/rewards/engine.js
// Cadeaux de fidélité des abonnés : à la N-ième livraison d'abonnement (Recharge ZÉRO Saveurs),
// le produit offert du palier est ajouté à 0 € DANS le colis, une seule fois par client.
//
// Où ça se branche : webhook « commande créée / modifiée », AVANT le traitement des kits.
// À ce moment, la commande est encore en attente (règle Flow « MMZ-KIT ») : MyLink ne l'a pas.
// Le traitement des kits ajoute ensuite les boîtes et lève l'attente, comme avant.
// Le cadeau n'est jamais une Boîte ZÉRO ni une Recharge (tiers.js les refuse), donc le
// contrôle des boîtes du traitement des kits n'est pas perturbé.
//
// Règles de sécurité :
//  - seulement si la commande est encore retenue par NOTRE attente (sinon MyLink a pu la prendre) ;
//    le cadeau est alors reporté à la livraison suivante (rattrapage) ;
//  - cadeau en rupture : reporté à la livraison suivante, jamais d'ajout d'un produit absent ;
//  - un palier activé après coup n'est pas offert en masse aux anciens abonnés : seulement à la
//    livraison prévue, ou à la suivante en rattrapage (REWARDS_RATTRAPAGE, 1 par défaut) ;
//  - « déjà offert » = tag mmz-cadeau-<palier> sur une commande non annulée du client
//    (ou le produit offert déjà présent dans la commande) : rejouer un webhook n'offre jamais deux fois.
//
// Modes (variable REWARDS_MODE) : off (défaut, rien ne se passe), dry (journalise ce qui serait
// offert, ne touche à rien), test (comme live, mais UNIQUEMENT sur les commandes de test
// _mmz_test=1 : les vrais clients ne reçoivent rien), live (ajoute réellement le cadeau).

const shopify = require('../kits/shopify');
const { isParentVariant } = require('../kits/config');
const { withLock } = require('../kits/lock');
const { loadTiers, offrable } = require('./tiers');
const { componentSources } = require('../stock/bundles');

const mode = () => String(process.env.REWARDS_MODE || 'off').toLowerCase();
const rattrapage = () => {
  const n = parseInt(process.env.REWARDS_RATTRAPAGE, 10);
  return Number.isInteger(n) && n >= 0 ? n : 1;
};
const TAG_PREFIX = 'mmz-cadeau-';
const tagOf = (handle) => TAG_PREFIX + handle;

const isOurHold = (h) => h.handle === 'mmz-kit' || String(h.reasonNotes || '').includes('MMZ-KIT');
const qtyOf = (l) => Number(l.currentQuantity ?? l.quantity ?? 0);
const vid = (l) => shopify.legacyId(l.variant?.id);
function ok(payload, label) {
  const errs = payload?.userErrors || [];
  if (errs.length) {
    const e = new Error(`${label} : ${errs.map((x) => x.message).join(' ; ')}`);
    e.userErrors = errs;
    throw e;
  }
  return payload;
}

/* ------------------------- calculs purs ------------------------- */

/** Une livraison d'abonnement = commande non annulée avec une ligne Recharge vendue par abonnement. */
function isSubscriptionDelivery(order) {
  if (!order || order.cancelledAt) return false;
  return (order.lineItems?.nodes || []).some((l) => isParentVariant(vid(l)) && l.sellingPlan && qtyOf(l) > 0);
}

const isTest = (order) => (order.tags || []).includes('mmz-test')
  || (order.customAttributes || []).some((a) => a.key === '_mmz_test' && String(a.value) === '1');

/** Numéro de livraison d'abonnement de « order » parmi l'historique du client (commande comprise). */
function deliveryNumber(history, order) {
  const t = new Date(order.createdAt).getTime();
  const withTests = isTest(order);
  const others = history.filter((o) => o.id !== order.id
    && isSubscriptionDelivery(o)
    && new Date(o.createdAt).getTime() <= t
    && (withTests || !isTest(o)));
  return others.length + (isSubscriptionDelivery(order) ? 1 : 0);
}

/** Livraisons d'abonnement déjà passées (pour le portail). */
function deliveriesSoFar(history, { withTests = false } = {}) {
  return history.filter((o) => isSubscriptionDelivery(o) && (withTests || !isTest(o))).length;
}

/** Paliers déjà offerts au client (tags posés sur ses commandes non annulées). */
function grantedHandles(history) {
  const set = new Set();
  for (const o of history) {
    if (o.cancelledAt) continue;
    for (const t of o.tags || []) if (t.startsWith(TAG_PREFIX)) set.add(t.slice(TAG_PREFIX.length));
  }
  return set;
}

/** Paliers à offrir dans la livraison n°n. */
function decide({ tiers, n, granted, late = rattrapage() }) {
  return (tiers || []).filter((t) => offrable(t) && !granted.has(t.handle) && n >= t.livraisons && n <= t.livraisons + late);
}

/** Vue « fidélité » du portail : où en est le client, ce qu'il a reçu, ce qui arrive. */
function status({ tiers, n, granted }) {
  const visibles = (tiers || []).filter((t) => t.titre && Number.isInteger(t.livraisons));
  const paliers = visibles.map((t) => {
    let statut;
    if (granted.has(t.handle)) statut = 'offert';
    else if (!offrable(t)) statut = 'bientot';
    else if (t.livraisons > n) statut = 'a_venir';
    else if (n <= t.livraisons + rattrapage()) statut = 'en_cours';   // reporté (rupture, attente levée…)
    else statut = 'passe';
    return {
      livraisons: t.livraisons, titre: t.titre, message: t.message || '', statut,
      restantes: Math.max(0, t.livraisons - n),
    };
  }).filter((p) => p.statut !== 'passe');
  const prochain = paliers.find((p) => p.statut === 'a_venir' || p.statut === 'bientot') || null;
  return { livraisons: n, paliers, prochain };
}

/* ------------------------- accès Shopify ------------------------- */

const ORDER_QUERY = `query CadeauCommande($id: ID!) {
  order(id: $id) {
    id name createdAt cancelledAt tags displayFulfillmentStatus
    customAttributes { key value }
    customer { id }
    lineItems(first: 100) { nodes { id quantity currentQuantity variant { id } sellingPlan { sellingPlanId } } }
    fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { handle reasonNotes } } }
  }
}`;

const HISTORY_QUERY = `query CadeauHistorique($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt cancelledAt tags
      customAttributes { key value }
      lineItems(first: 30) { nodes { quantity currentQuantity variant { id } sellingPlan { sellingPlanId } } }
    }
  }
}`;

async function customerHistory(customerId) {
  const out = [];
  let after = null;
  let pages = 0;
  do {
    const d = await shopify.graphql(HISTORY_QUERY, { q: `customer_id:${shopify.legacyId(customerId)}`, after });
    out.push(...(d.orders?.nodes || []));
    after = d.orders?.pageInfo?.hasNextPage ? d.orders.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < 5);
  return out;
}

/**
 * Le cadeau manque-t-il ? Variante cadeau suivie en stock : son propre stock.
 * Non suivie : stock du composant MyLink de même SKU (ex. BTE-ZERO-MEN-03 → lu sur POD-ZERO-MEN-03,
 * DIFF-RECH → lu sur le diffuseur). Stock introuvable : on n'empêche pas (MyLink signalera).
 */
async function enRupture(p, qty) {
  if (p.suivi) return p.refuseRupture && p.stock !== null && p.stock < qty;
  const src = componentSources()[p.sku] || p.sku;
  const d = await shopify.graphql(
    `query S($q: String!) { productVariants(first: 20, query: $q) { nodes { id sku inventoryQuantity inventoryItem { tracked } } } }`,
    { q: `sku:"${src}"` });
  const tracked = (d.productVariants?.nodes || []).filter((v) => v.sku === src && v.inventoryItem?.tracked && shopify.legacyId(v.id) !== p.id);
  if (!tracked.length) return false;
  return Math.max(...tracked.map((v) => Number(v.inventoryQuantity || 0))) < qty;
}

/** La commande est-elle encore retenue par notre attente (MyLink ne peut pas la prendre) ? */
function stillHeld(order) {
  const fos = order.fulfillmentOrders?.nodes || [];
  if (!fos.length || order.displayFulfillmentStatus === 'FULFILLED' || order.displayFulfillmentStatus === 'PARTIALLY_FULFILLED') return false;
  const live = fos.filter((fo) => !['CLOSED', 'CANCELLED', 'INCOMPLETE'].includes(fo.status));
  return live.length > 0 && live.every((fo) => fo.status === 'ON_HOLD' && (fo.fulfillmentHolds || []).some(isOurHold));
}

async function addTag(orderGid, tag) {
  const d = await shopify.graphql(
    `mutation T($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
    { id: orderGid, tags: [tag] });
  ok(d.tagsAdd, 'tagsAdd');
}

/**
 * Après l'ajout, Shopify peut ranger le cadeau dans une NOUVELLE demande d'expédition, non retenue :
 * MyLink pourrait l'envoyer seule. On la retient avec la même attente que les kits (« mmz-kit ») :
 * le traitement des kits, qui passe juste après, lève toutes ces attentes en même temps.
 */
async function reholdNewFOs(orderGid) {
  const d = await shopify.graphql(ORDER_QUERY, { id: orderGid });
  for (const fo of d.order?.fulfillmentOrders?.nodes || []) {
    if (fo.status !== 'OPEN' && fo.status !== 'SCHEDULED') continue;
    if ((fo.fulfillmentHolds || []).some(isOurHold)) continue;
    const h = await shopify.graphql(
      `mutation H($id: ID!, $hold: FulfillmentOrderHoldInput!) {
        fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) { fulfillmentHold { id } userErrors { field message } }
      }`, { id: fo.id, hold: { reason: 'OTHER', reasonNotes: 'MMZ-KIT cadeau fidélité ajouté', handle: 'mmz-kit', notifyMerchant: false } });
    ok(h.fulfillmentOrderHold, 'fulfillmentOrderHold');
  }
}

/** Ajoute le produit offert à la commande, prix ramené à 0 € si besoin, sans prévenir le client. */
async function addGift(orderGid, tier) {
  const begin = await shopify.graphql(
    `mutation B($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }`,
    { id: orderGid });
  ok(begin.orderEditBegin, 'orderEditBegin');
  const calcId = begin.orderEditBegin.calculatedOrder.id;

  const add = await shopify.graphql(
    `mutation A($id: ID!, $v: ID!, $q: Int!) {
      orderEditAddVariant(id: $id, variantId: $v, quantity: $q, allowDuplicates: true) {
        calculatedLineItem { id } userErrors { field message }
      }
    }`, { id: calcId, v: shopify.gid('ProductVariant', tier.produit.id), q: tier.quantite });
  ok(add.orderEditAddVariant, 'orderEditAddVariant');

  if (tier.produit.prix > 0) {
    const disc = await shopify.graphql(
      `mutation D($id: ID!, $li: ID!, $d: OrderEditAppliedDiscountInput!) {
        orderEditAddLineItemDiscount(id: $id, lineItemId: $li, discount: $d) { userErrors { field message } }
      }`, { id: calcId, li: add.orderEditAddVariant.calculatedLineItem.id, d: { percentValue: 100, description: 'Cadeau fidélité' } });
    ok(disc.orderEditAddLineItemDiscount, 'orderEditAddLineItemDiscount');
  }

  const commit = await shopify.graphql(
    `mutation C($id: ID!, $note: String) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: $note) { order { id } userErrors { field message } }
    }`, { id: calcId, note: `Cadeau fidélité ajouté automatiquement : ${tier.titre} (${tier.nom})` });
  ok(commit.orderEditCommit, 'orderEditCommit');
}

/* ------------------------- point d'entrée ------------------------- */

/**
 * Appelé pour chaque commande créée/modifiée, avant le traitement des kits. Ne lève jamais d'erreur
 * vers l'appelant : un souci de cadeau ne doit jamais bloquer une commande.
 */
async function applyToOrder(orderId, { force } = {}) {
  const m = force || mode();
  if (m === 'off') return { skipped: true, reason: 'cadeaux_desactives' };
  try {
    return await withLock(`order:${shopify.legacyId(orderId)}`, async () => {
      const d = await shopify.graphql(ORDER_QUERY, { id: shopify.gid('Order', orderId) });
      const order = d.order;
      if (!order) return { skipped: true, reason: 'commande_introuvable' };
      if (!isSubscriptionDelivery(order)) return { skipped: true, reason: 'pas_une_livraison_abonnement' };
      if (m === 'test' && !isTest(order)) return { skipped: true, reason: 'mode_test_vraie_commande' };
      if (!order.customer?.id) return { skipped: true, reason: 'sans_client' };

      const tiers = await loadTiers();
      if (!tiers) return { skipped: true, reason: 'paliers_illisibles' };

      const history = await customerHistory(order.customer.id);
      const n = deliveryNumber(history, order);
      const granted = grantedHandles(history);
      const lines = order.lineItems?.nodes || [];
      const result = { order: order.name, livraison: n, offerts: [], reportes: [], mode: m };

      for (const tier of decide({ tiers, n, granted })) {
        const already = lines.some((l) => vid(l) === tier.produit.id && qtyOf(l) > 0);
        if (already) {
          if (m === 'live' || m === 'test') await addTag(order.id, tagOf(tier.handle));
          result.offerts.push({ palier: tier.handle, deja_dans_la_commande: true });
          continue;
        }
        const p = tier.produit;
        if (await enRupture(p, tier.quantite)) {
          result.reportes.push({ palier: tier.handle, raison: 'rupture' });
          continue;
        }
        if (!stillHeld(order)) {
          result.reportes.push({ palier: tier.handle, raison: 'commande_deja_liberee' });
          continue;
        }
        if (m !== 'live' && m !== 'test') {
          result.offerts.push({ palier: tier.handle, simulation: true });
          continue;
        }
        await addGift(order.id, tier);
        await addTag(order.id, tagOf(tier.handle));
        await reholdNewFOs(order.id);
        result.offerts.push({ palier: tier.handle, produit: p.sku });
      }
      if (result.offerts.length || result.reportes.length) console.log('[paliers]', JSON.stringify(result));
      return result;
    });
  } catch (e) {
    console.error('[paliers] commande', orderId, e.message, e.userErrors || '');
    return { error: true, reason: e.message };
  }
}

/** Vue fidélité d'un client pour le portail. null si les paliers sont illisibles. */
async function statusFor(customerId) {
  const tiers = await loadTiers();
  if (!tiers) return null;
  const history = await customerHistory(customerId);
  // En mode test, les commandes de test comptent (pour qu'Hugo voie sa progression pendant ses essais)
  return status({ tiers, n: deliveriesSoFar(history, { withTests: mode() === 'test' }), granted: grantedHandles(history) });
}

module.exports = {
  mode, applyToOrder, statusFor,
  // calculs purs (tests)
  isSubscriptionDelivery, deliveryNumber, deliveriesSoFar, grantedHandles, decide, status, stillHeld, tagOf,
};
