// core/kits/rituel.js
// Abonnements RITUEL (Bonnes Nuits, Bien-Être, Idées Claires, Pleine Forme) : l'abonné change
// - de formule : 1, 2 ou 3 mois du même rituel (4, 8 ou 12 boîtes), mêmes prix que ZÉRO Saveurs ;
// - de rituel : un autre des 4 rituels, même formule, même prix, même date.
// Pas de boîtes à composer : chaque variante RITUEL est déjà le lot physique (SKU MyLink).
//
// Sécurité, comme pour la formule ZÉRO :
//  - la fréquence ne change que si le nombre de mois change, et elle est remise comme avant si
//    le remplacement de la ligne échoue (jamais un abonnement facturé au mauvais rythme) ;
//  - un abonnement qui contient d'autres produits ne change pas de rythme ici (la fréquence est
//    celle de tout l'abonnement dans Seal) : le client est invité à nous contacter.
//  - seule la relecture de Seal fait foi : la ligne cible doit y être, l'ancienne en être partie.

const { config, isBoxVariant, rituelOf, rituelVariant, priceForMonths } = require('./config');
const seal = require('./seal');
const { intervalFor, FormulaError } = require('./formula');

const qty = (it) => Number(it.quantity || 0);
const rituelLines = (sub) => (sub.items || []).filter((it) => rituelOf(it.variant_id) && qty(it) > 0);
const hasVariant = (sub, v) => rituelLines(sub).some((it) => String(it.variant_id) === String(v));

/** Autres produits récurrents de l'abonnement (hors la ligne RITUEL et les boîtes ZÉRO à 0 €). */
const others = (sub, line) => (sub.items || []).filter((it) => it !== line && qty(it) > 0 && !isBoxVariant(it.variant_id));

/** Les formules et rituels proposés à un abonné RITUEL (pour la page « Mes saveurs »). */
function rituelOptions(currentVariantId) {
  const cur = rituelOf(currentVariantId);
  if (!cur) return { formulas: [], rituels: [] };
  const base = priceForMonths(1);
  const basePerDay = base ? base / 30 : null;
  const formulas = [1, 2, 3].map((m) => {
    const variantId = rituelVariant(cur.code, m);
    const price = priceForMonths(m);
    const perDay = price / (30 * m);
    return {
      variantId, months: m, boxes: m * config.boxesPerMonth, price,
      perDay: Math.round(perDay * 100) / 100,
      savingPct: basePerDay && m > 1 ? Math.round((1 - perDay / basePerDay) * 100) : 0,
      current: String(variantId) === String(currentVariantId),
    };
  }).filter((f) => f.variantId && f.price > 0);
  const rituels = Object.entries(config.rituels || {}).map(([code, r]) => ({
    code, label: r.label, variantId: rituelVariant(code, cur.months), current: code === cur.code,
  })).filter((r) => r.variantId);
  return { formulas, rituels };
}

/**
 * Remplace la ligne RITUEL de l'abonnement par la variante « target » (autre durée et/ou autre rituel).
 * À appeler sous le verrou de l'abonnement, après le contrôle d'appartenance.
 */
async function swapRituel(sub, targetVariantId) {
  const target = String(targetVariantId || '');
  const to = rituelOf(target);
  if (!to) throw new FormulaError('Ce choix n’est pas disponible.');
  const price = priceForMonths(to.months);
  if (!price) throw new FormulaError('Ce choix n’est pas disponible.');

  const lines = rituelLines(sub);
  if (!lines.length) throw new FormulaError('Cet abonnement ne contient pas de recharge RITUEL.');
  if (lines.length > 1) throw new FormulaError('Cet abonnement contient plusieurs rituels : contacte-nous pour le modifier.');
  const line = lines[0];
  const from = rituelOf(line.variant_id);
  if (String(line.variant_id) === target) return { unchanged: true };

  const monthsChange = from.months !== to.months;
  if (monthsChange && others(sub, line).length) {
    throw new FormulaError('Cet abonnement contient aussi d’autres produits : contacte-nous pour changer sa formule.');
  }

  const delivery = sub.delivery_interval;
  const billing = sub.billing_interval || sub.delivery_interval;
  const title = `Recharge Rituel ${to.label}`;
  const priceStr = price.toFixed(2);

  if (monthsChange) {
    await seal.editSubscription(sub.id, {
      delivery_interval: intervalFor(delivery, to.months),
      billing_interval: intervalFor(billing, to.months),
    });
  }

  let added = false;
  try {
    // 1. Même produit (seule la durée change) : on tente de changer la variante sur place.
    if (from.code === to.code) {
      try {
        await seal.editItems(sub.id, [{ id: Number(line.id), variant_id: target, quantity: String(line.quantity), price: priceStr, sku: to.sku, title }]);
      } catch (e) {
        console.warn('[kits/rituel] édition sur place refusée, passage par ajout + retrait', sub.id, e.message);
      }
    }
    let fresh = await seal.getSubscription(sub.id);

    // 2. Sinon (autre rituel = autre produit, ou édition non prise) : ajout de la nouvelle ligne, puis retrait de l'ancienne.
    if (!hasVariant(fresh, target)) {
      await seal.addItems(sub.id, [{
        product_id: to.productId,
        variant_id: target,
        quantity: String(line.quantity || 1),
        title,
        sku: to.sku,
        price: priceStr,
        taxable: line.taxable ?? 1,
        requires_shipping: line.requires_shipping ?? 1,
        one_time: 0,
      }]);
      added = true;
      fresh = await seal.getSubscription(sub.id);
      if (!hasVariant(fresh, target)) throw new Error('nouvelle ligne RITUEL absente après ajout');
    }
    const old = rituelLines(fresh).filter((it) => String(it.variant_id) !== target).map((it) => it.id);
    if (old.length) {
      await seal.removeItems(sub.id, old);
      fresh = await seal.getSubscription(sub.id);
    }
    if (rituelLines(fresh).length !== 1 || !hasVariant(fresh, target)) throw new Error('abonnement RITUEL incohérent après remplacement');

    return { changed: true, from: { rituel: from.code, months: from.months }, to: { rituel: to.code, months: to.months } };
  } catch (e) {
    // Retour à l'état d'origine : si la nouvelle ligne a été ajoutée et que l'ancienne est encore là,
    // on retire la nouvelle (le client ne doit jamais se retrouver avec deux rituels facturés).
    if (added) {
      try {
        const now = await seal.getSubscription(sub.id);
        const stillOld = rituelLines(now).some((it) => String(it.variant_id) === String(line.variant_id));
        const extra = rituelLines(now).filter((it) => String(it.variant_id) === target).map((it) => it.id);
        if (stillOld && extra.length) await seal.removeItems(sub.id, extra);
      } catch (e3) {
        console.error('[kits/rituel] ⚠ ligne ajoutée non retirée, à vérifier à la main', sub.id, e3.message);
      }
    }
    if (monthsChange) {
      try {
        await seal.editSubscription(sub.id, {
          delivery_interval: intervalFor(delivery, from.months),
          billing_interval: intervalFor(billing, from.months),
        });
      } catch (e2) {
        console.error('[kits/rituel] ⚠ fréquence non rétablie, à corriger à la main', sub.id, e2.message);
      }
    }
    throw e;
  }
}

module.exports = { swapRituel, rituelOptions, rituelLines };
