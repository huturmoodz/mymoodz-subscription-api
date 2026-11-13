// core/kits/formula.js
// « Changer de formule » depuis la page Mes saveurs : l'abonné passe de 1 à 2 ou 3 mois (ou l'inverse).
// Trois choses changent dans le contrat Seal :
//   1. la fréquence de livraison et de facturation (tous les 1, 2 ou 3 mois) ;
//   2. la ligne Recharge (variante de durée + prix d'abonnement de la formule) ;
//   3. les boîtes saveur à 0 € (4, 8 ou 12), en gardant les proportions du mélange actuel.
// Si une étape échoue, la fréquence est remise comme avant : on ne laisse jamais un abonnement
// facturé au mauvais rythme.

const { config, isParentVariant, isBoxVariant, monthsOf } = require('./config');
const { rescale, stringifyComposition, describe } = require('./composition');
const seal = require('./seal');
const { analyse, storedPerUnit, applyToSubscription } = require('./subscriptionKit');

class FormulaError extends Error {}

const priceOf = (variantId) => Number((config.formulaPrices || {})[String(variantId)] || 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** Les formules proposées à l'abonné, de la plus courte à la plus longue, avec prix par jour et économie. */
function formulaOptions(currentVariantId) {
  const list = Object.keys(config.parents)
    .map((variantId) => ({
      variantId,
      months: monthsOf(variantId),
      boxes: monthsOf(variantId) * config.boxesPerMonth,
      price: priceOf(variantId),
    }))
    .filter((f) => f.months > 0 && f.price > 0)
    .sort((a, b) => a.months - b.months);
  const base = list.find((f) => f.months === 1);
  const basePerDay = base ? base.price / 30 : null;
  return list.map((f) => {
    const perDay = f.price / (30 * f.months);
    return {
      ...f,
      perDay: round2(perDay),
      savingPct: basePerDay && f.months > 1 ? Math.round((1 - perDay / basePerDay) * 100) : 0,
      current: f.variantId === String(currentVariantId),
    };
  });
}

/** Garde l'unité que Seal utilise déjà sur l'abonnement (« 1 month », « 2 months »…). */
function intervalFor(existing, months) {
  const m = String(existing || '').trim().match(/^(\d+)\s*([a-zA-Z]+)$/);
  if (m && /^month/i.test(m[2])) return `${months} ${m[2]}`;
  return `${months} month`;
}

function propsOf(item) {
  const raw = item.properties;
  return Array.isArray(raw)
    ? raw.map((p) => ({ key: p.key ?? p.name, value: String(p.value ?? '') }))
    : Object.entries(raw || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function setProp(list, key, value) {
  const f = list.find((p) => p.key === key);
  if (f) f.value = value; else list.push({ key, value });
}

const hasParent = (sub, variantId) => analyse(sub).parents.some((p) => String(p.variant_id) === String(variantId));

/**
 * Change la formule d'un abonnement Seal (déjà relu et vérifié comme appartenant au client).
 * À appeler sous le verrou de l'abonnement.
 */
async function changeFormula(sub, newVariantId) {
  const target = String(newVariantId);
  if (!isParentVariant(target) || !priceOf(target)) throw new FormulaError('Cette formule n’est pas disponible.');

  const { parents } = analyse(sub);
  if (!parents.length) throw new FormulaError('Cet abonnement ne contient pas de recharge à composer.');
  if (parents.length > 1) throw new FormulaError('Cet abonnement contient plusieurs recharges : contacte-nous pour changer de formule.');
  const parent = parents[0];
  const from = String(parent.variant_id);
  if (from === target) return { unchanged: true };
  // Le rythme est celui de tout l'abonnement dans Seal : s'il contient d'autres produits (RITUEL,
  // ancienne gamme…), changer la formule changerait aussi leur rythme. On ne le fait pas en libre-service.
  const otherProducts = (sub.items || []).filter((it) => it !== parent && Number(it.quantity || 0) > 0
    && !isParentVariant(it.variant_id) && !isBoxVariant(it.variant_id));
  if (otherProducts.length) throw new FormulaError('Cet abonnement contient aussi d’autres produits : contacte-nous pour changer sa formule.');

  const oldMonths = monthsOf(from);
  const newMonths = monthsOf(target);
  const price = priceOf(target).toFixed(2);
  const label = (config.parents[target] || {}).label;
  const sku = (config.parents[target] || {}).sku;

  // Le mélange actuel, ramené au nouveau nombre de boîtes (calculé avant de toucher à quoi que ce soit).
  const perUnitOld = storedPerUnit(sub, parent);
  const perUnitNew = perUnitOld ? rescale(perUnitOld, newMonths * config.boxesPerMonth) : null;

  const props = propsOf(parent);
  if (perUnitNew) {
    setProp(props, config.props.compose, stringifyComposition(perUnitNew));
    setProp(props, config.props.flavorsLabel || 'Saveurs', describe(perUnitNew));
  }

  const delivery = sub.delivery_interval;
  const billing = sub.billing_interval || sub.delivery_interval;

  // 1. Fréquence
  await seal.editSubscription(sub.id, {
    delivery_interval: intervalFor(delivery, newMonths),
    billing_interval: intervalFor(billing, newMonths),
  });

  let swapped = false;
  try {
    // 2. Ligne Recharge : on tente de changer la variante sur place…
    try {
      await seal.editItems(sub.id, [{
        id: Number(parent.id), variant_id: target, quantity: String(parent.quantity), price, sku, title: label, properties: props,
      }]);
    } catch (e) {
      console.warn('[kits/formula] édition de la ligne refusée, passage par ajout + retrait', sub.id, e.message);
    }
    let fresh = await seal.getSubscription(sub.id);

    // … et si Seal ne l'a pas pris en compte : on ajoute la nouvelle ligne, puis on retire l'ancienne.
    if (!hasParent(fresh, target)) {
      await seal.addItems(sub.id, [{
        product_id: String(config.parentProductId),
        variant_id: target,
        quantity: String(parent.quantity),
        title: label,
        sku,
        price,
        taxable: parent.taxable ?? 1,
        requires_shipping: parent.requires_shipping ?? 1,
        one_time: 0,
        properties: props,
      }]);
      fresh = await seal.getSubscription(sub.id);
      if (!hasParent(fresh, target)) throw new Error('nouvelle ligne Recharge absente après ajout');
      const old = analyse(fresh).parents.filter((p) => String(p.variant_id) === from).map((p) => p.id);
      if (old.length) await seal.removeItems(sub.id, old);
      fresh = await seal.getSubscription(sub.id);
    }

    swapped = true;

    // 3. Boîtes saveur : 4, 8 ou 12, même mélange.
    const newParent = analyse(fresh).parents[0];
    const perUnit = perUnitNew || storedPerUnit(fresh, newParent);
    if (perUnit) await applyToSubscription(fresh, perUnit);

    return { changed: true, fromMonths: oldMonths, toMonths: newMonths };
  } catch (e) {
    // La formule est déjà changée : seules les boîtes restent à aligner, et le webhook Seal
    // « abonnement modifié » s'en charge (même calcul). On garde donc la nouvelle fréquence.
    if (swapped) {
      console.error('[kits/formula] boîtes non alignées tout de suite, le webhook prendra le relais', sub.id, e.message);
      return { changed: true, fromMonths: oldMonths, toMonths: newMonths, boxesPending: true };
    }
    // Sinon : remise de la fréquence d'origine, jamais un abonnement facturé au mauvais rythme.
    try {
      await seal.editSubscription(sub.id, {
        delivery_interval: intervalFor(delivery, oldMonths),
        billing_interval: intervalFor(billing, oldMonths),
      });
    } catch (e2) {
      console.error('[kits/formula] ⚠ fréquence non rétablie, à corriger à la main', sub.id, e2.message);
    }
    throw e;
  }
}

module.exports = { changeFormula, formulaOptions, intervalFor, FormulaError };
