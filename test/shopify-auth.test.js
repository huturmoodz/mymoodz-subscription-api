// Jeton via l'app du Dev Dashboard (identifiants client) + signature des webhooks.
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_KITS_CLIENT_ID = 'cid';
process.env.SHOPIFY_KITS_CLIENT_SECRET = 'csecret';
process.env.SHOPIFY_WEBHOOK_SECRET = 'shopsecret';
delete process.env.SHOPIFY_KITS_ACCESS_TOKEN;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const shopify = require('../core/kits/shopify');

test('jeton demandé une fois, réutilisé, renouvelé après un 401', async () => {
  const calls = [];
  let tokenN = 0;
  let first401 = true;
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/admin/oauth/access_token')) {
      const body = new URLSearchParams(opts.body);
      assert.equal(body.get('grant_type'), 'client_credentials');
      assert.equal(body.get('client_id'), 'cid');
      tokenN++;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' + tokenN, expires_in: 86399 }) };
    }
    if (opts.headers['X-Shopify-Access-Token'] === 'tok1' && calls.length > 3 && first401) {
      first401 = false;
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { ok: opts.headers['X-Shopify-Access-Token'] } }) };
  };
  assert.deepEqual(await shopify.graphql('{x}'), { ok: 'tok1' });
  assert.deepEqual(await shopify.graphql('{x}'), { ok: 'tok1' });
  assert.equal(calls.filter((u) => u.endsWith('access_token')).length, 1);
  assert.deepEqual(await shopify.graphql('{x}'), { ok: 'tok2' });
  assert.equal(tokenN, 2);
});

test('webhook accepté avec le secret boutique ou le secret de l\'app, refusé sinon', () => {
  const body = Buffer.from('{"id":1}');
  const sign = (s) => crypto.createHmac('sha256', s).update(body).digest('base64');
  assert.equal(shopify.verifyShopifyWebhook(body, sign('shopsecret')), true);
  assert.equal(shopify.verifyShopifyWebhook(body, sign('csecret')), true);
  assert.equal(shopify.verifyShopifyWebhook(body, sign('autre')), false);
  assert.equal(shopify.verifyShopifyWebhook(body, ''), false);
});

test('abonnement webhook créé seulement s\'il manque', async () => {
  let created = 0;
  let existing = {};
  global.fetch = async (url, opts) => {
    if (url.endsWith('access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 86399 }) };
    const q = JSON.parse(opts.body).query;
    if (q.includes('webhookSubscriptionCreate')) {
      created++;
      const t = JSON.parse(opts.body).variables.topic;
      existing[t] = [{ id: 'w', endpoint: { callbackUrl: 'https://x/webhooks/shopify/orders' } }];
      return { ok: true, status: 200, json: async () => ({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'w' }, userErrors: [] } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { webhookSubscriptions: { nodes: existing[JSON.parse(opts.body).variables.topics[0]] || [] } } }) };
  };
  assert.deepEqual(await shopify.ensureOrderWebhook('https://x/webhooks/shopify/orders'), { ORDERS_CREATE: 'created', ORDERS_UPDATED: 'created' });
  assert.deepEqual(await shopify.ensureOrderWebhook('https://x/webhooks/shopify/orders'), { ORDERS_CREATE: 'exists', ORDERS_UPDATED: 'exists' });
  assert.equal(created, 2);
});
