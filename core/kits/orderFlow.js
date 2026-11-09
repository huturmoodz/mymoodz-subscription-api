// core/kits/orderFlow.js
// BRIQUE A — « Commandes » : une commande arrive avec une ligne Recharge (durée) qui porte
// la composition des saveurs. Le serveur :
//   1. met la commande en attente d'expédition (MyLink ne la prend pas),
//   2. vérifie la composition (le navigateur n'est jamais cru sur parole),
//   3. ajoute les boîtes saveur à 0 € à la commande (vrais SKU, stock décompté),
//   4. lève l'attente et pose le tag mmz-kit-ok.
// Le traitement est idempotent : il recalcule toujours « ce qui devrait être » et n'ajoute
// que ce qui manque. Il peut donc être rejoué sans risque (webhook reçu deux fois, reprise
// après une panne, upsell post-achat ajouté plus tard…).

const { config, isParentVariant, isBoxVariant, monthsOf, kitsLive } = require('./config');
const { parseComposition, validateComposition, rescale, diff, describe, totalOf } = require('./composition');
const shopify = require('./shopify');
const { withLock } = require('./lock');

const HOLD_HANDLE = 'mmz-kit';
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
    const already = (fo.fulfillmentHolds || []).some((h) => h.handle === HOLD_HANDLE);
    if (!already) await shopify.holdFulfillmentOrder(fo.id, notes);
  }
}

async function releaseAll(orderId) {
  const fresh = await shopify.getOrder(orderId);
  for (const fo of fresh.fulfillmentOrders?.nodes || []) {
    const ours = (fo.fulfillmentHolds || []).filter((h) => h.handle === HOLD_HANDLE).map((h) => h.id);
    if (ours.length) await shopify.releaseFulfillmentOrderHold(fo.id, ours);
  }
}

async function processOrder(orderId, source = 'webhook') {
  if (!kitsLive()) return { skipped: true, reason: 'kits_desactives' };

  return withLock(`order:${orderId}`, async () => {
    const order = await shopify.getOrder(orderId);
    if (!order) return { skipped: true, reason: 'commande_introuvable' };
    if (order.cancelledAt) return { skipped: true, reason: 'commande_annulee' };
    if (['FULFILLED', 'PARTIALLY_FULFILLED'].includes(order.displayFulfillmentStatus)) {
      return { skipped: true, reason: 'deja_expediee' };
    }

    const { relevant, expected, problems } = computeExpected(order);
    if (!relevant) return { skipped: true, reason: 'pas_de_kit' };

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

    // 4. Commande complète : on libère MyLink
    await releaseAll(orderId);
    if (!(order.tags || []).includes(config.tags.ok)) await shopify.addTags(orderId, [config.tags.ok]);

    const result = { done: true, order: order.name, added: describe(add) || 'rien (déjà complète)', total: totalOf(expected) };
    console.log('[kits/order]', result);
    return result;
  });
}

module.exports = { processOrder, computeExpected, currentBoxes };
