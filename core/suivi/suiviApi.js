// core/suivi/suiviApi.js
// Page « Suivre ma commande » : retrouve l'envoi d'un client, sans compte ni connexion.
//  - GET  /kits/suivi/numero/:numero      → transporteur + lien, à partir du seul numéro de suivi
//  - POST /kits/suivi/commande {commande, email} → commande Shopify (le n° ET l'e-mail d'achat doivent
//    correspondre), ses envois et leur transporteur.
// Les étapes de livraison elles-mêmes sont affichées par le widget 17TRACK dans la page, avec le code
// transporteur renvoyé ici. Rien de personnel n'est renvoyé (ni adresse, ni nom, ni contenu).

const express = require('express');
const shopify = require('../kits/shopify');
const { transporteurDe, normaliserNumero } = require('./transporteurs');

const router = express.Router();

// Limites par adresse IP sur 10 minutes. La recherche par commande est plus stricte (anti-essais en série).
const hits = new Map();
const limite = (cle, max) => (req, res, next) => {
  const now = Date.now();
  const k = `${cle}:${req.ip}`;
  const arr = (hits.get(k) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(k, arr);
  if (arr.length > max) return res.status(429).json({ ok: false, error: 'trop_de_requetes' });
  return next();
};
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 10 * 60 * 1000)) hits.delete(k);
}, 15 * 60 * 1000).unref();

const ORDER_QUERY = `query($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      name createdAt email cancelledAt displayFulfillmentStatus
      customer { email }
      fulfillments(first: 10) { createdAt status trackingInfo(first: 5) { company number url } }
    }
  }
}`;

const jour = (iso) => String(iso || '').slice(0, 10) || null;

/** Vue publique d'une commande Shopify : statut et envois, rien d'autre. */
function vueCommande(o) {
  const vus = new Set();
  const envois = [];
  for (const f of o.fulfillments || []) {
    if (['CANCELLED', 'ERROR', 'FAILURE'].includes(f.status)) continue;
    for (const t of f.trackingInfo || []) {
      const numero = normaliserNumero(t.number);
      if (!numero || vus.has(numero)) continue;
      vus.add(numero);
      envois.push({ ...transporteurDe(t.company, numero, t.url), expedieLe: jour(f.createdAt) });
    }
  }
  let statut = 'en_preparation';
  if (o.cancelledAt) statut = 'annulee';
  else if (envois.length) statut = o.displayFulfillmentStatus === 'PARTIALLY_FULFILLED' ? 'partielle' : 'expediee';
  else if (o.displayFulfillmentStatus === 'FULFILLED') statut = 'expediee_sans_suivi';
  return { commande: o.name, passeeLe: jour(o.createdAt), statut, envois };
}

/** Commande dont le numéro ET l'e-mail correspondent, sinon null. */
async function trouverCommande(commande, email) {
  const chiffres = String(commande || '').replace(/\D/g, '');
  const mail = String(email || '').trim().toLowerCase();
  if (chiffres.length < 3 || chiffres.length > 15 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return null;
  const nom = `#${chiffres}`;
  const data = await shopify.graphql(ORDER_QUERY, { q: `name:${nom}` });
  const o = (data?.orders?.nodes || []).find((x) => x.name === nom);
  if (!o) return null;
  const emails = [o.email, o.customer?.email].map((e) => String(e || '').trim().toLowerCase());
  return emails.includes(mail) ? o : null;
}

router.get('/numero/:numero', limite('numero', 40), (req, res) => {
  const numero = normaliserNumero(req.params.numero);
  if (!numero) return res.status(400).json({ ok: false, error: 'numero_invalide' });
  return res.json({ ok: true, envoi: transporteurDe('', numero) });
});

router.post('/commande', limite('commande', 12), async (req, res) => {
  try {
    const o = await trouverCommande(req.body?.commande, req.body?.email);
    if (!o) return res.status(404).json({ ok: false, error: 'introuvable' });
    return res.json({ ok: true, ...vueCommande(o) });
  } catch (e) {
    console.error('[suivi] commande', e.message);
    return res.status(502).json({ ok: false, error: 'indisponible' });
  }
});

module.exports = router;
module.exports.vueCommande = vueCommande;
module.exports.trouverCommande = trouverCommande;
