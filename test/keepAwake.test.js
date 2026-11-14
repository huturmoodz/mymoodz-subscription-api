// Tests du réveil du serveur (plage horaire à l'heure de Paris).
const test = require('node:test');
const assert = require('node:assert/strict');
const { actif, plage, start } = require('../core/keepAwake');

test('plage : 7 h à minuit par défaut, réglable, valeurs absurdes ignorées', () => {
  assert.deepEqual(plage(''), { debut: 7, fin: 24 });
  assert.deepEqual(plage('8-22'), { debut: 8, fin: 22 });
  assert.deepEqual(plage('22-8'), { debut: 7, fin: 24 });
  assert.deepEqual(plage('n importe quoi'), { debut: 7, fin: 24 });
});

test('heure de Paris : hiver (UTC+1) et été (UTC+2)', () => {
  const p = { debut: 7, fin: 24 };
  // Hiver : 05:59 UTC = 06:59 Paris → endormi ; 06:00 UTC = 07:00 Paris → éveillé
  assert.equal(actif(new Date('2026-11-14T05:59:00Z'), p), false);
  assert.equal(actif(new Date('2026-11-14T06:00:00Z'), p), true);
  // 22:59 UTC = 23:59 Paris → éveillé ; 23:00 UTC = minuit → endormi
  assert.equal(actif(new Date('2026-11-14T22:59:00Z'), p), true);
  assert.equal(actif(new Date('2026-11-14T23:00:00Z'), p), false);
  // Été : 05:00 UTC = 07:00 Paris → éveillé
  assert.equal(actif(new Date('2026-07-14T05:00:00Z'), p), true);
  assert.equal(actif(new Date('2026-07-14T04:59:00Z'), p), false);
});

test('ne démarre que sur Render (ou KEEP_AWAKE=true), jamais avec KEEP_AWAKE=false', () => {
  const save = { RENDER: process.env.RENDER, KEEP_AWAKE: process.env.KEEP_AWAKE };
  try {
    delete process.env.RENDER; delete process.env.KEEP_AWAKE;
    assert.equal(start('https://x.test'), null);
    process.env.RENDER = 'true'; process.env.KEEP_AWAKE = 'false';
    assert.equal(start('https://x.test'), null);
    process.env.KEEP_AWAKE = '';
    const t = start('https://x.test');
    assert.ok(t);
    clearInterval(t);
  } finally {
    for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
