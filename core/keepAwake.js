// core/keepAwake.js
// Garde le serveur éveillé en journée sur l'offre gratuite de Render (mise en veille après 15 min
// sans visite, puis 30 à 60 s de réveil pour le visiteur suivant).
// Toutes les 10 min, de 7 h à minuit (heure de Paris), le serveur appelle sa propre adresse publique.
// La nuit, il peut s'endormir : ~530 h/mois au lieu de ~744 h, pour rester loin des 750 h gratuites
// (les dépasser ferait couper le service par Render jusqu'à la fin du mois).
// Le matin, la première visite, le premier webhook ou la tâche GitHub « Réveil serveur Render » le relance.
// Réglages : KEEP_AWAKE=false pour couper ; KEEP_AWAKE_HOURS=7-24 pour changer la plage.

const HEURE_PARIS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' });
const heureParis = (date) => Number(HEURE_PARIS.formatToParts(date).find((x) => x.type === 'hour').value);

/** Plage horaire « 7-24 » → { debut: 7, fin: 24 } (valeurs par défaut si illisible). */
function plage(txt = process.env.KEEP_AWAKE_HOURS) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(txt || '').trim());
  const debut = m ? Number(m[1]) : 7;
  const fin = m ? Number(m[2]) : 24;
  return debut >= 0 && fin <= 24 && debut < fin ? { debut, fin } : { debut: 7, fin: 24 };
}

/** Faut-il rester éveillé à cette heure-là (heure de Paris, été comme hiver) ? */
function actif(date = new Date(), p = plage()) {
  const h = heureParis(date);
  return h >= p.debut && h < p.fin;
}

/** Démarre l'appel régulier (seulement sur Render, sauf KEEP_AWAKE=true pour tester ailleurs). */
function start(baseUrl, { minutes = 10 } = {}) {
  const env = String(process.env.KEEP_AWAKE || '').toLowerCase();
  if (env === 'false' || (!process.env.RENDER && env !== 'true')) return null;
  const url = `${String(baseUrl).replace(/\/$/, '')}/health`;
  const p = plage();
  console.log(`[réveil] appel de ${url} toutes les ${minutes} min, de ${p.debut} h à ${p.fin} h (Paris)`);
  const timer = setInterval(() => {
    if (!actif(new Date(), p)) return;
    fetch(url, { signal: AbortSignal.timeout(30000) }).catch((e) => console.error('[réveil]', e.message));
  }, minutes * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { start, actif, plage };
