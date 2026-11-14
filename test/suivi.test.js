// Tests de « Suivre ma commande », sans réseau : Shopify est simulé.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const shopify = require('../core/kits/shopify');
const { transporteurDe, normaliserNumero } = require('../core/suivi/transporteurs');
const suivi = require('../core/suivi/suiviApi');

const ORDER = () => ({
  name: '#6224969', createdAt: '2026-11-13T11:03:23Z', email: 'Client@Exemple.fr', cancelledAt: null,
  displayFulfillmentStatus: 'FULFILLED', customer: { email: 'client@exemple.fr' },
  fulfillments: [
    { createdAt: '2026-11-13T15:00:00Z', status: 'SUCCESS',
      trackingInfo: [{ company: 'La Poste Colissimo', number: '87001511994584O', url: 'https://www.laposte.fr/particulier/outils/suivre-vos-envois?code=87001511994584O' }] },
    { createdAt: '2026-11-13T15:00:01Z', status: 'SUCCESS', trackingInfo: [] },
  ],
});

test('transporteur : celui de Shopify en priorité, avec son lien', () => {
  const t = transporteurDe('La Poste Colissimo', '8J02327047157', 'https://www.laposte.fr/x?code=8J02327047157');
  assert.equal(t.code17, 6051);
  assert.equal(t.transporteur, 'La Poste');
  assert.equal(t.lien, 'https://www.laposte.fr/x?code=8J02327047157');
});

test('transporteur : numéros La Poste reconnus sans Shopify (dont les « 870… » que 17TRACK prend pour du FedEx)', () => {
  for (const n of ['870015037865440', '87001511227699R', '8J02327047157', 'LA123456789FR']) {
    const t = transporteurDe('', n);
    assert.equal(t.code17, 6051, n);
    assert.match(t.lien, /^https:\/\/www\.laposte\.fr\//);
  }
});

test('transporteur : GOFO, Chronopost, Mondial Relay ; inconnu = le widget devine', () => {
  assert.equal(transporteurDe('GOFO Express', 'GF123456789').code17, 191150);
  assert.match(transporteurDe('GOFO Express', 'GF123456789').lien, /17track/); // pas de lien GOFO connu → page 17TRACK
  assert.equal(transporteurDe('Chronopost', 'XY123456789JF').code17, 100273);
  assert.equal(transporteurDe('Mondial Relay', '12345678').code17, 100304);
  const inconnu = transporteurDe('', 'ABC12345678');
  assert.equal(inconnu.code17, 0);
  assert.match(inconnu.lien, /^https:\/\/t\.17track\.net\/fr#nums=ABC12345678$/);
  // un lien Shopify qui n'est pas en https n'est jamais renvoyé
  assert.doesNotMatch(transporteurDe('', 'ABC12345678', 'javascript:alert(1)').lien, /javascript/);
});

test('numéro : nettoyé, ou refusé s\'il n\'a pas une forme plausible', () => {
  assert.equal(normaliserNumero(' 8j0 2327-047157 '), '8J02327047157');
  assert.equal(normaliserNumero('abc'), '');
  assert.equal(normaliserNumero('<script>alert(1)</script>'), '');
});

test('vue commande : envois dédoublonnés, expéditions annulées ignorées, rien de personnel', () => {
  const o = ORDER();
  o.fulfillments.push({ createdAt: '2026-11-14T10:00:00Z', status: 'SUCCESS', trackingInfo: [{ company: 'La Poste Colissimo', number: '87001511994584O' }] });
  o.fulfillments.push({ createdAt: '2026-11-14T10:00:00Z', status: 'CANCELLED', trackingInfo: [{ company: 'GOFO', number: 'GF999999999' }] });
  const v = suivi.vueCommande(o);
  assert.equal(v.statut, 'expediee');
  assert.equal(v.envois.length, 1);
  assert.deepEqual(v.envois[0], {
    transporteur: 'La Poste', code17: 6051, numero: '87001511994584O',
    lien: 'https://www.laposte.fr/particulier/outils/suivre-vos-envois?code=87001511994584O', expedieLe: '2026-11-13',
  });
  assert.deepEqual(Object.keys(v).sort(), ['commande', 'envois', 'passeeLe', 'statut']);
});

test('vue commande : en préparation, expédiée sans suivi, partielle, annulée', () => {
  const sans = { ...ORDER(), fulfillments: [] , displayFulfillmentStatus: 'UNFULFILLED' };
  assert.equal(suivi.vueCommande(sans).statut, 'en_preparation');
  assert.equal(suivi.vueCommande({ ...sans, displayFulfillmentStatus: 'FULFILLED' }).statut, 'expediee_sans_suivi');
  assert.equal(suivi.vueCommande({ ...ORDER(), displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }).statut, 'partielle');
  assert.equal(suivi.vueCommande({ ...ORDER(), cancelledAt: '2026-11-14T00:00:00Z' }).statut, 'annulee');
});

// ---------- Routes HTTP ----------
function serveur() {
  const app = express();
  app.use(express.json());
  app.use('/kits/suivi', suivi);
  return http.createServer(app).listen(0);
}
const appel = async (srv, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};

test('routes : commande + e-mail, sans # et sans tenir compte des majuscules', async (t) => {
  const vues = [];
  t.mock.method(shopify, 'graphql', async (q, vars) => { vues.push(vars.q); return { orders: { nodes: [ORDER()] } }; });
  const srv = serveur();
  try {
    const ok = await appel(srv, 'POST', '/kits/suivi/commande', { commande: '6224969', email: ' CLIENT@exemple.FR ' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.statut, 'expediee');
    assert.equal(ok.json.envois[0].code17, 6051);
    assert.equal(JSON.stringify(ok.json).includes('@'), false, 'aucun e-mail dans la réponse');
    assert.deepEqual(vues, ['name:#6224969']);

    const mauvais = await appel(srv, 'POST', '/kits/suivi/commande', { commande: '#6224969', email: 'autre@exemple.fr' });
    assert.equal(mauvais.status, 404);
    assert.deepEqual(mauvais.json, { ok: false, error: 'introuvable' });

    // e-mail invalide : refusé sans interroger Shopify
    const n = vues.length;
    const invalide = await appel(srv, 'POST', '/kits/suivi/commande', { commande: '6224969', email: 'pas-un-email' });
    assert.equal(invalide.status, 404);
    assert.equal(vues.length, n);
  } finally { srv.close(); }
});

test('routes : une commande voisine (même début de numéro) n\'est jamais renvoyée', async (t) => {
  t.mock.method(shopify, 'graphql', async () => ({ orders: { nodes: [{ ...ORDER(), name: '#62249690' }] } }));
  const srv = serveur();
  try {
    const r = await appel(srv, 'POST', '/kits/suivi/commande', { commande: '6224969', email: 'client@exemple.fr' });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});

test('routes : Shopify indisponible → 502, numéro seul → transporteur', async (t) => {
  t.mock.method(shopify, 'graphql', async () => { throw new Error('panne'); });
  const srv = serveur();
  try {
    const panne = await appel(srv, 'POST', '/kits/suivi/commande', { commande: '1234567', email: 'a@b.fr' });
    assert.equal(panne.status, 502);
    const num = await appel(srv, 'GET', '/kits/suivi/numero/870015037865440');
    assert.equal(num.status, 200);
    assert.equal(num.json.envoi.code17, 6051);
    const bad = await appel(srv, 'GET', '/kits/suivi/numero/x');
    assert.equal(bad.status, 400);
  } finally { srv.close(); }
});

test('routes : recherche par commande limitée à 12 essais / 10 min par adresse', async (t) => {
  t.mock.method(shopify, 'graphql', async () => ({ orders: { nodes: [] } }));
  const srv = serveur();
  try {
    let dernier;
    for (let i = 0; i < 13; i++) dernier = await appel(srv, 'POST', '/kits/suivi/commande', { commande: String(1000 + i), email: 'a@b.fr' });
    assert.equal(dernier.status, 429);
  } finally { srv.close(); }
});
