// core/portal/sealPortal.js
// Actions Seal propres au portail abonné (décaler, sauter, recevoir maintenant, pause).
// Réutilise le client HTTP Seal des kits, sans modifier ce module.

const { callSeal } = require('../kits/seal');

const putAttempt = (body) => callSeal('/subscription-billing-attempt', { method: 'PUT', body: JSON.stringify(body) });

// Seal exige l'heure et le fuseau en plus de la date (sinon « Time is missing »).
// resetSchedule : Seal recrée les échéances suivantes à partir de cette nouvelle date (option documentée).
const reschedule = (subId, attemptId, isoDate, time = '12:00', timezone = '+00:00', resetSchedule = false) =>
  putAttempt({
    id: Number(attemptId), subscription_id: Number(subId), date: isoDate, time, timezone, action: 'reschedule',
    ...(resetSchedule ? { reset_schedule: 'true' } : {}),
  });
const skip = (subId, attemptId) => putAttempt({ id: Number(attemptId), subscription_id: Number(subId), action: 'skip' });
const unskip = (subId, attemptId) => putAttempt({ id: Number(attemptId), subscription_id: Number(subId), action: 'unskip' });
const processNow = (subId, attemptId) =>
  callSeal('/subscription-process-charge', { method: 'PUT', body: JSON.stringify({ subscription_id: Number(subId), billing_attempt_id: Number(attemptId) }) });
const setStatus = (subId, action) => callSeal('/subscription', { method: 'PUT', body: JSON.stringify({ id: Number(subId), action }) });

module.exports = { reschedule, skip, unskip, processNow, pause: (id) => setStatus(id, 'pause'), resume: (id) => setStatus(id, 'resume') };
