// core/kits/customerAuth.js
// Preuve d'identité du client connecté, sans app proxy :
// la page « Mes saveurs » (Liquid, côté serveur Shopify) signe { id client, e-mail, horodatage }
// avec un secret partagé. Le navigateur ne connaît pas le secret et ne peut donc pas fabriquer
// un jeton pour un autre client. Le serveur vérifie la signature et la fraîcheur du jeton.
//
// Liquid correspondant (snippet du thème) :
//   {%- assign mmz_payload = '{"c":' | append: customer.id | append: ',"e":"' | append: customer.email
//        | append: '","t":' | append: now_ts | append: '}' | base64_url_safe_encode -%}
//   {%- assign mmz_sig = mmz_payload | hmac_sha256: settings.mmz_kits_secret -%}
//   jeton = mmz_payload + "." + mmz_sig

const crypto = require('crypto');

const SECRET = process.env.KITS_CUSTOMER_SECRET;
const MAX_AGE_S = Number(process.env.KITS_TOKEN_MAX_AGE_S || 6 * 3600);

function b64urlDecode(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

function verifyCustomerToken(token) {
  if (!SECRET) throw new Error('KITS_CUSTOMER_SECRET manquant');
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(payload));
  } catch (e) {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - Number(data.t);
  if (!Number.isFinite(age) || age < -300 || age > MAX_AGE_S) return null;
  if (!data.c || !data.e) return null;
  return { customerId: String(data.c), email: String(data.e).trim().toLowerCase() };
}

/** Middleware Express : exige un jeton valide (en-tête Authorization: Bearer …). */
function requireCustomer(req, res, next) {
  try {
    const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const who = verifyCustomerToken(raw);
    if (!who) return res.status(401).json({ ok: false, error: 'Session expirée, rechargez la page.' });
    req.customer = who;
    return next();
  } catch (e) {
    console.error('[kits/auth]', e.message);
    return res.status(500).json({ ok: false, error: 'Configuration serveur incomplète.' });
  }
}

module.exports = { verifyCustomerToken, requireCustomer };
