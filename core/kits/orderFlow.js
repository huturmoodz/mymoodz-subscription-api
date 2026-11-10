// core/kits/orderFlow.js
// BRIQUE A — « Commandes » : une commande arrive avec une ligne Recharge (durée) qui porte
// la composition des saveurs. Le serveur :
//   1. met la commande en attente d'expédition (MyLink ne la prend pas),
//   2. vérifie la composition (le navigateur n'est jamais cru sur parole),
//   3. ajoute les boîtes saveur à 0 € à la commande (vrais SKU, stock décompté),
//   4. lève l'attente et pose le tag mmz-kit-ok,
//   5. clôt la ligne Recharge (elle n'est pas un colis : seules les boîtes partent chez MyLink).
// La mise en attente est d'abord posée par Shopify Flow à la création de la commande (instantané,
// même si ce serveur gratuit est en veille) ; le serveur la reconnaît par la note « MMZ-KIT ».
// Le traitement est idempotent : il recalcule toujours « ce qui devrait être » et n'ajoute
// que ce qui manque. Il peut donc être rejoué sans risque (webhook reçu deux fois, reprise
// après une panne, upsell post-achat ajouté plus tard…).

const { config, isParentVariant, isBoxVariant, monthsOf, kitsLive } = require('./config');
const { parseComposition, validateComposition, rescale, diff, describe, totalOf } = require('./composition');
const shopify = require('./shopify');
const { withLock } = require('./lock');

const HOLD_HANDLE = 'mmz-kit';
const FLOW_MARK = 'MMZ-KIT';
// Une attente « à nous » : posée par ce serveur (handle) ou par la règle Flow (note MMZ-KIT).
// Les attentes posées par d'autres (fraude, équipe…) ne sont jamais levées ici.
const isOurHold = (h) => h.handle === HOLD_HANDLE || String(h.reasonNotes || '').includes(FLOW_MARK);
const attr = (line, key) => (line.customAttributes || []).find((a) => a.key === key)?.value || '';
const variantOf = (line) => shopify.legacyId(line.variant?.id);
const qtyOf = (line) => Number(line.currentQuantity ?? line.quantity ?? 0);

/**
 * Calcule les boîtes attendues pour la commande.
 * @returns {{relevant:boolean, expected?:Map, problems:string[]}}
 */
function computeExpected(order) {
  const lines = order.lineItems?.nodes || [];
  const parents = lines.filter((l) => isParentVariant(variantOf(l)) && qtyOf(l) > 0);
  const composed = parents.filter((l) => attr(l, config.props.compose));
  // Pas de ligne composée = ancienne gamme ou commande sans kit : on ne touche à rien.
  if (!composed.length) return { relevant: false, problems: [] };

  const problems = [];
  const expected = new Map();
  // Composition de référence (par mois) pour les lignes parent arrivées sans composition (upsell post-achat).
  let reference = null;

  for (const line of composed) {
    const v = variantOf(line);
    const perUnitTarget = monthsOf(v) * config.boxesPerMonth;
    const check = validateComposition(parseComposition(attr(line, config.props.compose)), perUnitTarget);
    if (!check.ok) {
      problems.push(`${line.id}: ${check.reason}`);
      continue;
    }
    if (!reference) reference = { map: check.map, total: perUnitTarget };
    for (const [id, q] of check.map) expected.set(id, (expected.get(id) || 0) + q * qtyOf(line));
  }

  for (const line of parents.filter((l) => !attr(l, config.props.compose))) {
    const target = monthsOf(variantOf(line)) * config.boxesPerMonth;
    const perUnit = reference ? rescale(reference.map, target) : new Map([[config.defaultBoxVariantId, target]]);
    for (const [id, q] of perUnit) expected.set(id, (expected.get(id) || 0) + q * qtyOf(line));
  }

  return { relevant: true, expected, problems };
}

function currentBoxes(order) {
  const map = new Map();
  for (const l of order.lineItems?.nodes || []) {
    const v = variantOf(l);
    if (isBoxVariant(v) && qtyOf(l) > 0) map.set(v, (map.get(v) || 0) + qtyOf(l));
  }
  return map;
}

const openFOs = (order) =>
  (order.fulfillmentOrders?.nodes || []).filter((fo) => ['OPEN', 'SCHEDULED', 'ON_HOLD'].includes(fo.status));

async function holdAll(order, notes) {
  for (const fo of openFOs(order)) {
    const already = (fo.fulfillmentHolds || []).some(isOurHold);
    if (!already) await shopify.holdFulfillmentOrder(fo.id, notes);
  }
}

async function releaseAll(orderId) {
  const fresh = await shopify.getOrder(orderId);
  for (const fo of fresh.fulfillmentOrders?.nodes || []) {
    const ours = (fo.fulfillmentHolds || []).filter(isOurHold).map((h) => h.id);
    if (ours.length) await shopify.releaseFulfillmentOrderHold(fo.id, ours);
  }
  return fresh;
}

/** Clôt les demandes d'expédition qui ne contiennent QUE des lignes Recharge (emplacement hors MyLink). */
async function closeParentOnlyFOs(order) {
  for (const fo of order.fulfillmentOrders?.nodes || []) {
    if (!['OPEN', 'IN_PROGRESS'].includes(fo.status)) continue;
    const lines = (fo.lineItems?.nodes || []).filter((l) => Number(l.remainingQuantity) > 0);
    if (!lines.length) continue;
    const onlyParents = lines.every((l) => isParentVariant(shopify.legacyId(l.lineItem?.variant?.id)));
    if (onlyParents) await shopify.fulfillWithoutShipping(fo.id, 'Recharge composée : contenu expédié via les boîtes saveur');
  }
}

async function processOrder(orderId, source = 'webhook') {
  if (!kitsLive()) return { skipped: true, reason: 'kits_desactives' };

  return withLock(`order:${orderId}`, async () => {
    const order = await shopify.getOrder(orderId);
    if (!order) return { skipped: true, reason: 'commande_introuvable' };
    if (order.cancelledAt) return { skipped: true, reason: 'commande_annulee' };
    if (order.displayFulfillmentStatus === 'FULFILLED') {
      return { skipped: true, reason: 'deja_expediee' };
    }

    const { relevant, expected, problems } = computeExpected(order);
    if (!relevant) {
      // Filet : si la règle Flow a mis une attente sur une commande sans kit, on la lève.
      const flowHeld = (order.fulfillmentOrders?.nodes || []).some((fo) => (fo.fulfillmentHolds || []).some(isOurHold));
      if (flowHeld) await releaseAll(orderId);
      return { skipped: true, reason: 'pas_de_kit', released: flowHeld };
    }

    // 1. Verrou MyLink d'abord, quoi qu'il arrive ensuite
    await holdAll(order, 'MyMOODz : ajout des boîtes de saveur en cours');

    if (problems.length) {
      // Composition invalide ou trafiquée : la commande reste bloquée, le tag alerte l'équipe (Flow / admin)
      await shopify.addTags(orderId, [config.tags.error]);
      console.error('[kits/order] composition refusée', order.name, problems);
      return { error: true, order: order.name, problems };
    }

    const current = currentBoxes(order);
    const { add, remove } = diff(expected, current);

    if (remove.size) {
      // Plus de boîtes que prévu (modification manuelle ?) : on ne retire rien soi-même, on signale.
      await shopify.addTags(orderId, [config.tags.error]);
      console.error('[kits/order] trop de boîtes, vérification manuelle', order.name, describe(remove));
      return { error: true, order: order.name, reason: 'surplus_de_boites', surplus: describe(remove) };
    }

    if (add.size) {
      const additions = [...add.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
      await shopify.addVariantsToOrder(
        orderId,
        additions,
        `Boîtes ajoutées automatiquement (${source}) : ${describe(add)}`
      );
    }

    // 4. Commande complète : on libère MyLink, puis 5. on clôt la ligne Recharge
    const fresh = await releaseAll(orderId);
    await closeParentOnlyFOs(fresh);
    if (!(order.tags || []).includes(config.tags.ok)) await shopify.addTags(orderId, [config.tags.ok]);

    const result = { done: true, order: order.name, added: describe(add) || 'rien (déjà complète)', total: totalOf(expected) };
    console.log('[kits/order]', result);
    return result;
  });
}

module.exports = { processOrder, computeExpected, currentBoxes };
