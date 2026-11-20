// Tests du stock calculé à partir des composants MyLink, sans réseau : Shopify est simulé.
const test = require('node:test');
const assert = require('node:assert/strict');

const shopify = require('../core/kits/shopify');
const { buildBundles, masterHandles } = require('../core/stock/bundles');
const { computeTargets, pickMaster, pendingDemand, run, onInventoryWebhook } = require('../core/stock/sync');

test('compositions : les fiches maîtres déclarées sont la Boîte ZÉRO, la Boîte RITUEL et le diffuseur', () => {
  assert.deepEqual(masterHandles(), ['boite-zero', 'boite-rituel', 'diffuseur-essentiel-mymoodz']);
  const B = buildBundles();
  assert.deepEqual(B['PACK-ZERO-MIX-12'].parts.map((p) => [p.sku, p.qty]),
    [['BTE-ZERO-MEN-03', 1], ['BTE-ZERO-CIT-03', 1], ['BTE-ZERO-PAS-03', 1], ['BTE-ZERO-FRA-03', 1], ['DIFF-RECH', 1]]);
  assert.equal(B['POD-ZERO-MIX-12'].parts.some((p) => p.sku === 'DIFF-RECH'), false);   // offre après achat : sans diffuseur
  assert.deepEqual(B['POD-RIT-PF-09'].parts, [{ sku: 'BTE-RIT-PF-03', qty: 3 }]);
  assert.equal(B['PACK-BN-09'], undefined);   // ancienne gamme : pas confiée à MyLink
});

test('pack fixe : le composant le plus rare décide (diffuseur compris) ; composant inconnu → on ne touche pas', () => {
  const t = computeTargets(buildBundles(), { 'BTE-ZERO-MEN-03': 10, 'BTE-ZERO-CIT-03': 3, 'BTE-ZERO-PAS-03': 50, 'BTE-ZERO-FRA-03': 50, 'DIFF-RECH': 2 });
  assert.equal(t['PACK-ZERO-MIX-12'], 2);           // 1 boîte de chaque + 1 diffuseur : limité par les 2 diffuseurs
  assert.equal(t['PACK-ZERO-MIX-24'], 1);           // 2 de chaque : 3 Citron → 1 pack
  assert.equal(t['PACK-ZERO-MEN-03'], 2);           // 7 jours : limité par le diffuseur
  assert.equal(t['POD-ZERO-MIX-12'], 3);            // offre après achat 4 saveurs : limitée par le Citron
  assert.equal(t['POD-ZERO-MEN-09'], 3);            // 3 semaines = 3 boîtes Menthe
  assert.equal(t['REC-ZERO-1M'], 28);               // recharge à composer : 113 boîtes / 4
  assert.equal(t['REC-ZERO-3M'], 9);
  assert.equal(t['PACK-RIT-MIX-12'], null);         // boîtes RITUEL inconnues
});

test('plus de Citron : seuls ce qui contient du Citron ferme ; les autres saveurs restent en vente', () => {
  const t = computeTargets(buildBundles(), { 'BTE-ZERO-MEN-03': 20, 'BTE-ZERO-CIT-03': 0, 'BTE-ZERO-PAS-03': 20, 'BTE-ZERO-FRA-03': 20, 'DIFF-RECH': 50 });
  assert.equal(t['PACK-ZERO-CIT-03'], 0);
  assert.equal(t['POD-ZERO-CIT-09'], 0);
  assert.equal(t['PACK-ZERO-MEN-03'], 20);
  assert.equal(t['POD-ZERO-MEN-09'], 6);
  assert.equal(t['PACK-ZERO-MIX-12'], 0);           // le mélange des 4 a besoin d'un Citron
  assert.equal(t['POD-ZERO-MIX-12'], 0);
  assert.equal(t['REC-ZERO-1M'], 15);               // recharge : 60 boîtes restantes / 4, le composeur grise le Citron
});

test('stock négatif ou nul → 0, jamais négatif', () => {
  const t = computeTargets({ X: { type: 'fixed', parts: [{ sku: 'A', qty: 4 }] } }, { A: -12 });
  assert.equal(t.X, 0);
});

test('fiche maître : celle du produit maître, même si d\'autres fiches portent le même SKU', () => {
  const v = (id, handle, tracked = true) => ({ id, product: { handle }, inventoryItem: { tracked } });
  const masters = ['boite-zero'];
  assert.equal(pickMaster([v('a', 'recharge-zero-a-la-semaine'), v('b', 'boite-zero'), v('c', 'cadeau', false)], masters).master.id, 'b');
  assert.equal(pickMaster([v('a', 'autre')], masters).master.id, 'a');                       // seule fiche suivie
  assert.match(pickMaster([v('a', 'x'), v('b', 'y')], masters).error, /aucune déclarée maître/);
  assert.equal(pickMaster([v('a', 'boite-zero', false)], masters).error, 'non suivi');
  assert.equal(pickMaster([], masters).error, 'introuvable');
});

test('en attente : packs décomposés, miroirs 1 pour 1, lignes maîtres et recharge à composer ignorées', () => {
  const bundles = buildBundles();
  const masterVariantIds = new Set(['gid://shopify/ProductVariant/M-MEN']);
  const componentOfSku = { 'BTE-ZERO-MEN-03': 'BTE-ZERO-MEN-03', 'DIFF-RECH': 'DIFF-RECH' };
  const li = (sku, q, vid, cur = q) => ({ sku, unfulfilledQuantity: q, currentQuantity: cur, variant: { id: `gid://shopify/ProductVariant/${vid}` } });
  const orders = [{ lineItems: { nodes: [
    li('PACK-ZERO-MIX-12', 2, 'P1'),          // 2 packs : 2 boîtes de chaque + 2 diffuseurs
    li('BTE-ZERO-MEN-03', 3, 'ALIAS'),        // recharge 1 semaine : 3 boîtes Menthe
    li('BTE-ZERO-MEN-03', 4, 'M-MEN'),        // boîtes du composeur sur la fiche maître : déjà déduites par Shopify
    li('REC-ZERO-1M', 1, 'R1'),               // ligne payante de la recharge : ses boîtes ont leurs lignes
    li('POD-ZERO-MEN-09', 1, 'P9', 0),        // ligne retirée de la commande
    li('PACK-ZERO-12', 1, 'OLD'),             // ancienne gamme : inconnue ici
    li(null, 1, 'X'),                         // produit sans SKU
  ] } }];
  const d = pendingDemand(orders, { bundles, masterVariantIds, componentOfSku });
  assert.deepEqual(d, { 'BTE-ZERO-MEN-03': 5, 'BTE-ZERO-CIT-03': 2, 'BTE-ZERO-PAS-03': 2, 'BTE-ZERO-FRA-03': 2, 'DIFF-RECH': 2 });
});

// ---------- Synchro complète, Shopify simulé ----------
const LOC = 'gid://shopify/Location/9';
const item = (n) => `gid://shopify/InventoryItem/${n}`;
const variant = (id, sku, handle, level, tracked = true, itemN = id) => ({
  id: `gid://shopify/ProductVariant/${id}`, sku, product: { handle },
  inventoryItem: { id: item(itemN), tracked, inventoryLevel: level === null ? null : { quantities: [{ quantity: level }] } },
});
const VARIANTS = [
  // fiches maîtres (MyLink) : 10 de chaque
  variant(1, 'BTE-ZERO-MEN-03', 'boite-zero', 10), variant(2, 'BTE-ZERO-CIT-03', 'boite-zero', 10),
  variant(3, 'BTE-ZERO-PAS-03', 'boite-zero', 10), variant(4, 'BTE-ZERO-FRA-03', 'boite-zero', 10),
  variant(5, 'DIFF-RECH', 'diffuseur-essentiel-mymoodz', 10),
  // miroirs : recharge 1 semaine (suivie) et boîte cadeau (pas encore suivie)
  variant(11, 'BTE-ZERO-MEN-03', 'recharge-zero-a-la-semaine', 3),
  variant(12, 'BTE-ZERO-MEN-03', 'boite-zero-offerte-cadeau-fidelite', 0, false),
  // packs et recharges
  variant(21, 'PACK-ZERO-MIX-12', 'pack-decouverte-zero-les-4-saveurs', 100),
  variant(22, 'PACK-ZERO-MEN-03', 'pack-decouverte-zero-les-4-saveurs', 100),
  variant(23, 'PACK-ZERO-MEN-03', 'pack-decouverte-zero-menthe', 7),       // même SKU sur 2 produits
  variant(24, 'REC-ZERO-1M', 'recharge-zero-saveurs', 0, false),
];
const ORDERS = [
  { id: 'o1', tags: [], customAttributes: [], lineItems: { nodes: [
    { sku: 'PACK-ZERO-MIX-12', currentQuantity: 1, unfulfilledQuantity: 1, variant: { id: 'gid://shopify/ProductVariant/21' } }] } },
  { id: 'o2', tags: [], customAttributes: [], lineItems: { nodes: [
    { sku: 'BTE-ZERO-MEN-03', currentQuantity: 2, unfulfilledQuantity: 2, variant: { id: 'gid://shopify/ProductVariant/11' } },
    { sku: 'BTE-ZERO-MEN-03', currentQuantity: 4, unfulfilledQuantity: 4, variant: { id: 'gid://shopify/ProductVariant/1' } }] } },
  { id: 'o3', tags: ['mmz-test'], customAttributes: [], lineItems: { nodes: [   // commande de test : ne compte pas
    { sku: 'PACK-ZERO-MIX-12', currentQuantity: 5, unfulfilledQuantity: 5, variant: { id: 'gid://shopify/ProductVariant/21' } }] } },
];

function fakeShopify() {
  const log = { writes: [], queries: [], meta: [], mutations: [] };
  shopify.graphql = async (q, v) => {
    if (q.includes('locations')) return { locations: { nodes: [{ id: LOC, name: 'MyLink' }] } };
    if (q.includes('productVariants')) return { productVariants: { pageInfo: { hasNextPage: false }, nodes: VARIANTS } };
    if (q.includes('query Pending')) { log.queries.push(v.q); return { orders: { pageInfo: { hasNextPage: false }, nodes: ORDERS } }; }
    if (q.includes('inventorySetQuantities')) { log.mutations.push(q); log.writes.push(...v.input.quantities); return { inventorySetQuantities: { userErrors: [] } }; }
    if (q.includes('shop { id }')) return { shop: { id: 'gid://shopify/Shop/1' } };
    if (q.includes('metafieldsSet')) { log.meta.push(v.m[0]); return { metafieldsSet: { userErrors: [] } }; }
    throw new Error('requête inattendue');
  };
  return log;
}

test('synchro : maîtres jamais écrits, miroirs recopiés, packs calculés, commandes en attente déduites', async () => {
  delete process.env.STOCK_PENDING;
  const log = fakeShopify();
  const dry = await run({ write: false });
  assert.equal(log.writes.length, 0);
  assert.equal(log.meta.length, 0);
  assert.match(log.queries[0], /status:open AND -fulfillment_status:fulfilled AND created_at:>=\d{4}-\d\d-\d\d AND tag_not:mmz-test/);
  // MyLink : 10 de chaque. En attente : 1 pack 1 mois (1 de chaque + 1 diffuseur), 2 recharges 1 semaine Menthe.
  // Les 4 boîtes Menthe vendues sur la fiche maître sont déjà déduites par Shopify. La commande de test ne compte pas.
  assert.deepEqual(dry.enAttente, { 'BTE-ZERO-MEN-03': 3, 'BTE-ZERO-CIT-03': 1, 'BTE-ZERO-PAS-03': 1, 'BTE-ZERO-FRA-03': 1, 'DIFF-RECH': 1 });
  assert.deepEqual(dry.stockComposants, { 'BTE-ZERO-MEN-03': 7, 'BTE-ZERO-CIT-03': 9, 'BTE-ZERO-PAS-03': 9, 'BTE-ZERO-FRA-03': 9, 'DIFF-RECH': 9 });
  assert.deepEqual(dry.changements.map((c) => [c.type, c.sku, c.handle, c.avant, c.apres]), [
    ['miroir', 'BTE-ZERO-MEN-03', 'recharge-zero-a-la-semaine', 3, 7],
    ['pack', 'PACK-ZERO-MEN-03', 'pack-decouverte-zero-les-4-saveurs', 100, 7],   // l'autre fiche du même SKU est déjà à 7
    ['pack', 'PACK-ZERO-MIX-12', 'pack-decouverte-zero-les-4-saveurs', 100, 7],
  ]);
  assert.ok(dry.ignores.some((x) => x.handle === 'boite-zero-offerte-cadeau-fidelite' && x.raison === 'stock non suivi'));
  assert.ok(dry.ignores.some((x) => x.sku === 'REC-ZERO-1M' && x.raison === 'stock non suivi' && x.cible === 8));
  assert.ok(dry.composantsIntrouvables.includes('BTE-RIT-BN-03'));
  assert.equal(dry.metachamp, 'non écrit (aperçu)');

  const live = await run({ write: true });
  assert.equal(live.ecrits, 3);
  assert.deepEqual(log.writes, [
    { inventoryItemId: item(11), locationId: LOC, quantity: 7, changeFromQuantity: 3 },
    { inventoryItemId: item(22), locationId: LOC, quantity: 7, changeFromQuantity: 100 },
    { inventoryItemId: item(21), locationId: LOC, quantity: 7, changeFromQuantity: 100 },
  ]);
  assert.match(log.mutations[0], /@idempotent\(key: "[0-9a-f-]{36}"\)/);
  assert.ok(!log.writes.some((w) => [1, 2, 3, 4, 5].map(item).includes(w.inventoryItemId)));   // fiches maîtres : jamais
  // Stock par saveur pour le composeur
  assert.equal(log.meta.length, 1);
  assert.equal(log.meta[0].namespace, 'mymoodz');
  assert.equal(log.meta[0].key, 'stock_boites');
  const meta = JSON.parse(log.meta[0].value);
  assert.equal(meta.par_variante['1'], 7);
  assert.equal(meta.par_sku['BTE-ZERO-CIT-03'], 9);
  assert.equal(meta.par_sku['BTE-RIT-BN-03'], null);
  assert.equal(live.metachamp, 'écrit');

  // L'écho de nos propres écritures est ignoré ; un vrai mouvement relance le calcul
  assert.equal(onInventoryWebhook({ inventory_item_id: 21, available: 7 }), 'ignoré (notre écriture)');
  assert.equal(onInventoryWebhook({ inventory_item_id: 21, available: 6 }), 'programmé');
  assert.equal(onInventoryWebhook({ inventory_item_id: 1, available: 40 }), 'programmé');
});

test('synchro : métachamp réécrit seulement s\'il change ; STOCK_PENDING=off ne lit pas les commandes', async () => {
  const log = fakeShopify();
  const again = await run({ write: true });          // même stock qu'au test précédent
  assert.equal(again.metachamp, 'inchangé');
  process.env.STOCK_PENDING = 'off';
  const off = await run({ write: false });
  assert.equal(log.queries.length, 1);                // seulement le run précédent
  assert.deepEqual(off.enAttente, {});
  assert.equal(off.stockComposants['BTE-ZERO-MEN-03'], 10);
  process.env.STOCK_PENDING = 'held';
  await run({ write: false });
  assert.match(log.queries[1], /fulfillment_status:on_hold/);
  delete process.env.STOCK_PENDING;
});
