// core/stock/bundles.js
// Lit les compositions des produits dans compositions.json (modifiable sans toucher au code)
// et les met sous la forme utilisée par le calcul de stock.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'compositions.json');

function load() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!raw || typeof raw.produits !== 'object') throw new Error('compositions.json : section « produits » absente');
  return raw;
}

/** { SKU parent: { type: 'fixed', parts: [{sku, qty}] } | { type: 'pool', pool: [sku], qty } } */
function buildBundles() {
  const out = {};
  for (const [sku, def] of Object.entries(load().produits)) {
    if (sku.startsWith('_')) continue;
    if (Array.isArray(def.au_choix_parmi)) {
      const n = Number(def.nombre_de_boites);
      if (!def.au_choix_parmi.length || !Number.isInteger(n) || n <= 0) throw new Error(`compositions.json : ${sku} mal décrit`);
      out[sku] = { type: 'pool', pool: def.au_choix_parmi.map(String), qty: n };
      continue;
    }
    const parts = Object.entries(def).map(([c, q]) => ({ sku: c, qty: Number(q) }));
    if (!parts.length || parts.some((p) => !Number.isInteger(p.qty) || p.qty <= 0)) throw new Error(`compositions.json : ${sku} mal décrit`);
    out[sku] = { type: 'fixed', parts };
  }
  return out;
}

/** Où lire le stock d'un composant dans Shopify (surchargeable par STOCK_COMPONENT_MAP en JSON). */
function componentSources() {
  const map = { ...(load().composants_dans_shopify || {}) };
  try { Object.assign(map, JSON.parse(process.env.STOCK_COMPONENT_MAP || '{}')); } catch (e) {
    console.error('[stock] STOCK_COMPONENT_MAP illisible, ignorée :', e.message);
  }
  return map;
}

module.exports = { buildBundles, componentSources };
