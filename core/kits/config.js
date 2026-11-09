// core/kits/config.js
// Configuration des « kits » de recharge (gamme ZÉRO saveurs).
// Tout est surchargeable par la variable d'environnement KITS_CONFIG (JSON),
// pour ajouter une saveur ou une gamme sans redéployer de code.

const DEFAULT_CONFIG = {
  // Une ligne « parent » = une variante de durée du produit recharge (pods-zero).
  // months = nombre de mois couverts par UNE unité de cette variante.
  parents: {
    '52143295037781': { months: 1, label: 'Recharge ZÉRO 1 mois' },
    '52143295070549': { months: 2, label: 'Recharge ZÉRO 2 mois' },
    '52143295103317': { months: 3, label: 'Recharge ZÉRO 3 mois' },
  },
  boxesPerMonth: 4,
  // Produit « boîte » : une variante par saveur. Ce sont les vrais articles physiques (SKU MyLink).
  boxProductId: '11785293332821',
  boxes: {
    '55665971560789': { code: 'MEN', label: 'Menthe Poivrée', sku: 'POD-ZERO-MEN-03' },
    '55665971593557': { code: 'CIT', label: 'Citron', sku: 'POD-ZERO-CIT-03' },
    '55665971626325': { code: 'PAS', label: 'Pastèque', sku: 'POD-ZERO-PAS-03' },
    '55665971659093': { code: 'FRA', label: 'Framboise', sku: 'POD-ZERO-FRA-03' },
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

// Le serveur ne traite les commandes « kits » que si KITS_LIVE=true :
// tant que pods-zero vend l'ancien ZÉRO, rien ne doit être touché.
const kitsLive = () => String(process.env.KITS_LIVE || '').toLowerCase() === 'true';

module.exports = { config, isParentVariant, isBoxVariant, monthsOf, boxesTargetFor, kitsLive };
