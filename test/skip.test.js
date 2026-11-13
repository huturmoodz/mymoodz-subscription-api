// Livraison sautée : reconnue quelle que soit la forme renvoyée par Seal (non documentée).
const test = require('node:test');
const assert = require('node:assert/strict');
const ov = require('../core/portal/overview');

const base = { id: 2, date: '2026-12-10T12:00:00+00:00', completed_at: '', status: '', order_id: '', error_code: '', triggered_manually: '' };

test('échéance sautée : toutes les formes plausibles reconnues', () => {
  for (const extra of [
    { status: 'skipped' }, { status: 'SKIPPED' }, { skipped: true }, { skipped: 1 }, { skipped: '1' },
    { skipped: 'true' }, { is_skipped: '1' }, { skipped_at: '2026-11-13 15:00:00' }, { skip: 'yes' },
    { skipped_on: '2026-11-13 14:00:08' },   // forme réelle renvoyée par Seal (logs Render du 13/11)
  ]) {
    assert.equal(ov.isSkipped({ ...base, ...extra }), true, JSON.stringify(extra));
  }
});

test('échéance normale : jamais prise pour une échéance sautée', () => {
  for (const extra of [{}, { skipped: '' }, { skipped: '0' }, { skipped: false }, { skipped: 0 }, { skipped_at: '' }, { skipped_at: null }, { skipped_on: null }]) {
    assert.equal(ov.isSkipped({ ...base, ...extra }), false, JSON.stringify(extra));
  }
});

test('prochaine livraison sautée : signalée comme telle (le portail propose « Reprendre »)', () => {
  const sub = { billing_attempts: [
    { ...base, id: 1, date: '2026-11-10T12:00:00+00:00', status: 'completed', order_id: '9' },
    { ...base, id: 2, skipped: '1' },
    { ...base, id: 3, date: '2027-01-10T12:00:00+00:00' },
  ] };
  assert.deepEqual(ov.nextAttempt(sub), { id: '2', date: '2026-12-10T12:00:00+00:00', skipped: true });
});

test('décaler : Seal reçoit date + heure + fuseau (sans heure, Seal refuse : « Time is missing »)', () => {
  assert.deepEqual(ov.shiftSlot('2026-12-10T11:00:00+00:00', 7), { date: '2026-12-17', time: '11:00', timezone: '+00:00' });
  assert.deepEqual(ov.shiftSlot('2026-12-28T23:30:00+00:00', 7), { date: '2027-01-04', time: '23:30', timezone: '+00:00' });
  assert.deepEqual(ov.shiftSlot('2026-11-30', 15), { date: '2026-12-15', time: '12:00', timezone: '+00:00' });
  assert.equal(ov.shiftSlot('pas une date', 7), null);
});
