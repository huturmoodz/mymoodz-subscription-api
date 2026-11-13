// Tests des cadeaux de fidélité (paliers), sans réseau : Shopify est simulé.
const test = require('node:test');
const assert = require('node:assert/strict');

const shopify = require('../core/kits/shopify');
const tiersMod = require('../core/rewards/tiers');
const eng = require('../core/rewards/engine');

const REC = 'gid://shopify/ProductVariant/55725002883413';   // Recharge 1 mois
const BOX = 'gid://shopify/ProductVariant/55665971560789';   // Boîte ZÉRO Menthe
const GIFT = 'gid://shopify/ProductVariant/900001';          // produit « Cadeau » dédié

const meta = (handle, f, ref) => ({
  handle,
  fields: Object.entries(f).map(([key, value]) => ({ key, value: String(value), reference: key === 'produit_offert' ? ref : null }))
    .concat(ref ? [] : []),
});
const giftRef = (o = {}) => ({ id: GIFT, sku: 'DIFF-RECH', price: '29.90', title: 'Default Title', inventoryPolicy: 'DENY', inventoryQuantity: 10, inventoryItem: { tracked: true }, product: { title: 'Cadeau – Diffuseur', status: 'ACTIVE' }, ...o });
const tier = (handle, livraisons, ref, actif = true) => tiersMod.normalize(
  meta(handle, { nom: handle, actif, livraisons, titre_client: 'Cadeau', quantite: 1, produit_offert: ref ? ref.id : '' }, ref));

const order = (id, day, { sub = true, cancelled = false, tags = [], extra = [] } = {}) => ({
  id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: `2026-0${day}-01T10:00:00Z`, cancelledAt: cancelled ? '2026-01-01' : null, tags,
  customAttributes: [], customer: { id: 'gid://shopify/Customer/5' }, displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: { nodes: [{ id: 'l1', quantity: 1, currentQuantity: 1, variant: { id: REC }, sellingPlan: sub ? { sellingPlanId: 'sp' } : null },
    { id: 'l2', quantity: 4, currentQuantity: 4, variant: { id: BOX }, sellingPlan: null }, ...extra] },
  fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'ON_HOLD', fulfillmentHolds: [{ handle: 'flow', reasonNotes: 'MMZ-KIT attente' }] }] },
});

test('contrôle des paliers : Boîte ZÉRO, Recharge, SKU absent ou inconnu de MyLink → refusés', () => {
  assert.deepEqual(tier('ok', 3, giftRef()).problemes, []);
  assert.match(tier('a', 3, giftRef({ id: BOX, sku: 'POD-ZERO-MEN-03' })).problemes.join(), /Boîte ZÉRO/);
  assert.match(tier('b', 3, giftRef({ id: REC, sku: 'REC-ZERO-1M' })).problemes.join(), /Recharge/);
  assert.match(tier('c', 3, giftRef({ sku: '' })).problemes.join(), /pas de SKU/);
  assert.match(tier('d', 3, giftRef({ sku: 'INCONNU-1' })).problemes.join(), /absent de compositions/);
  assert.match(tier('e', 3, null).problemes.join(), /aucun produit/);
  assert.equal(tiersMod.offrable(tier('f', 3, giftRef(), false)), false);   // inactif
});

test('numéro de livraison : seuls les envois d\'abonnement non annulés comptent ; une fois par client ; pas d\'offre en masse', () => {
  const h = [order(1, 1), order(2, 2, { sub: false }), order(3, 3, { cancelled: true }), order(4, 4), order(9, 9, { tags: ['mmz-test'] })];
  const cur = order(5, 5);
  assert.equal(eng.deliveryNumber([...h, cur], cur), 3);                 // 1, 4 et la commande en cours
  const T = [tier('palier-3', 3, giftRef()), tier('palier-6', 6, giftRef())];
  assert.deepEqual(eng.decide({ tiers: T, n: 3, granted: new Set() }).map((t) => t.handle), ['palier-3']);
  assert.deepEqual(eng.decide({ tiers: T, n: 3, granted: new Set(['palier-3']) }), []);       // déjà offert
  assert.deepEqual(eng.decide({ tiers: T, n: 4, granted: new Set(), late: 1 }).map((t) => t.handle), ['palier-3']); // rattrapage
  assert.deepEqual(eng.decide({ tiers: T, n: 5, granted: new Set(), late: 1 }), []);          // activé trop tard : pas d'offre en masse
  assert.deepEqual([...eng.grantedHandles([order(1, 1, { tags: ['mmz-cadeau-palier-3'] }), order(2, 2, { cancelled: true, tags: ['mmz-cadeau-palier-6'] })])], ['palier-3']);
});

test('vue portail : offert, à venir, bientôt (inactif)', () => {
  const T = [tier('palier-3', 3, giftRef()), tier('palier-6', 6, null, false)];
  const v = eng.status({ tiers: T, n: 4, granted: new Set(['palier-3']) });
  assert.deepEqual(v.paliers.map((p) => p.statut), ['offert', 'bientot']);
  assert.equal(v.prochain.livraisons, 6);
  assert.equal(v.prochain.restantes, 2);
});

function fakeShopify(cur, history, { stock = 10, compStock = 5, ref } = {}) {
  const calls = [];
  shopify.graphql = async (q, v) => {
    if (q.includes('CadeauCommande')) {
      if (calls.includes('commit')) {   // relu après l'ajout : Shopify a créé une demande d'expédition libre
        return { order: { ...cur, fulfillmentOrders: { nodes: [...cur.fulfillmentOrders.nodes, { id: 'fo2', status: 'OPEN', fulfillmentHolds: [] }] } } };
      }
      return { order: cur };
    }
    if (q.includes('productVariants')) { calls.push(['stock', v.q]); return { productVariants: { nodes: [{ id: 'gid://shopify/ProductVariant/77', sku: 'POD-ZERO-MEN-03', inventoryQuantity: compStock, inventoryItem: { tracked: true } }] } }; }
    if (q.includes('fulfillmentOrderHold')) { calls.push(['retenue', v.id, v.hold.handle]); return { fulfillmentOrderHold: { fulfillmentHold: { id: 'h' }, userErrors: [] } }; }
    if (q.includes('CadeauHistorique')) return { orders: { pageInfo: { hasNextPage: false }, nodes: history } };
    if (q.includes('metaobjects')) {
      return { metaobjects: { nodes: [meta('palier-3', { nom: 'P3', actif: true, livraisons: 3, titre_client: 'Un diffuseur offert', quantite: 1, produit_offert: GIFT }, ref || giftRef({ inventoryQuantity: stock }))] } };
    }
    if (q.includes('orderEditBegin')) { calls.push('begin'); return { orderEditBegin: { calculatedOrder: { id: 'calc' }, userErrors: [] } }; }
    if (q.includes('orderEditAddVariant')) { calls.push(['add', v.v, v.q]); return { orderEditAddVariant: { calculatedLineItem: { id: 'cli' }, userErrors: [] } }; }
    if (q.includes('orderEditAddLineItemDiscount')) { calls.push(['remise', v.d.percentValue]); return { orderEditAddLineItemDiscount: { userErrors: [] } }; }
    if (q.includes('orderEditCommit')) { calls.push('commit'); return { orderEditCommit: { order: { id: cur.id }, userErrors: [] } }; }
    if (q.includes('tagsAdd')) { calls.push(['tag', ...v.tags]); return { tagsAdd: { userErrors: [] } }; }
    throw new Error('requête inattendue');
  };
  return calls;
}

test('commande retenue, 3e livraison : cadeau ajouté à 0 € puis tag ; rejouer ne l\'ajoute pas deux fois', async () => {
  process.env.REWARDS_MODE = 'live';
  tiersMod._resetCache();
  const cur = order(5, 5);
  const calls = fakeShopify(cur, [order(1, 1), order(4, 4), cur]);
  const r = await eng.applyToOrder('5');
  assert.equal(r.livraison, 3);
  assert.deepEqual(calls, ['begin', ['add', GIFT, 1], ['remise', 100], 'commit', ['tag', 'mmz-cadeau-palier-3'], ['retenue', 'fo2', 'mmz-kit']]);

  // Webhook rejoué : le cadeau est déjà dans la commande → seulement le tag, aucun ajout
  const withGift = order(5, 5, { extra: [{ id: 'l3', quantity: 1, currentQuantity: 1, variant: { id: GIFT }, sellingPlan: null }] });
  const calls2 = fakeShopify(withGift, [order(1, 1), order(4, 4), withGift]);
  await eng.applyToOrder('5');
  assert.deepEqual(calls2, [['tag', 'mmz-cadeau-palier-3']]);
});

test('commande déjà libérée pour MyLink ou cadeau en rupture : reporté, rien n\'est modifié', async () => {
  process.env.REWARDS_MODE = 'live';
  tiersMod._resetCache();
  const freed = order(5, 5);
  freed.fulfillmentOrders.nodes[0] = { id: 'fo1', status: 'OPEN', fulfillmentHolds: [] };
  let calls = fakeShopify(freed, [order(1, 1), order(4, 4), freed]);
  let r = await eng.applyToOrder('5');
  assert.equal(r.reportes[0].raison, 'commande_deja_liberee');
  assert.deepEqual(calls, []);

  tiersMod._resetCache();
  const cur = order(5, 5);
  calls = fakeShopify(cur, [order(1, 1), order(4, 4), cur], { stock: 0 });
  r = await eng.applyToOrder('5');
  assert.equal(r.reportes[0].raison, 'rupture');
  assert.deepEqual(calls, []);

  process.env.REWARDS_MODE = 'off';
  r = await eng.applyToOrder('5');
  assert.equal(r.skipped, true);
});

test('cadeau non suivi en stock : on regarde le composant MyLink (boîte Menthe à 0 → reporté)', async () => {
  process.env.REWARDS_MODE = 'live';
  tiersMod._resetCache();
  const cur = order(5, 5);
  const ref = giftRef({ sku: 'BTE-ZERO-MEN-03', price: '0.00', inventoryItem: { tracked: false }, inventoryQuantity: null });
  let calls = fakeShopify(cur, [order(1, 1), order(4, 4), cur], { ref, compStock: 0 });
  let r = await eng.applyToOrder('5');
  assert.equal(r.reportes[0].raison, 'rupture');
  assert.deepEqual(calls, [['stock', 'sku:"POD-ZERO-MEN-03"']]);

  tiersMod._resetCache();
  calls = fakeShopify(cur, [order(1, 1), order(4, 4), cur], { ref, compStock: 8 });
  r = await eng.applyToOrder('5');
  assert.equal(r.offerts.length, 1);
  assert.ok(!calls.some((c) => c[0] === 'remise'));   // déjà à 0 € : pas de remise
  process.env.REWARDS_MODE = 'off';
});

test('mode test : seules les commandes de test reçoivent le cadeau', async () => {
  process.env.REWARDS_MODE = 'test';
  tiersMod._resetCache();
  const real = order(5, 5);
  let calls = fakeShopify(real, [order(1, 1), order(4, 4), real]);
  let r = await eng.applyToOrder('5');
  assert.equal(r.reason, 'mode_test_vraie_commande');
  assert.deepEqual(calls, []);

  tiersMod._resetCache();
  const t1 = order(6, 6, { tags: ['mmz-test'] });
  const h = [order(1, 1, { tags: ['mmz-test'] }), order(4, 4, { tags: ['mmz-test'] }), t1];
  calls = fakeShopify(t1, h);
  r = await eng.applyToOrder('6');
  assert.equal(r.livraison, 3);
  assert.ok(calls.includes('commit'));
  process.env.REWARDS_MODE = 'off';
});
