// Tests du portail « Mon abonnement », sans réseau : Seal est simulé.
process.env.SEAL_API_TOKEN = 'x';
process.env.KITS_CUSTOMER_SECRET = 'secret-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const ov = require('../core/portal/overview');
const seal = require('../core/kits/seal');
const actions = require('../core/portal/sealPortal');
const rewards = require('../core/rewards/engine');

const SUB = () => ({
  id: 77, email: 'a@b.fr', status: 'ACTIVE', created_at: '2026-10-01T10:00:00Z',
  items: [{ title: 'Recharge ZÉRO Saveurs', variant_title: '1 Mois', quantity: 1, price: '49.90' },
    { title: 'Boîte ZÉRO', variant_title: 'Citron', quantity: 4, price: '0.00' }],
  billing_attempts: [
    { id: 1, date: '2026-10-31', status: 'completed', order_id: 9 },
    { id: 2, date: '2026-11-30', status: 'scheduled' },
    { id: 3, date: '2026-12-30', status: 'scheduled' },
  ],
});

test('vue : prochaine livraison, contenu, livraisons reçues, progression', () => {
  const s = SUB();
  assert.deepEqual(ov.nextAttempt(s), { id: '2', date: '2026-11-30', skipped: false });
  assert.equal(ov.contenu(s).total, 49.9);
  assert.equal(ov.deliveriesCount(s), 2);
  const pr = ov.progression(s, Date.parse('2026-11-13T10:00:00Z'), ov.loadConfig(), 1);
  assert.equal(pr.jours, 43);
  assert.equal(pr.economies_eur, Math.round(43 * 1 * 12.5));
  assert.equal(ov.shiftDate('2026-11-30', 15), '2026-12-15');
});

function token(email) {
  const payload = Buffer.from(JSON.stringify({ c: 5, e: email, t: Math.floor(Date.now() / 1000) })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', 'secret-test').update(payload).digest('hex');
}

async function call(app, method, path, body, email = 'a@b.fr') {
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(email) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  } finally { srv.close(); }
}

test('actions : décaler de 15 jours, refuser 10 jours, refuser un abonnement qui n\'est pas le sien', async () => {
  let cur = SUB();
  const calls = [];
  seal.getSubscription = async () => JSON.parse(JSON.stringify(cur));
  seal.findSubscriptionsByEmail = async () => [{ id: 77 }];
  actions.reschedule = async (id, att, date) => { calls.push(['reschedule', att, date]); cur.billing_attempts[1].date = date; };
  actions.skip = async (id, att) => { calls.push(['skip', att]); cur.billing_attempts[1].status = 'skipped'; };
  rewards.statusFor = async () => ({ livraisons: 2, depuis: '2026-10-01T10:00:00Z', paliers: [], prochain: null });
  const app = express(); app.use(express.json());
  app.use('/kits/portal', require('../core/portal/portalApi'));

  let r = await call(app, 'POST', '/kits/portal/77/decaler', { jours: 15 });
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0], ['reschedule', '2', '2026-12-15']);
  assert.equal(r.json.abonnement.prochaine_livraison.date, '2026-12-15');

  r = await call(app, 'POST', '/kits/portal/77/decaler', { jours: 10 });
  assert.equal(r.status, 400);

  r = await call(app, 'POST', '/kits/portal/77/sauter', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.abonnement.prochaine_livraison.skipped, true);

  r = await call(app, 'POST', '/kits/portal/77/sauter', {}, 'autre@x.fr');
  assert.equal(r.status, 404);

  r = await call(app, 'GET', '/kits/portal/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.abonnements.length, 1);
  assert.equal(r.json.fidelite.livraisons, 2);

  // Seal sans date de début : les jours viennent de la 1re commande d'abonnement
  cur = SUB(); delete cur.created_at;
  r = await call(app, 'GET', '/kits/portal/overview');
  assert.ok(r.json.abonnements[0].progression.jours >= 43);
});
