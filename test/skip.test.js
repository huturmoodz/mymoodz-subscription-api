// Livraison sautée : reconnue quelle que soit la forme renvoyée par Seal (non documentée).
const test = require('node:test');
const assert = require('node:assert/strict');
const ov = require('../core/portal/overview');

const base = { id: 2, date: '2026-12-10T12:00:00+00:00', completed_at: '', status: '', order_id: '', error_code: '', triggered_manually: '' };

test('échéance sautée : toutes les formes plausibles reconnues', () => {
  for (const extra of [
    { status: 'skipped' }, { status: 'SKIPPED' }, { skipped: true }, { skipped: 1 }, { skipped: '1' },
    { skipped: 'true' }, { is_skipped: '1' }, { skipped_at: '2026-11-13 15:00:00' }, { skip: 'yes' },
  ]) {
    assert.equal(ov.isSkipped({ ...base, ...extra }), true, JSON.stringify(extra));
  }
});

test('échéance normale : jamais prise pour une échéance sautée', () => {
  for (const extra of [{}, { skipped: '' }, { skipped: '0' }, { skipped: false }, { skipped: 0 }, { skipped_at: '' }, { skipped_at: null }]) {
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
