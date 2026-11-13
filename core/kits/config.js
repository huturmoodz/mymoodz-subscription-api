// core/kits/config.js
// Configuration des « kits » de recharge (gamme ZÉRO saveurs).
// Tout est surchargeable par la variable d'environnement KITS_CONFIG (JSON),
// pour ajouter une saveur ou une gamme sans redéployer de code.

const DEFAULT_CONFIG = {
  // Une ligne « parent » = une variante de durée du produit « Recharge ZÉRO Saveurs » (nouvelle gamme).
  // L'ancien ZÉRO (pods-zero) n'en fait PAS partie : ses commandes et abonnements ne sont jamais touchés.
  // months = nombre de mois couverts par UNE unité de cette variante.
  parents: {
    '55725002883413': { months: 1, label: 'Recharge ZÉRO Saveurs 1 mois', sku: 'REC-ZERO-1M' },
    '55725002916181': { months: 2, label: 'Recharge ZÉRO Saveurs 2 mois', sku: 'REC-ZERO-2M' },
    '55725002948949': { months: 3, label: 'Recharge ZÉRO Saveurs 3 mois', sku: 'REC-ZERO-3M' },
  },
  boxesPerMonth: 4,
  // Produit « Recharge ZÉRO Saveurs » (porte les 3 variantes de durée ci-dessus).
  parentProductId: '11795146178901',
  // Prix d'abonnement de chaque formule (règles Seal « Recharge ZÉRO Saveurs »), utilisés quand
  // l'abonné change de formule depuis « Mes saveurs ». Surchargeables par KITS_CONFIG.
  formulaPrices: {
    '55725002883413': '49.90',
    '55725002916181': '89.80',
    '55725002948949': '119.70',
  },
  // Produit « boîte » : une variante par saveur. Ce sont les vrais articles physiques (SKU MyLink).
  boxProductId: '11785293332821',
  boxes: {
    '55665971560789': { code: 'MEN', label: 'Menthe', sku: 'POD-ZERO-MEN-03' },
    '55665971593557': { code: 'CIT', label: 'Citron', sku: 'POD-ZERO-CIT-03' },
    '55665971626325': { code: 'PAS', label: 'Pastèque', sku: 'POD-ZERO-PAS-03' },
    '55665971659093': { code: 'FRA', label: 'Framboise', sku: 'POD-ZERO-FRA-03' },
  },
  // Gamme RITUEL : un produit par rituel, une variante par durée. Chaque variante est déjà un lot
  // physique (POD-RIT-BN-12 = 4 boîtes Bonnes Nuits) : rien à composer, rien à ajouter à la commande.
  // Mêmes formules et mêmes prix d'abonnement que ZÉRO Saveurs (même nombre de boîtes).
  rituels: {
    BN: { label: 'Bonnes Nuits', productId: '11688329871701', variants: { 1: '55290364723541', 2: '55290364756309', 3: '55290364789077' }, sku: 'POD-RIT-BN' },
    BE: { label: 'Bien-Être', productId: '11688346419541', variants: { 1: '55290448347477', 2: '55290448380245', 3: '55290448413013' }, sku: 'POD-RIT-BE' },
    IC: { label: 'Idées Claires', productId: '11688350056789', variants: { 1: '55290462470485', 2: '55290462503253', 3: '55290462536021' }, sku: 'POD-RIT-IC' },
    PF: { label: 'Pleine Forme', productId: '11688351891797', variants: { 1: '55290470662485', 2: '55290470695253', 3: '55290470728021' }, sku: 'POD-RIT-PF' },
  },
  // Saveur utilisée si une ligne parent arrive sans composition (ex. upsell post-achat)
  // et qu'aucune autre ligne de la commande ne donne de composition de référence.
  defaultBoxVariantId: '55665971560789',
  // Propriétés de ligne posées par le thème (composeur).
  props: {
    composeId: '_moodz_compose_id',
    compose: '_moodz_compose',
  },
  // Tags et attributs écrits par le serveur.
  tags: { ok: 'mmz-kit-ok', error: 'mmz-kit-erreur' },
  sealNotes: { compo: 'mymoodz_kit_compo', seeded: 'mymoodz_kit_seeded' },
};

function loadConfig() {
  if (!process.env.KITS_CONFIG) return DEFAULT_CONFIG;
  try {
    const override = JSON.parse(process.env.KITS_CONFIG);
    return { ...DEFAULT_CONFIG, ...override };
  } catch (e) {
    console.error('[kits/config] KITS_CONFIG invalide, configuration par défaut utilisée', e.message);
    return DEFAULT_CONFIG;
  }
}

const config = loadConfig();

const isParentVariant = (id) => Object.prototype.hasOwnProperty.call(config.parents, String(id));
const isBoxVariant = (id) => Object.prototype.hasOwnProperty.call(config.boxes, String(id));
const monthsOf = (variantId) => (config.parents[String(variantId)] || {}).months || 0;
const boxesTargetFor = (variantId, qty = 1) => monthsOf(variantId) * config.boxesPerMonth * Number(qty || 0);

// Interrupteur général : le serveur ne traite les commandes « kits » que si KITS_LIVE=true.
const kitsLive = () => String(process.env.KITS_LIVE || '').toLowerCase() === 'true';

/* ---------- Gammes ---------- */

/** Variante RITUEL → { code, label, months, productId, sku } ; null si ce n'est pas une recharge RITUEL. */
function rituelOf(variantId) {
  const id = String(variantId || '');
  for (const [code, r] of Object.entries(config.rituels || {})) {
    for (const [m, v] of Object.entries(r.variants || {})) {
      if (String(v) === id) return { code, label: r.label, months: Number(m), productId: String(r.productId), sku: `${r.sku}-${Number(m) * 12}` };
    }
  }
  return null;
}
const isRituelVariant = (id) => !!rituelOf(id);

/** Variante RITUEL d'un rituel donné pour une durée donnée (null si absente). */
const rituelVariant = (code, months) => String(((config.rituels || {})[code] || {}).variants?.[months] || '') || null;

/**
 * Gamme d'une ligne d'abonnement : « zero » (Recharge ZÉRO Saveurs, composable), « rituel »
 * (un rituel, formule seulement) ou « ancienne » (ancienne gamme : pas de formule ni de saveurs ici).
 */
function rangeOf(variantId) {
  if (isParentVariant(variantId)) return 'zero';
  if (isRituelVariant(variantId)) return 'rituel';
  return 'ancienne';
}

/** Prix d'abonnement d'une formule de N mois (même grille pour ZÉRO Saveurs et RITUEL). */
function priceForMonths(months) {
  for (const [variantId, price] of Object.entries(config.formulaPrices || {})) {
    if (monthsOf(variantId) === Number(months)) return Number(price);
  }
  return 0;
}

module.exports = {
  config, isParentVariant, isBoxVariant, monthsOf, boxesTargetFor, kitsLive,
  rituelOf, isRituelVariant, rituelVariant, rangeOf, priceForMonths,
};
