// core/stock/bundles.js
// Composition de chaque produit vendu (SKU Shopify) en composants physiques stockés chez MyLink.
// Même source que le fichier de paramétrage envoyé à MyLink (Parametrage_OMS_MyMOODz.xlsx) :
// toute modification d'un bundle doit être faite ici ET chez MyLink.

const DIFF = 'DIFF-RECH';
const ZERO = { MEN: 'BTE-ZERO-MEN-03', CIT: 'BTE-ZERO-CIT-03', PAS: 'BTE-ZERO-PAS-03', FRA: 'BTE-ZERO-FRA-03' };
const RIT = { BN: 'BTE-RIT-BN-03', BE: 'BTE-RIT-BE-03', IC: 'BTE-RIT-IC-03', PF: 'BTE-RIT-PF-03' };
const ANC_ZERO = 'BTE-ANC-ZERO-03';

const fixed = (parts) => ({ type: 'fixed', parts: parts.map(([sku, qty]) => ({ sku, qty })) });
// « pool » : N boîtes à répartir librement entre plusieurs composants (recharge ZÉRO à composer).
const pool = (skus, qty) => ({ type: 'pool', pool: skus, qty });

function buildBundles() {
  const B = {};
  const Z = Object.values(ZERO);
  const R = Object.values(RIT);

  // --- Nouvelle gamme ZÉRO saveurs
  for (const [k, box] of Object.entries(ZERO)) B[`PACK-ZERO-${k}-03`] = fixed([[box, 1], [DIFF, 1]]); // 7 jours, diffuseur inclus
  B['PACK-ZERO-MIX-12'] = fixed(Z.map((z) => [z, 1]));
  B['PACK-ZERO-MIX-24'] = fixed(Z.map((z) => [z, 2]));
  B['REC-ZERO-1M'] = pool(Z, 4);   // recharge à composer : la ligne payante n'est pas expédiée,
  B['REC-ZERO-2M'] = pool(Z, 8);   // mais elle ne doit plus se vendre s'il n'y a plus assez de boîtes
  B['REC-ZERO-3M'] = pool(Z, 12);

  // --- Nouvelle gamme RITUEL
  for (const [k, box] of Object.entries(RIT)) {
    B[`PACK-RIT-${k}-03`] = fixed([[box, 1], [DIFF, 1]]);
    B[`PACK-RIT-${k}-12`] = fixed([[box, 4]]);
    B[`PACK-RIT-${k}-24`] = fixed([[box, 8]]);
    B[`POD-RIT-${k}-12`] = fixed([[box, 4]]);
    B[`POD-RIT-${k}-24`] = fixed([[box, 8]]);
    B[`POD-RIT-${k}-36`] = fixed([[box, 12]]);
  }
  B['PACK-RIT-MIX-12'] = fixed(R.map((r) => [r, 1]));
  B['PACK-RIT-MIX-24'] = fixed(R.map((r) => [r, 2]));

  // --- Ancienne gamme (transition)
  B['PACK-ZERO-03'] = fixed([[ANC_ZERO, 1], [DIFF, 1]]);
  B['PACK-ZERO-12'] = fixed([[ANC_ZERO, 4]]);
  B['PACK-ZERO-24'] = fixed([[ANC_ZERO, 8]]);
  B['POD-ZERO-12'] = fixed([[ANC_ZERO, 4]]);
  B['POD-ZERO-24'] = fixed([[ANC_ZERO, 8]]);
  B['POD-ZERO-36'] = fixed([[ANC_ZERO, 12]]);
  for (const k of ['BN', 'BE']) {
    const u = `BTE-ANC-${k}-01`, t = `BTE-ANC-${k}-03`;
    B[`PACK-${k}-03`] = fixed([[u, 1], [DIFF, 1]]);
    B[`PACK-${k}-09`] = fixed([[t, 1]]);
    B[`POD-${k}-03`] = fixed([[u, 1]]);
    B[`POD-${k}-06`] = fixed([[u, 2]]);
    B[`POD-${k}-09`] = fixed([[t, 1]]);
  }
  return B;
}

// Où lire le stock d'un composant dans Shopify : le SKU de la variante Shopify qui porte ce composant.
// Les boîtes ZÉRO saveurs existent déjà dans Shopify sous le produit « boite-zero » (POD-ZERO-xxx-03).
// Les autres composants sont lus sous leur propre SKU (produit composant à créer si MyLink en a besoin).
// Surchargeable par la variable STOCK_COMPONENT_MAP (JSON { "BTE-...": "SKU-SHOPIFY" }).
function componentSources() {
  const map = {
    [ZERO.MEN]: 'POD-ZERO-MEN-03', [ZERO.CIT]: 'POD-ZERO-CIT-03',
    [ZERO.PAS]: 'POD-ZERO-PAS-03', [ZERO.FRA]: 'POD-ZERO-FRA-03',
  };
  try { Object.assign(map, JSON.parse(process.env.STOCK_COMPONENT_MAP || '{}')); } catch (e) {
    console.error('[stock] STOCK_COMPONENT_MAP illisible, ignorée :', e.message);
  }
  return map;
}

module.exports = { buildBundles, componentSources };
