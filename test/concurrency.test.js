// Pic de commandes : plusieurs recharges traitées en même temps, webhooks en double.
process.env.KITS_LIVE = 'true';
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_KITS_ACCESS_TOKEN = 'x';

const test = require('node:test');
const assert = require('node:assert/strict');
const shopify = require('../core/kits/shopify');

const MEN = '55665971560789', CIT = '55665971593557', PAS = '55665971626325', FRA = '55665971659093';
const M1 = '55725002883413', M2 = '55725002916181', M3 = '55725002948949';
const ORDERS = new Map();
const adds = new Map();
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 15));

shopify.getOrder = async (id) => { await tick(); return JSON.parse(JSON.stringify(ORDERS.get(String(id)))); };
shopify.holdFulfillmentOrder = async (foId) => { await tick(); };
shopify.releaseFulfillmentOrderHold = async () => { await tick(); };
shopify.addTags = async (id, tags) => { await tick(); ORDERS.get(String(id)).tags.push(...tags); };
shopify.removeTags = async () => {};
shopify.fulfillWithoutShipping = async () => {};
shopify.addVariantsToOrder = async (id, list) => {
  await tick();
  const o = ORDERS.get(String(id));
  for (const a of list) {
    o.lineItems.nodes.push({ id: 'n' + Math.random(), quantity: a.quantity, currentQuantity: a.quantity,
      variant: { id: `gid://shopify/ProductVariant/${a.variantId}` }, customAttributes: [] });
    adds.set(String(id), (adds.get(String(id)) || 0) + a.quantity);
  }
};
const { processOrder } = require('../core/kits/orderFlow');

const mk = (id, v, compose) => ORDERS.set(String(id), {
  id: `gid://shopify/Order/${id}`, name: '#' + id, tags: [], cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
  lineItems: { nodes: [{ id: 'p' + id, quantity: 1, currentQuantity: 1, variant: { id: `gid://shopify/ProductVariant/${v}` },
    customAttributes: [{ key: '_moodz_compose', value: compose }] }] },
  fulfillmentOrders: { nodes: [{ id: 'fo' + id, status: 'OPEN', fulfillmentHolds: [], lineItems: { nodes: [] } }] },
});

test('5 commandes dans la même seconde, chacune reçue 2 fois (création + mise à jour) → chacune reçoit exactement ses boîtes', async () => {
  mk(1, M1, `${MEN}:4`);
  mk(2, M2, `${CIT}:4,${PAS}:4`);
  mk(3, M3, `${FRA}:12`);
  mk(4, M1, `${MEN}:1,${CIT}:1,${PAS}:1,${FRA}:1`);
  mk(5, M2, `${PAS}:8`);
  const jobs = [];
  for (const id of [1, 2, 3, 4, 5]) jobs.push(processOrder(String(id), 'create'), processOrder(String(id), 'updated'));
  const results = await Promise.all(jobs);
  assert.equal(results.filter((r) => r.error).length, 0);
  assert.deepEqual(Object.fromEntries(adds), { 1: 4, 2: 8, 3: 12, 4: 4, 5: 8 });
  for (const id of [1, 2, 3, 4, 5]) assert.ok(ORDERS.get(String(id)).tags.includes('mmz-kit-ok'));
});
