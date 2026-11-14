// core/suivi/transporteurs.js
// Reconnaît le transporteur d'un envoi et donne :
//  - son code 17TRACK (le widget de suivi de la page « Suivre ma commande » l'utilise
//    au lieu de deviner : il prend par exemple les numéros La Poste « 870… » pour du FedEx) ;
//  - le lien de suivi sur le site du transporteur (secours si le widget échoue).
// Source préférée : le transporteur inscrit sur l'expédition Shopify. Sinon, la forme du numéro.
// Codes 17TRACK : liste publique res.17track.net/asset/carrier/info/apicarrier.all.json

const enc = encodeURIComponent;

const TRANSPORTEURS = [
  { id: 'laposte', nom: 'La Poste', code17: 6051, motif: /colissimo|la ?poste|lettre suivie/i,
    lien: (n) => `https://www.laposte.fr/outils/suivre-vos-envois?code=${enc(n)}` },
  { id: 'chronopost', nom: 'Chronopost', code17: 100273, motif: /chronopost/i,
    lien: (n) => `https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT=${enc(n)}` },
  { id: 'mondialrelay', nom: 'Mondial Relay', code17: 100304, motif: /mondial ?relay/i,
    lien: (n) => `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${enc(n)}` },
  { id: 'gofo', nom: 'GOFO', code17: 191150, motif: /gofo/i, lien: null },
  { id: 'colisprive', nom: 'Colis Privé', code17: 100027, motif: /colis ?priv/i,
    lien: (n) => `https://www.colisprive.com/moncolis/pages/detailColis.aspx?numColis=${enc(n)}` },
  { id: 'dpd', nom: 'DPD', code17: 100072, motif: /\bdpd\b/i, lien: (n) => `https://trace.dpd.fr/fr/trace/${enc(n)}` },
  { id: 'gls', nom: 'GLS', code17: 101272, motif: /\bgls\b/i, lien: (n) => `https://gls-group.com/FR/fr/suivi-colis?match=${enc(n)}` },
  { id: 'ups', nom: 'UPS', code17: 100002, motif: /\bups\b/i, lien: (n) => `https://www.ups.com/track?loc=fr_FR&tracknum=${enc(n)}` },
  { id: 'dhl', nom: 'DHL', code17: 100001, motif: /\bdhl\b/i, lien: (n) => `https://www.dhl.com/fr-fr/home/tracking.html?tracking-id=${enc(n)}` },
  { id: 'fedex', nom: 'FedEx', code17: 100003, motif: /fedex/i, lien: (n) => `https://www.fedex.com/fedextrack/?trknbr=${enc(n)}` },
];

// Formes de numéros La Poste (Colissimo, lettre suivie, international « S10 » se terminant par FR)
const FORMES_LAPOSTE = [
  /^\d[A-Z]\d{11}$/,          // 8J02327047157, 6A…, 1L… (Colissimo, lettre suivie)
  /^87\d{12}[0-9A-Z]$/,       // 870015112277010, 87001511227699R (envois suivis)
  /^[A-Z]{2}\d{9}FR$/,        // international / recommandé
];

/** Numéro de suivi nettoyé : majuscules, sans espaces ni tirets. Vide s'il n'a pas une forme plausible. */
function normaliserNumero(brut) {
  const n = String(brut || '').toUpperCase().replace(/[\s\-.]/g, '');
  return /^[A-Z0-9]{8,40}$/.test(n) ? n : '';
}

const lien17 = (n) => `https://t.17track.net/fr#nums=${enc(n)}`;

/**
 * Transporteur d'un envoi.
 * @param {string} societe  transporteur inscrit sur l'expédition Shopify (peut être vide)
 * @param {string} numero   numéro de suivi normalisé
 * @param {string} [url]    lien de suivi enregistré dans Shopify (prioritaire pour le secours)
 */
function transporteurDe(societe, numero, url) {
  let t = societe ? TRANSPORTEURS.find((x) => x.motif.test(societe)) : null;
  if (!t && FORMES_LAPOSTE.some((re) => re.test(numero))) t = TRANSPORTEURS[0];
  const lienShopify = /^https:\/\//.test(String(url || '')) ? String(url) : '';
  return {
    transporteur: t ? t.nom : (societe || ''),
    code17: t ? t.code17 : 0, // 0 = le widget devine
    numero,
    lien: lienShopify || (t && t.lien ? t.lien(numero) : lien17(numero)),
  };
}

module.exports = { transporteurDe, normaliserNumero, TRANSPORTEURS };
