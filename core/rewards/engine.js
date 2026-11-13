// core/rewards/engine.js
// Cadeaux de fidélité des abonnés : quand l'abonné atteint N mois d'abonnement (Recharge ZÉRO
// Saveurs payée en abonnement), le produit offert du palier est ajouté à 0 € DANS le colis qui lui fait
// franchir ce cap, une seule fois par client.
// Les paliers se comptent en MOIS couverts, pas en colis : un colis « 3 mois » compte 3 mois. Ainsi
// la formule 3 mois atteint ses cadeaux plus vite (palier 3 mois dès son 1er colis), jamais plus lentement.
// Ancienneté du client, toutes gammes confondues (ZÉRO Saveurs et RITUEL) : chaque colis d'abonnement couvre
// une période (date du colis + durée de sa formule) ; on compte la durée couverte par au moins un abonnement.
// Deux abonnements en parallèle ne vont donc pas deux fois plus vite, et changer de rituel ne remet rien à zéro.
// L'ancienne gamme ne compte pas, sauf si REWARDS_ANCIENNE_GAMME=true.
//
// Où ça se branche : webhook « commande créée / modifiée », AVANT le traitement des kits.
// À ce moment, la commande est encore en attente (règle Flow « MMZ-KIT ») : MyLink ne l'a pas.
// Le traitement des kits ajoute ensuite les boîtes et lève l'attente, comme avant.
// Le cadeau n'est jamais une Boîte ZÉRO ni une Recharge (tiers.js les refuse), donc le
// contrôle des boîtes du traitement des kits n'est pas perturbé.
//
// Règles de sécurité :
//  - seulement si la commande est encore retenue par NOTRE attente (sinon MyLink a pu la prendre) ;
//    le cadeau est alors reporté au colis suivant (rattrapage) ;
//  - cadeau en rupture : reporté au colis suivant, jamais d'ajout d'un produit absent ;
//  - un palier activé après coup n'est pas offert en masse aux anciens abonnés : seulement si le
//    client a franchi le cap depuis moins de REWARDS_RATTRAPAGE_MOIS mois (3 par défaut) ;
//  - « déjà offert » = tag mmz-cadeau-<palier> sur une commande non annulée du client
//    (ou le produit offert déjà présent dans la commande) : rejouer un webhook n'offre jamais deux fois.
//
// Modes (variable REWARDS_MODE) : off (défaut, rien ne se passe), dry (journalise ce qui serait
// offert, ne touche à rien), test (comme live, mais UNIQUEMENT sur les commandes de test
// _mmz_test=1 : les vrais clients ne reçoivent rien), live (ajoute réellement le cadeau).

const shopify = require('../kits/shopify');
const { config, isParentVariant, isBoxVariant, monthsOf, rituelOf } = require('../kits/config');
const seal = require('../kits/seal');
const { withLock } = require('../kits/lock');
const { loadTiers, offrable } = require('./tiers');
const { componentSources } = require('../stock/bundles');

const mode = () => String(process.env.REWARDS_MODE || 'off').toLowerCase();
const rattrapage = () => {
  const n = parseInt(process.env.REWARDS_RATTRAPAGE_MOIS, 10);
  return Number.isInteger(n) && n >= 0 ? n : 3;
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

// Saveur de la boîte offerte : choisie par l'abonné (note Seal mmz_cadeau_<palier> = id de variante),
// sinon sa saveur préférée (la boîte la plus présente dans son colis), sinon le produit de la fiche.
const CHOICE_PREFIX = 'mmz_cadeau_';
const choiceNote = (handle) => CHOICE_PREFIX + handle;
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Quantité par saveur (libellé actuel) à partir de lignes { variant_id, quantite } ou de lignes de commande. */
function flavourCounts(lines) {
  const map = new Map();
  for (const l of lines || []) {
    const v = String(l.variant_id || shopify.legacyId(l.variant?.id) || '');
    if (!isBoxVariant(v)) continue;
    const label = config.boxes[v].label;
    map.set(label, (map.get(label) || 0) + Number(l.quantite ?? l.currentQuantity ?? l.quantity ?? 0));
  }
  return map;
}

/** Variante offerte pour ce palier. options = [{ id, saveur }]. */
function pickVariant(tier, { chosenId = null, counts = new Map() } = {}) {
  if (!tier.auChoix) return tier.produit;
  const chosen = tier.options.find((o) => o.id === String(chosenId || ''));
  if (chosen) return chosen;
  let best = null;
  let bestQty = 0;
  for (const [label, qty] of counts) {
    const o = tier.options.find((x) => norm(x.saveur) === norm(label));
    if (o && qty > bestQty) { best = o; bestQty = qty; }
  }
  return best || tier.produit;
}

const withOldRange = () => String(process.env.REWARDS_ANCIENNE_GAMME || '').toLowerCase() === 'true';

/** Mois couverts par UNE unité de la ligne si elle compte pour la fidélité (0 sinon). */
function monthsOfLine(l) {
  if (!l.sellingPlan || qtyOf(l) <= 0) return 0;
  const v = vid(l);
  if (isParentVariant(v)) return monthsOf(v);
  const r = rituelOf(v);
  if (r) return r.months;
  if (withOldRange() && !isBoxVariant(v)) {
    const m = String(l.variant?.title || '').match(/(\d+)\s*mois/i);
    return m ? Number(m[1]) : 1;
  }
  return 0;
}

/** Une livraison d'abonnement = commande non annulée avec une ligne d'abonnement qui compte pour la fidélité. */
function isSubscriptionDelivery(order) {
  if (!order || order.cancelledAt) return false;
  return (order.lineItems?.nodes || []).some((l) => monthsOfLine(l) > 0);
}

const isTest = (order) => (order.tags || []).includes('mmz-test')
  || (order.customAttributes || []).some((a) => a.key === '_mmz_test' && String(a.value) === '1');

/**
 * Mois couverts par un colis : la plus longue de ses lignes (durée × quantité). Deux produits dans le
 * même colis couvrent la même période ; une Recharge en quantité 2 couvre deux fois sa durée.
 */
function monthsOfOrder(order) {
  if (!isSubscriptionDelivery(order)) return 0;
  return Math.max(0, ...(order.lineItems?.nodes || []).map((l) => monthsOfLine(l) * qtyOf(l)));
}

const DAY = 86400000;
function plusMonths(ms, n) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes());
  const last = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 0)).getUTCDate();
  return first + (Math.min(day, last) - 1) * DAY;
}

/**
 * Ancienneté en mois : durée couverte par au moins un colis d'abonnement (union des périodes
 * [date du colis, date + durée de sa formule]). Les trous (pause, arrêt) ne comptent pas.
 */
function coveredMonths(orders) {
  const spans = orders.map((o) => {
    const start = new Date(o.createdAt).getTime();
    return [start, plusMonths(start, monthsOfOrder(o))];
  }).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of spans) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b]; }
    else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  // 30,44 jours par mois en moyenne ; la petite marge absorbe les mois courts (février)
  return Math.floor(total / DAY / 30.4375 + 0.1);
}

/** Colis d'abonnement du client avant « order » (non annulés ; les commandes de test seulement entre elles). */
function deliveriesBefore(history, order) {
  const t = new Date(order.createdAt).getTime();
  const withTests = isTest(order);
  return history.filter((o) => o.id !== order.id
    && isSubscriptionDelivery(o)
    && new Date(o.createdAt).getTime() < t
    && (withTests || !isTest(o)));
}

/** Mois d'ancienneté AVANT « order ». */
const monthsBefore = (history, order) => coveredMonths(deliveriesBefore(history, order));
/** Mois d'ancienneté APRÈS « order » (ce colis compris). */
const monthsAfter = (history, order) => coveredMonths([...deliveriesBefore(history, order), order]);

/** Pour le portail : mois couverts, nombre de colis, et mois couverts par le dernier colis (sa formule). */
function soFar(history, { withTests = false } = {}) {
  const subs = history.filter((o) => isSubscriptionDelivery(o) && (withTests || !isTest(o)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return {
    mois: coveredMonths(subs),
    colis: subs.length,
    moisParColis: subs.length ? monthsOfOrder(subs[subs.length - 1]) : 1,
    depuis: subs.length ? subs[0].createdAt : null,   // 1re commande d'abonnement
  };
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

/**
 * Paliers à offrir dans le colis qui fait passer le client de « before » à « after » mois.
 * Cap franchi par ce colis, ou franchi récemment sans cadeau (rattrapage, « late » mois).
 */
function decide({ tiers, before, after, granted, late = rattrapage() }) {
  return (tiers || []).filter((t) => offrable(t) && !granted.has(t.handle) && after >= t.mois && before < t.mois + late);
}

/** Vue « fidélité » du portail : où en est le client, ce qu'il a reçu, ce qui arrive. */
function status({ tiers, n, colis = 0, moisParColis = 1, depuis = null, granted }) {
  const visibles = (tiers || []).filter((t) => t.titre && Number.isInteger(t.mois));
  const paliers = visibles.map((t) => {
    let statut;
    if (granted.has(t.handle)) statut = 'offert';
    else if (!offrable(t)) statut = 'bientot';
    else if (t.mois > n) statut = 'a_venir';
    else if (n < t.mois + rattrapage()) statut = 'en_cours';   // cap franchi, cadeau en route ou reporté
    else statut = 'passe';
    const restants = Math.max(0, t.mois - n);
    return {
      handle: t.handle,
      mois: t.mois, titre: t.titre, message: t.message || '', statut,
      choix: t.auChoix ? t.options.map((o) => ({ id: o.id, saveur: o.saveur })) : [],
      mois_restants: restants,
      // le prochain colis (même formule) suffit-il à franchir le cap ?
      prochain_colis: statut === 'a_venir' && restants <= moisParColis,
    };
  }).filter((p) => p.statut !== 'passe');
  const prochain = paliers.find((p) => p.statut === 'a_venir' || p.statut === 'bientot') || null;
  return { mois: n, colis, mois_par_colis: moisParColis, depuis, paliers, prochain };
}

/* ------------------------- accès Shopify ------------------------- */

const ORDER_QUERY = `query CadeauCommande($id: ID!) {
  order(id: $id) {
    id name email createdAt cancelledAt tags displayFulfillmentStatus
    customAttributes { key value }
    customer { id }
    lineItems(first: 100) { nodes { id quantity currentQuantity variant { id title } sellingPlan { sellingPlanId } } }
    fulfillmentOrders(first: 20) { nodes { id status fulfillmentHolds { handle reasonNotes } } }
  }
}`;

const HISTORY_QUERY = `query CadeauHistorique($q: String!, $after: String) {
  orders(first: 100, query: $q, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id createdAt cancelledAt tags
      customAttributes { key value }
      lineItems(first: 30) { nodes { quantity currentQuantity variant { id title } sellingPlan { sellingPlanId } } }
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

/** Choix de saveur enregistrés par le client (notes de ses abonnements Seal). Erreur → aucun choix. */
async function sealChoices(email) {
  const out = {};
  if (!email) return out;
  try {
    for (const s of await seal.findSubscriptionsByEmail(email)) {
      const full = await seal.getSubscription(s.id);
      for (const a of full.note_attributes || []) {
        if (String(a.name).startsWith(CHOICE_PREFIX)) out[String(a.name).slice(CHOICE_PREFIX.length)] = String(a.value || '');
      }
    }
  } catch (e) {
    console.error('[paliers] choix de saveur illisibles, saveur préférée utilisée :', e.message);
  }
  return out;
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
      const before = monthsBefore(history, order);
      const after = monthsAfter(history, order);
      const granted = grantedHandles(history);
      const lines = order.lineItems?.nodes || [];
      const result = { order: order.name, mois_avant: before, mois_apres: after, offerts: [], reportes: [], mode: m };

      const todo = decide({ tiers, before, after, granted });
      const choices = todo.some((t) => t.auChoix) ? await sealChoices(order.email) : {};
      const counts = flavourCounts(lines);
      for (const t0 of todo) {
        const tier = { ...t0, produit: pickVariant(t0, { chosenId: choices[t0.handle], counts }) };
        const giftIds = t0.auChoix ? t0.options.map((o) => o.id) : [tier.produit.id];
        const already = lines.some((l) => giftIds.includes(vid(l)) && qtyOf(l) > 0);
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
  const f = soFar(history, { withTests: mode() === 'test' });
  return status({ tiers, n: f.mois, colis: f.colis, moisParColis: f.moisParColis, depuis: f.depuis, granted: grantedHandles(history) });
}

module.exports = {
  mode, applyToOrder, statusFor, loadTiers, choiceNote, pickVariant, flavourCounts,
  // calculs purs (tests)
  isSubscriptionDelivery, monthsOfOrder, monthsBefore, monthsAfter, coveredMonths, soFar, grantedHandles, decide, status, stillHeld, tagOf,
};
