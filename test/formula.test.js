// Tests « Changer de formule » (page Mes saveurs), sans réseau : Seal est simulé.
// Lancer : node --test test/
process.env.SEAL_API_TOKEN = 'x';

const test = require('node:test');
const assert = require('node:assert/strict');

const MEN = '55665971560789', CIT = '55665971593557', PAS = '55665971626325';
const M1 = '55725002883413', M2 = '55725002916181', M3 = '55725002948949';

const seal = require('../core/kits/seal');
let SUB; let calls = []; let honorVariantEdit = true; let failAdd = false;
const clone = (x) => JSON.parse(JSON.stringify(x));
seal.getSubscription = async () => clone(SUB);
seal.editSubscription = async (id, edit) => { calls.push(['interval', edit]); Object.assign(SUB, edit); };
seal.editItems = async (id, items) => {
  calls.push(['edit', items]);
  items.forEach((e) => {
    const it = SUB.items.find((x) => x.id === e.id);
    if (e.quantity != null) it.quantity = Number(e.quantity);
    if (e.price != null) it.price = e.price;
    if (e.properties) it.properties = e.properties;
    if (e.variant_id && honorVariantEdit) it.variant_id = e.variant_id;
  });
};
seal.addItems = async (id, items) => {
  calls.push(['add', items]);
  if (failAdd) throw new Error('Seal indisponible');
  items.forEach((it) => SUB.items.push({ id: 500 + SUB.items.length, variant_id: it.variant_id, quantity: Number(it.quantity), price: it.price, properties: it.properties }));
};
seal.removeItems = async (id, ids) => { calls.push(['remove', ids]); SUB.items = SUB.items.filter((it) => !ids.includes(it.id)); };
seal.upsertNotes = async (id, ups) => {
  calls.push(['notes', ups]);
  ups.forEach((u) => { const n = SUB.note_attributes.find((a) => a.name === u.name); if (n) n.value = u.value; else SUB.note_attributes.push({ ...u }); });
};

const { changeFormula, formulaOptions, intervalFor } = require('../core/kits/formula');

const fresh = () => ({
  id: 77, email: 'a@b.fr', delivery_interval: '1 month', billing_interval: '1 month',
  note_attributes: [{ name: 'mymoodz_kit_compo', value: `${M1}|${CIT}:3,${MEN}:1` }, { name: 'mymoodz_kit_seeded', value: '1' }],
  items: [
    { id: 1, variant_id: M1, quantity: 1, price: '49.90', properties: [{ key: '_moodz_compose', value: `${CIT}:3,${MEN}:1` }] },
    { id: 2, variant_id: CIT, quantity: 3, price: '0.00' },
    { id: 3, variant_id: MEN, quantity: 1, price: '0.00' },
  ],
});
const boxes = (v) => SUB.items.filter((it) => it.variant_id === v).reduce((s, b) => s + b.quantity, 0);
const parentLine = () => SUB.items.find((it) => [M1, M2, M3].includes(it.variant_id));

test('formules proposées : prix par jour et économie, formule actuelle repérée', () => {
  const f = formulaOptions(M1);
  assert.deepEqual(f.map((x) => x.boxes), [4, 8, 12]);
  assert.equal(f[0].current, true);
  assert.equal(f[0].perDay, 1.66);
  assert.ok(f[1].savingPct > 0 && f[2].savingPct > f[1].savingPct);
});

test('intervalle : garde l’unité utilisée par Seal', () => {
  assert.equal(intervalFor('1 month', 3), '3 month');
  assert.equal(intervalFor('2 months', 1), '1 months');
  assert.equal(intervalFor(undefined, 2), '2 month');
});

test('1 → 2 mois : fréquence, ligne Recharge à 89,80 €, 8 boîtes avec le même mélange', async () => {
  SUB = fresh(); calls = []; honorVariantEdit = true;
  const r = await changeFormula(clone(SUB), M2);
  assert.equal(r.changed, true);
  assert.equal(SUB.delivery_interval, '2 month');
  assert.equal(SUB.billing_interval, '2 month');
  assert.equal(parentLine().variant_id, M2);
  assert.equal(parentLine().price, '89.80');
  assert.equal(boxes(CIT), 6);
  assert.equal(boxes(MEN), 2);
  assert.equal(SUB.note_attributes.find((a) => a.name === 'mymoodz_kit_compo').value, `${M2}|${MEN}:2,${CIT}:6`);
});

test('Seal refuse de changer la variante sur place → ajout de la nouvelle ligne puis retrait de l’ancienne', async () => {
  SUB = fresh(); calls = []; honorVariantEdit = false;
  await changeFormula(clone(SUB), M3);
  const kinds = calls.map((c) => c[0]);
  assert.ok(kinds.indexOf('add') < kinds.indexOf('remove'), 'on ajoute avant de retirer');
  assert.equal(SUB.items.filter((it) => [M1, M2, M3].includes(it.variant_id)).length, 1);
  assert.equal(parentLine().variant_id, M3);
  assert.equal(boxes(CIT) + boxes(MEN), 12);
  honorVariantEdit = true;
});

test('échec avant le changement de ligne → fréquence remise comme avant, erreur remontée', async () => {
  SUB = fresh(); calls = []; honorVariantEdit = false; failAdd = true;
  await assert.rejects(changeFormula(clone(SUB), M2));
  assert.equal(SUB.delivery_interval, '1 month');
  assert.equal(parentLine().variant_id, M1);
  assert.equal(boxes(CIT), 3);
  honorVariantEdit = true; failAdd = false;
});

test('même formule → rien ne bouge ; ancien ZÉRO ou formule inconnue → refusé', async () => {
  SUB = fresh(); calls = [];
  assert.deepEqual(await changeFormula(clone(SUB), M1), { unchanged: true });
  assert.equal(calls.length, 0);
  await assert.rejects(changeFormula(clone(SUB), '52143295037781'), /pas disponible/);
  await assert.rejects(changeFormula(clone(SUB), PAS), /pas disponible/);
});
