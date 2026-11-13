// Tests du stock des packs calculé à partir des composants, sans réseau : Shopify est simulé.
const test = require('node:test');
const assert = require('node:assert/strict');

const shopify = require('../core/kits/shopify');
const { buildBundles } = require('../core/stock/bundles');
const { computeTargets, run } = require('../core/stock/sync');

test('pack fixe : le composant le plus rare décide ; composant inconnu → on ne touche pas', () => {
  const B = buildBundles();
  const t = computeTargets(B, { 'BTE-ZERO-MEN-03': 10, 'BTE-ZERO-CIT-03': 3, 'BTE-ZERO-PAS-03': 50, 'BTE-ZERO-FRA-03': 50, 'DIFF-RECH': 2 });
  assert.equal(t['PACK-ZERO-MIX-12'], 3);           // 1 boîte de chaque : limité par Citron
  assert.equal(t['PACK-ZERO-MIX-24'], 1);           // 2 de chaque : 3 Citron → 1 pack
  assert.equal(t['PACK-ZERO-MEN-03'], 2);           // 7 jours : limité par le diffuseur
  assert.equal(t['REC-ZERO-1M'], 28);               // recharge à composer : 113 boîtes / 4
  assert.equal(t['REC-ZERO-3M'], 9);
  assert.equal(t['PACK-RIT-MIX-12'], null);         // boîtes RITUEL inconnues
});

test('plus de Citron : seul le pack 7 jours Citron et les mélanges 4 saveurs ferment ; les autres saveurs restent en vente', () => {
  const t = computeTargets(buildBundles(), { 'BTE-ZERO-MEN-03': 20, 'BTE-ZERO-CIT-03': 0, 'BTE-ZERO-PAS-03': 20, 'BTE-ZERO-FRA-03': 20, 'DIFF-RECH': 50 });
  assert.equal(t['PACK-ZERO-CIT-03'], 0);
  assert.equal(t['PACK-ZERO-MEN-03'], 20);
  assert.equal(t['PACK-ZERO-PAS-03'], 20);
  assert.equal(t['PACK-ZERO-MIX-12'], 0);           // le mélange des 4 a besoin d'un Citron
  assert.equal(t['REC-ZERO-1M'], 15);               // recharge : 60 boîtes restantes / 4, le composeur grise le Citron
});

test('stock négatif ou nul → 0, jamais négatif', () => {
  const t = computeTargets({ X: { type: 'fixed', parts: [{ sku: 'A', qty: 4 }] } }, { A: -12 });
  assert.equal(t.X, 0);
});

test('synchro : écrit seulement les variantes suivies qui changent, en mode écriture', async () => {
  const variants = [
    { id: 'v1', sku: 'POD-ZERO-MEN-03', inventoryQuantity: 8, product: { handle: 'boite-zero' }, inventoryItem: { id: 'c1', tracked: true } },
    { id: 'v2', sku: 'POD-ZERO-CIT-03', inventoryQuantity: 8, product: { handle: 'boite-zero' }, inventoryItem: { id: 'c2', tracked: true } },
    { id: 'v3', sku: 'POD-ZERO-PAS-03', inventoryQuantity: 8, product: { handle: 'boite-zero' }, inventoryItem: { id: 'c3', tracked: true } },
    { id: 'v4', sku: 'POD-ZERO-FRA-03', inventoryQuantity: 1, product: { handle: 'boite-zero' }, inventoryItem: { id: 'c4', tracked: true } },
    { id: 'p1', sku: 'PACK-ZERO-MIX-12', product: { handle: 'pack-zero' }, inventoryItem: { id: 'i1', tracked: true, inventoryLevel: { quantities: [{ quantity: 100 }] } } },
    { id: 'p2', sku: 'PACK-ZERO-MIX-24', product: { handle: 'pack-zero' }, inventoryItem: { id: 'i2', tracked: true, inventoryLevel: { quantities: [{ quantity: 0 }] } } },
    { id: 'p3', sku: 'REC-ZERO-1M', product: { handle: 'recharge' }, inventoryItem: { id: 'i3', tracked: false } },
  ];
  const writes = [];
  shopify.graphql = async (q, v) => {
    if (q.includes('locations')) return { locations: { nodes: [{ id: 'gid://shopify/Location/9', name: 'MyLink' }] } };
    if (q.includes('productVariants')) return { productVariants: { pageInfo: { hasNextPage: false }, nodes: variants } };
    if (q.includes('inventorySetQuantities')) { writes.push(...v.input.quantities); return { inventorySetQuantities: { userErrors: [] } }; }
    throw new Error('requête inattendue');
  };
  const dry = await run({ write: false });
  assert.equal(writes.length, 0);
  assert.deepEqual(dry.changements.map((c) => [c.sku, c.avant, c.apres]), [['PACK-ZERO-MIX-12', 100, 1]]);
  assert.ok(dry.ignores.some((x) => x.sku === 'REC-ZERO-1M' && x.raison === 'stock non suivi'));

  const live = await run({ write: true });
  assert.equal(live.ecrits, 1);
  assert.deepEqual(writes, [{ inventoryItemId: 'i1', locationId: 'gid://shopify/Location/9', quantity: 1, compareQuantity: 100 }]);
});
