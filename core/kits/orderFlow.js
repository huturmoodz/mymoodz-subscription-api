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
// Commande de test (attribut de panier _mmz_test=1) : tout le circuit est exécuté, mais la commande
// garde une attente « mmz-test » que le serveur ne lève jamais : MyLink ne la voit pas.
const TEST_HANDLE = 'mmz-test';
const isTestOrder = (order) => (order.customAttributes || []).some((a) => a.key === '_mmz_test' && String(a.value) === '1');
const variantOf = (line) => shopify.legacyId(line.variant?.id);
const qtyOf = (line) => Number(line.currentQuantity ?? line.quantity ?? 0);

/**
 * Calcule les boîtes attendues pour la commande.
 * Une commande est « concernée » si elle contient :
 *  - une ligne Recharge composée (propriété _moodz_compose posée par le composeur), ou
 *  - une ligne Recharge ET des boîtes (renouvellement Seal : les boîtes viennent du contrat), ou
 *  - des boîtes SANS ligne Recharge (anomalie : boîtes gratuites seules → bloquée).
 * Une Recharge ZÉRO Saveurs sans composition ni boîtes (achat hors composeur) est bloquée : elle ne
 * dirait pas quelles saveurs envoyer. L'ancien ZÉRO (pods-zero) n'est pas une « Recharge » ici : jamais touché.
 * @returns {{relevant:boolean, expected?:Map, target?:number, composed?:boolean, problems:string[]}}
 */
function computeExpected(order) {
  const lines = order.lineItems?.nodes || [];
  const parents = lines.filter((l) => isParentVariant(variantOf(l)) && qtyOf(l) > 0);
  const composed = parents.filter((l) => attr(l, config.props.compose));
  const boxLines = lines.filter((l) => isBoxVariant(variantOf(l)) && qtyOf(l) > 0);
  // Ligne Recharge retirée après coup (annulation d'article acceptée, édition) : quantité d'origine > quantité actuelle
  const reduced = lines.some((l) => isParentVariant(variantOf(l)) && Number(l.quantity || 0) > qtyOf(l));

  if (!parents.length) {
    // La Recharge a été annulée/retirée : ses boîtes doivent partir avec elle
    if (boxLines.length && reduced) return { relevant: true, expected: new Map(), target: 0, composed: true, reduced, problems: [] };
    if (boxLines.length) return { relevant: true, expected: new Map(), target: 0, composed: false, problems: ['boites_sans_recharge'] };
    return { relevant: false, problems: [] };
  }
  if (!composed.length && !boxLines.length) {
    return { relevant: true, expected: new Map(), target: 0, composed: false, problems: ['recharge_sans_saveurs'] };
  }

  const problems = [];
  const expected = new Map();
  const target = parents.reduce((s, l) => s + monthsOf(variantOf(l)) * config.boxesPerMonth * qtyOf(l), 0);
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
    const lineTarget = monthsOf(variantOf(line)) * config.boxesPerMonth;
    const perUnit = reference ? rescale(reference.map, lineTarget) : new Map([[config.defaultBoxVariantId, lineTarget]]);
    for (const [id, q] of perUnit) expected.set(id, (expected.get(id) || 0) + q * qtyOf(line));
  }

  return { relevant: true, expected, target, composed: composed.length > 0, reduced, problems };
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

/**
 * Décide quoi faire des boîtes déjà présentes.
 *  - total exact : la commande est complète. C'est le cas d'un renouvellement Seal (les boîtes viennent
 *    du contrat, éventuellement modifiées par le client dans « Mes saveurs ») ou d'une commande déjà traitée.
 *    On ne compare PAS la répartition à la propriété de la ligne Recharge, qui peut dater du premier achat.
 *  - aucune boîte, ou seulement une partie de celles attendues : on ajoute ce qui manque.
 *  - plus de boîtes que prévu, ou un mélange incohérent : on bloque et on signale.
 */
function plan(order, ctx) {
  const current = currentBoxes(order);
  const have = totalOf(current);
  if (have === ctx.target) return { add: new Map() };
  if (have > ctx.target) {
    // Recharge réduite ou annulée après coup : on retire les boîtes en trop (celles de la recharge retirée)
    if (ctx.reduced && ctx.composed) {
      const { add, remove } = diff(ctx.expected, current);
      if (!add.size && have - totalOf(remove) === ctx.target) return { add: new Map(), remove };
    }
    return { problem: `surplus_de_boites (${have} pour ${ctx.target})` };
  }
  if (!ctx.composed) return { problem: `renouvellement_incomplet (${have} pour ${ctx.target})` };
  const { add, remove } = diff(ctx.expected, current);
  if (remove.size || have + totalOf(add) !== ctx.target) {
    return { problem: `boites_incoherentes (présentes : ${describe(current)})` };
  }
  return { add };
}

async function block(order, orderId, reason) {
  await holdAll(order, `MMZ-KIT bloquée : ${reason}`);
  if (!(order.tags || []).includes(config.tags.error)) await shopify.addTags(orderId, [config.tags.error]);
  console.error('[kits/order] commande bloquée', order.name, reason);
  return { error: true, order: order.name, reason };
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

    const ctx = computeExpected(order);
    if (!ctx.relevant) {
      // Filet : si la règle Flow a mis une attente sur une commande sans kit, on la lève.
      const flowHeld = (order.fulfillmentOrders?.nodes || []).some((fo) => (fo.fulfillmentHolds || []).some(isOurHold));
      if (flowHeld) await releaseAll(orderId);
      return { skipped: true, reason: 'pas_de_kit', released: flowHeld };
    }

    // Composition invalide, trafiquée, ou boîtes sans recharge : la commande reste bloquée,
    // le tag mmz-kit-erreur déclenche l'alerte e-mail de Flow.
    if (ctx.problems.length) return block(order, orderId, ctx.problems.join(' ; '));

    const decision = plan(order, ctx);
    if (decision.problem) return block(order, orderId, decision.problem);

    if (decision.remove && decision.remove.size) {
      const reductions = [...decision.remove.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
      try {
        await shopify.removeVariantsFromOrder(orderId, reductions, `Recharge annulée : boîtes retirées automatiquement (${describe(decision.remove)})`);
      } catch (e) {
        // Déjà expédiées ? On bloque ce qui reste et on alerte.
        return block(order, orderId, `retrait_des_boites_impossible : ${e.message}`);
      }
      if (!(order.tags || []).includes('mmz-kit-annule')) await shopify.addTags(orderId, ['mmz-kit-annule']);
      if (ctx.target === 0) {
        console.log('[kits/order] recharge annulée, boîtes retirées', order.name, describe(decision.remove));
        return { done: true, cancelled: true, order: order.name, removed: describe(decision.remove) };
      }
    }

    if (decision.add.size) {
      // Verrou MyLink avant de modifier la commande (Flow l'a normalement déjà posé)
      await holdAll(order, 'MMZ-KIT ajout des boîtes de saveur en cours');
      const additions = [...decision.add.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
      await shopify.addVariantsToOrder(
        orderId,
        additions,
        `Boîtes ajoutées automatiquement (${source}) : ${describe(decision.add)}`
      );
    }

    const test = isTestOrder(order);
    if (test) {
      // L'attente de test est posée AVANT de lever les nôtres : la commande n'est jamais libre.
      for (const fo of openFOs(order)) {
        if (!(fo.fulfillmentHolds || []).some((h) => h.handle === TEST_HANDLE)) {
          await shopify.holdFulfillmentOrder(fo.id, 'MMZ-TEST commande de test : ne pas expédier', TEST_HANDLE);
        }
      }
    }

    // Commande complète : on libère MyLink, on clôt la ligne Recharge, on marque la commande
    const fresh = await releaseAll(orderId);
    await closeParentOnlyFOs(fresh);
    const tags = order.tags || [];
    if (!tags.includes(config.tags.ok)) await shopify.addTags(orderId, [config.tags.ok]);
    if (tags.includes(config.tags.error)) await shopify.removeTags(orderId, [config.tags.error]);
    if (test && !tags.includes('mmz-test')) await shopify.addTags(orderId, ['mmz-test']);

    const result = { done: true, test, order: order.name, added: describe(decision.add) || 'rien (déjà complète)', total: ctx.target };
    console.log('[kits/order]', result);
    return result;
  });
}

module.exports = { processOrder, computeExpected, currentBoxes };
