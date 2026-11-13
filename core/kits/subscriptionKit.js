// core/kits/subscriptionKit.js
// Le « kit » dans l'abonnement Seal : la ligne Recharge (durée, payante) + les boîtes saveur à 0 €.
// Les boîtes sont dans le contrat, donc chaque renouvellement créé par Seal les contient déjà :
// aucune modification de commande n'est nécessaire au renouvellement.
//
// Source de vérité de la composition : la note d'abonnement mymoodz_kit_compo
// au format "<variante durée>|<composition pour UNE unité>".
// À défaut (premier passage), on lit la propriété _moodz_compose de la ligne Recharge.

const { config, isParentVariant, isBoxVariant, monthsOf } = require('./config');
const { parseComposition, stringifyComposition, validateComposition, rescale, scale, diff, describe } = require('./composition');
const seal = require('./seal');
const { withLock } = require('./lock');

const KIT_PROP = '_moodz_kit';

function analyse(sub) {
  const items = sub.items || [];
  const parents = items.filter((it) => isParentVariant(it.variant_id) && Number(it.quantity) > 0);
  const boxes = items.filter((it) => isBoxVariant(it.variant_id));
  return { items, parents, boxes };
}

/** Composition « par unité » de la recharge actuelle, d'après la note ou la propriété de ligne. */
function storedPerUnit(sub, parent) {
  const parentVariant = String(parent.variant_id);
  const target = monthsOf(parentVariant) * config.boxesPerMonth;
  const note = seal.getNote(sub, config.sealNotes.compo);
  if (note) {
    const [noteVariant, compo] = note.split('|');
    const map = parseComposition(compo);
    if (noteVariant === parentVariant) {
      const check = validateComposition(map, target);
      if (check.ok) return check.map;
    }
    // La durée a changé (ex. 1 → 2 mois dans l'espace Seal) : on garde les proportions
    if (map.size) return rescale(map, target);
  }
  const fromProp = parseComposition(seal.getItemProp(parent, config.props.compose));
  const check = validateComposition(fromProp, target);
  if (check.ok) return check.map;
  return null;
}

function currentBoxMap(boxes) {
  const map = new Map();
  for (const b of boxes) map.set(String(b.variant_id), (map.get(String(b.variant_id)) || 0) + Number(b.quantity || 0));
  return map;
}

function boxItem(variantId, quantity) {
  const cfg = config.boxes[String(variantId)];
  return {
    product_id: String(config.boxProductId),
    variant_id: String(variantId),
    quantity: String(quantity),
    title: `Boîte ZÉRO - ${cfg.label}`,
    sku: cfg.sku,
    price: '0.00',
    taxable: 0,
    requires_shipping: 1,
    one_time: 0,
    total_discount: 0,
    subsc_discount_percent: 0,
    properties: [{ key: KIT_PROP, value: '1' }],
  };
}

const sameBoxes = (a, b) => {
  const { add, remove } = diff(a, b);
  return add.size === 0 && remove.size === 0;
};

/**
 * Un passage : envoie à Seal les changements pour aller des boîtes de « sub » vers « wanted ».
 * Ordre important : modifications et ajouts d'abord, retraits EN DERNIER. Seal peut renuméroter
 * les lignes après un retrait : une modification envoyée ensuite visait une ligne disparue et Seal
 * l'ignorait sans erreur (constaté le 13/11 : 2 Menthe + 2 Citron → 4 Menthe donnait 2 Menthe).
 */
async function alignBoxesOnce(sub, wanted) {
  const { boxes } = analyse(sub);
  const current = currentBoxMap(boxes);
  const { add, remove } = diff(wanted, current);

  const edits = [];
  const adds = [];
  const removals = [];

  // Saveurs qui existent déjà dans le contrat : on ajuste la quantité de la première ligne,
  // on supprime les doublons éventuels.
  const byVariant = new Map();
  for (const b of boxes) {
    const v = String(b.variant_id);
    if (!byVariant.has(v)) byVariant.set(v, []);
    byVariant.get(v).push(b);
  }
  const ids = new Set([...add.keys(), ...remove.keys()]);
  for (const v of ids) {
    const want = wanted.get(v) || 0;
    const lines = byVariant.get(v) || [];
    if (!lines.length) {
      if (want > 0) adds.push(boxItem(v, want));
      continue;
    }
    if (want === 0) {
      lines.forEach((l) => removals.push(l.id));
      continue;
    }
    edits.push({ id: Number(lines[0].id), quantity: String(want), price: '0.00' });
    lines.slice(1).forEach((l) => removals.push(l.id));
  }

  if (edits.length) await seal.editItems(sub.id, edits);
  if (adds.length) await seal.addItems(sub.id, adds);
  if (removals.length) await seal.removeItems(sub.id, removals);
}

const MAX_PASSES = 3;

/**
 * Aligne les boîtes du contrat Seal sur la composition voulue, puis VÉRIFIE en relisant Seal.
 * Seule la relecture fait foi : si Seal n'a pas tout pris en compte, on refait un passage avec les
 * lignes fraîches (3 au plus). Toujours pas aligné → erreur, et la note n'est PAS écrite : le webhook
 * « abonnement modifié » remet alors le contrat sur la dernière composition enregistrée.
 * @param {object} sub abonnement Seal (avec items)
 * @param {Map} perUnit composition pour UNE unité de la recharge
 */
async function applyToSubscription(sub, perUnit) {
  const { parents } = analyse(sub);
  const parentQty = parents.reduce((s, p) => s + Number(p.quantity || 0), 0);
  const wanted = scale(perUnit, parentQty);

  let cur = sub;
  let touched = false;
  for (let pass = 0; ; pass += 1) {
    const now = currentBoxMap(analyse(cur).boxes);
    if (sameBoxes(wanted, now)) break;
    if (pass === MAX_PASSES) {
      throw new Error(`boîtes non alignées après ${MAX_PASSES} passages : voulu ${describe(wanted)}, contrat ${describe(now) || 'vide'}`);
    }
    if (pass > 0) console.warn('[kits/seal] contrat pas encore aligné, nouveau passage', sub.id, describe(now));
    await alignBoxesOnce(cur, wanted);
    touched = true;
    cur = await seal.getSubscription(sub.id);
  }
  // Lignes relues : la ligne Recharge a pu changer d'identifiant
  const parent = analyse(cur).parents[0];

  // La ligne Recharge affiche « Saveurs : … » sur les commandes et e-mails de renouvellement :
  // on la met à jour pour qu'elle corresponde aux boîtes réellement envoyées.
  const compoStr = stringifyComposition(perUnit);
  if (parent && seal.getItemProp(parent, config.props.compose) !== compoStr) {
    try {
      const raw = parent.properties;
      const list = Array.isArray(raw)
        ? raw.map((p) => ({ key: p.key ?? p.name, value: String(p.value ?? '') }))
        : Object.entries(raw || {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
      const set = (key, value) => {
        const f = list.find((p) => p.key === key);
        if (f) f.value = value; else list.push({ key, value });
      };
      set(config.props.compose, compoStr);
      set(config.props.flavorsLabel || 'Saveurs', describe(perUnit));
      const edit = { id: Number(parent.id), quantity: String(parent.quantity), properties: list };
      if (parent.price != null) edit.price = String(parent.price);
      await seal.editItems(sub.id, [edit]);
    } catch (e) {
      console.error('[kits/seal] libellé Saveurs non mis à jour', sub.id, e.message);
    }
  }

  // On n'écrit la note que si elle change : chaque écriture redéclenche le webhook « abonnement modifié »,
  // et une écriture systématique créerait une boucle sans fin.
  const noteValue = `${parent.variant_id}|${stringifyComposition(perUnit)}`;
  if (seal.getNote(cur, config.sealNotes.compo) !== noteValue || seal.getNote(cur, config.sealNotes.seeded) !== '1') {
    await seal.upsertNotes(sub.id, [
      { name: config.sealNotes.compo, value: noteValue },
      { name: config.sealNotes.seeded, value: '1' },
    ]);
  }

  return { changed: touched, wanted: describe(wanted) };
}

/**
 * Appelé par les webhooks Seal (abonnement créé / modifié).
 * Ne fait rien pour les abonnements qui ne contiennent pas de recharge composée.
 */
async function syncSubscription(subscriptionId) {
  return withLock(`sub:${subscriptionId}`, async () => {
    const sub = await seal.getSubscription(subscriptionId);
    const { parents } = analyse(sub);
    if (!parents.length) return { skipped: true, reason: 'pas_de_recharge' };
    const perUnit = storedPerUnit(sub, parents[0]);
    if (!perUnit) return { skipped: true, reason: 'pas_de_composition' };
    const result = await applyToSubscription(sub, perUnit);
    console.log('[kits/seal] abonnement', subscriptionId, result);
    return result;
  });
}

module.exports = { analyse, storedPerUnit, applyToSubscription, syncSubscription, currentBoxMap };
