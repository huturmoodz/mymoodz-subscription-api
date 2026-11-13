// core/rewards/tiers.js
// Paliers de fidélité des abonnés, réglés par Hugo dans Shopify (Contenu → Métaobjets →
// « Palier fidélité (abonnés) », type mmz_palier_fidelite). Aucun palier n'est écrit dans le code.
//
// Chaque palier est relu toutes les 5 minutes et contrôlé. Un palier « actif » n'est offert que
// s'il n'a AUCUN problème : produit choisi, SKU présent et connu de MyLink (compositions.json),
// et ce n'est ni une Boîte ZÉRO du composeur ni une Recharge (le traitement des commandes kits
// les compte : un cadeau de ce type ferait bloquer la commande).

const shopify = require('../kits/shopify');
const { isParentVariant, isBoxVariant } = require('../kits/config');
const { buildBundles, componentSources } = require('../stock/bundles');

const TYPE = 'mmz_palier_fidelite';
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, value: null };

const QUERY = `query Paliers($type: String!) {
  metaobjects(type: $type, first: 50) {
    nodes {
      handle
      updatedAt
      fields {
        key
        value
        reference {
          ... on ProductVariant {
            id sku price title inventoryPolicy inventoryQuantity
            inventoryItem { tracked }
            product { title status }
          }
        }
      }
    }
  }
}`;

/** SKU que MyLink connaît : produits et composants décrits dans compositions.json. */
function mylinkSkus() {
  const set = new Set();
  const bundles = buildBundles();
  for (const [sku, b] of Object.entries(bundles)) {
    set.add(sku);
    if (b.type === 'pool') b.pool.forEach((c) => set.add(c));
    else b.parts.forEach((p) => set.add(p.sku));
  }
  for (const [comp, shopSku] of Object.entries(componentSources())) { set.add(comp); set.add(shopSku); }
  return set;
}

/** Transforme un métaobjet Shopify en palier, avec la liste de ses problèmes (calcul pur). */
function normalize(node, known = mylinkSkus()) {
  const f = Object.fromEntries((node.fields || []).map((x) => [x.key, x]));
  const val = (k) => (f[k] && f[k].value !== null && f[k].value !== undefined ? String(f[k].value) : '');
  const ref = f.produit_offert?.reference || null;
  const variant = ref && ref.id ? {
    id: shopify.legacyId(ref.id),
    sku: ref.sku || '',
    titre: [ref.product?.title, ref.title && ref.title !== 'Default Title' ? ref.title : ''].filter(Boolean).join(' – '),
    prix: Number(ref.price || 0),
    suivi: !!ref.inventoryItem?.tracked,
    refuseRupture: ref.inventoryPolicy === 'DENY',
    stock: ref.inventoryQuantity === null || ref.inventoryQuantity === undefined ? null : Number(ref.inventoryQuantity),
    statut: ref.product?.status || '',
  } : null;

  const tier = {
    handle: node.handle,
    nom: val('nom') || node.handle,
    actif: val('actif') === 'true',
    livraisons: parseInt(val('livraisons'), 10),
    titre: val('titre_client'),
    message: val('message'),
    quantite: parseInt(val('quantite'), 10) || 1,
    produit: variant,
    problemes: [],
  };

  const p = tier.problemes;
  if (!Number.isInteger(tier.livraisons) || tier.livraisons < 1) p.push('numéro de livraison invalide');
  if (!tier.titre) p.push('texte affiché vide');
  if (!variant) p.push('aucun produit offert choisi');
  else {
    if (isBoxVariant(variant.id)) p.push('Boîte ZÉRO du composeur : utiliser un produit « Cadeau » dédié');
    if (isParentVariant(variant.id)) p.push('Recharge : utiliser un produit « Cadeau » dédié');
    if (!variant.sku) p.push('le produit offert n\'a pas de SKU (MyLink ne saurait pas quoi envoyer)');
    else if (!known.has(variant.sku)) p.push(`SKU ${variant.sku} absent de compositions.json (à déclarer aussi chez MyLink)`);
    if (variant.statut === 'ARCHIVED') p.push('produit offert archivé');
  }
  return tier;
}

/** Un palier peut-il être offert ? (actif ET sans problème) */
const offrable = (t) => t.actif && t.problemes.length === 0;

/** Paliers triés par numéro de livraison. Lecture Shopify avec cache ; null si illisible. */
async function loadTiers({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const d = await shopify.graphql(QUERY, { type: TYPE });
    const known = mylinkSkus();
    const list = (d.metaobjects?.nodes || []).map((n) => normalize(n, known))
      .sort((a, b) => (a.livraisons || 0) - (b.livraisons || 0));
    cache = { at: Date.now(), value: list };
    return list;
  } catch (e) {
    console.error('[paliers] lecture Shopify impossible (droit read_metaobjects ?) :', e.message);
    return cache.value; // dernière lecture réussie, ou null
  }
}

const _resetCache = () => { cache = { at: 0, value: null }; };

module.exports = { TYPE, loadTiers, normalize, offrable, mylinkSkus, _resetCache };
