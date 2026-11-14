// Tests « Modifier l'adresse » du portail, sans réseau : Seal est simulé.
process.env.SEAL_API_TOKEN = 'x';
process.env.KITS_CUSTOMER_SECRET = 'secret-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const seal = require('../core/kits/seal');
const adresse = require('../core/portal/adresse');

const SUB = () => ({
  id: 77, email: 'a@b.fr', status: 'ACTIVE', created_at: '2026-10-01T10:00:00Z',
  s_first_name: 'Jeanne', s_last_name: 'Martin', s_company: '', s_address1: '12 rue des Lilas', s_address2: '',
  s_zip: '69003', s_city: 'Lyon', s_country: 'France', s_country_code: 'FR', s_phone: '',
  items: [{ title: 'Recharge ZÉRO Saveurs', variant_title: '1 Mois', quantity: 1, price: '49.90' }],
  billing_attempts: [{ id: 2, date: '2030-01-10', status: 'scheduled' }],
});
const OK = { prenom: 'Jeanne', nom: 'Martin', adresse1: '3 place Bellecour', adresse2: 'Bât. B', cp: '69002', ville: 'Lyon', telephone: '06 12 34 56 78' };

test('validation : adresse correcte → champs Seal, pays inchangé', () => {
  const r = adresse.valider(OK, SUB());
  assert.equal(r.refus, undefined);
  assert.deepEqual(r.edit, {
    s_first_name: 'Jeanne', s_last_name: 'Martin', s_company: '', s_address1: '3 place Bellecour', s_address2: 'Bât. B',
    s_zip: '69002', s_city: 'Lyon', s_phone: '06 12 34 56 78',
    // Seal exige le pays à chaque changement d'adresse : celui de l'abonnement, inchangé
    s_country: 'France', s_country_code: 'FR', s_province: '', s_province_code: '',
  });
  // Même si le client envoie un autre pays, il est ignoré
  assert.equal(adresse.valider({ ...OK, pays: 'Belgique', pays_code: 'BE' }, SUB()).edit.s_country_code, 'FR');
});

test('validation : champs manquants, code postal français, téléphone, texte nettoyé', () => {
  assert.match(adresse.valider({ ...OK, nom: '' }, SUB()).refus, /prénom et le nom/);
  assert.match(adresse.valider({ ...OK, adresse1: 'a' }, SUB()).refus, /adresse/);
  assert.match(adresse.valider({ ...OK, ville: '' }, SUB()).refus, /ville/);
  assert.match(adresse.valider({ ...OK, cp: '6900' }, SUB()).refus, /code postal/);
  assert.match(adresse.valider({ ...OK, telephone: 'appelle-moi' }, SUB()).refus, /téléphone/);
  const be = { ...SUB(), s_country: 'Belgique', s_country_code: 'BE' };
  assert.equal(adresse.valider({ ...OK, cp: '1000' }, be).refus, undefined);
  const r = adresse.valider({ ...OK, adresse1: '  3   place <b>Bellecour</b>\n' }, SUB());
  assert.equal(r.edit.s_address1, '3 place b Bellecour /b');
});

test('champs : pré-remplissage depuis Seal', () => {
  assert.deepEqual(adresse.champs(SUB()), {
    prenom: 'Jeanne', nom: 'Martin', societe: '', adresse1: '12 rue des Lilas', adresse2: '', cp: '69003', ville: 'Lyon',
    telephone: '', pays: 'France', pays_code: 'FR',
  });
});

function token(email) {
  const payload = Buffer.from(JSON.stringify({ c: 5, e: email, t: Math.floor(Date.now() / 1000) })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', 'secret-test').update(payload).digest('hex');
}
async function call(app, path, body, email = 'a@b.fr') {
  const srv = http.createServer(app).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(email) }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  } finally { srv.close(); }
}

test('route : enregistre dans Seal et renvoie la vue à jour ; refuse si invalide, résilié ou pas le sien', async () => {
  let cur = SUB();
  const edits = [];
  seal.getSubscription = async () => JSON.parse(JSON.stringify(cur));
  seal.editSubscription = async (id, edit) => { edits.push([String(id), edit]); Object.assign(cur, edit); };
  const app = express(); app.use(express.json());
  app.use('/kits/portal', require('../core/portal/portalApi'));

  let r = await call(app, '/kits/portal/77/adresse', OK);
  assert.equal(r.status, 200);
  assert.equal(edits.length, 1);
  assert.equal(edits[0][1].s_address1, '3 place Bellecour');
  assert.deepEqual(r.json.abonnement.adresse.lignes, ['3 place Bellecour', 'Bât. B']);
  assert.equal(r.json.abonnement.adresse_champs.cp, '69002');

  r = await call(app, '/kits/portal/77/adresse', { ...OK, cp: '12' });
  assert.equal(r.status, 400);
  assert.equal(edits.length, 1);

  r = await call(app, '/kits/portal/77/adresse', OK, 'autre@x.fr');
  assert.equal(r.status, 404);

  cur.status = 'CANCELLED';
  r = await call(app, '/kits/portal/77/adresse', OK);
  assert.equal(r.status, 400);
  assert.equal(edits.length, 1);
});
