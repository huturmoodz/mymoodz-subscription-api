// Changements de mélange et de formule face à un Seal « réaliste », sans réseau :
//  - après un retrait de ligne, Seal renumérote les lignes restantes ;
//  - une modification qui vise une ligne inconnue est ignorée SANS erreur (comme le vrai Seal).
// Rejoue la séquence du 13/11 qui laissait 2 Menthe au lieu de 4 dans le contrat.
process.env.SEAL_API_TOKEN = 'x';

const test = require('node:test');
const assert = require('node:assert/strict');

const seal = require('../core/kits/seal');
const { applyToSubscription, currentBoxMap, analyse, syncSubscription } = require('../core/kits/subscriptionKit');
const { changeFormula } = require('../core/kits/formula');
const { parseComposition } = require('../core/kits/composition');

const MEN = '55665971560789', CIT = '55665971593557';
const M1 = '55725002883413', M2 = '55725002916181', M3 = '55725002948949';

let SUB;
let nextId;
let flaky = 0;          // nombre de modifications à « perdre » (Seal qui ne prend pas en compte)
let calls = [];

function reset() {
  nextId = 100;
  flaky = 0;
  calls = [];
  SUB = {
    id: 1, email: 'a@b.fr', status: 'ACTIVE', delivery_interval: '1 month', billing_interval: '1 month',
    note_attributes: [{ name: 'mymoodz_kit_compo', value: `${M1}|${MEN}:4` }, { name: 'mymoodz_kit_seeded', value: '1' }],
    items: [
      { id: 10, variant_id: M1, quantity: 1, price: '49.90', properties: [] },
      { id: 11, variant_id: MEN, quantity: 4, price: '0.00', properties: [] },
    ],
  };
}

seal.getSubscription = async () => JSON.parse(JSON.stringify(SUB));
seal.editSubscription = async (id, edit) => { calls.push('freq'); Object.assign(SUB, edit); };
seal.editItems = async (id, items) => {
  calls.push('edit');
  for (const e of items) {
    if (flaky > 0) { flaky -= 1; continue; }
    const it = SUB.items.find((x) => x.id === Number(e.id));
    if (!it) continue;                       // ligne inconnue : ignorée sans erreur
    if (e.quantity !== undefined) it.quantity = Number(e.quantity);
    if (e.variant_id) it.variant_id = String(e.variant_id);
    if (e.properties) it.properties = e.properties;
    if (e.price !== undefined) it.price = e.price;
  }
};
seal.addItems = async (id, items) => {
  calls.push('add');
  items.forEach((it) => SUB.items.push({ id: nextId++, variant_id: String(it.variant_id), quantity: Number(it.quantity), price: it.price, properties: it.properties || [] }));
};
seal.removeItems = async (id, ids) => {
  calls.push('remove');
  SUB.items = SUB.items.filter((it) => !ids.map(Number).includes(it.id));
  SUB.items.forEach((it) => { it.id = nextId++; });   // renumérotation
};
seal.upsertNotes = async (id, ups) => {
  calls.push('notes');
  for (const u of ups) {
    const n = SUB.note_attributes.find((a) => a.name === u.name);
    if (n) n.value = u.value; else SUB.note_attributes.push({ ...u });
  }
};

const boxes = () => Object.fromEntries(currentBoxMap(analyse(SUB).boxes));
const note = () => SUB.note_attributes.find((a) => a.name === 'mymoodz_kit_compo').value;

test('2 Menthe + 2 Citron → 4 Menthe : le contrat a bien 4 Menthe (bug du 13/11)', async () => {
  reset();
  await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:2,${CIT}:2`));
  assert.deepEqual(boxes(), { [MEN]: 2, [CIT]: 2 });
  await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:4`));
  assert.deepEqual(boxes(), { [MEN]: 4 });
  assert.equal(note(), `${M1}|${MEN}:4`);
});

test('séquence complète : 1 → 2 → 3 → 1 mois, mix, retour au mix d\'origine', async () => {
  reset();
  await changeFormula(await seal.getSubscription(1), M2);
  assert.deepEqual(boxes(), { [MEN]: 8 });
  await changeFormula(await seal.getSubscription(1), M3);
  assert.deepEqual(boxes(), { [MEN]: 12 });
  await changeFormula(await seal.getSubscription(1), M1);
  assert.deepEqual(boxes(), { [MEN]: 4 });
  assert.equal(SUB.delivery_interval, '1 month');
  await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:2,${CIT}:2`));
  await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:4`));
  assert.deepEqual(boxes(), { [MEN]: 4 });
  // Le webhook « abonnement modifié » qui suit ne refait rien
  calls = [];
  await syncSubscription(1);
  assert.deepEqual(calls, []);
});

test('Seal perd une modification : un 2e passage corrige, le client voit le bon résultat', async () => {
  reset();
  flaky = 1;
  const r = await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:1,${CIT}:3`));
  assert.deepEqual(boxes(), { [MEN]: 1, [CIT]: 3 });
  assert.equal(r.changed, true);
});

test('Seal refuse tout : erreur remontée, la note n\'est PAS écrite (le webhook remettra l\'ancien mélange)', async () => {
  reset();
  flaky = 1000;
  const before = note();
  await assert.rejects(applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:3,${CIT}:1`)), /non alignées/);
  assert.equal(note(), before);
  flaky = 0;
});

test('mélange déjà en place : aucun appel à Seal', async () => {
  reset();
  SUB.items[0].properties = [{ key: '_moodz_compose', value: `${MEN}:4` }];   // libellé déjà à jour
  calls = [];
  const r = await applyToSubscription(await seal.getSubscription(1), parseComposition(`${MEN}:4`));
  assert.equal(r.changed, false);
  assert.deepEqual(calls, []);
});
