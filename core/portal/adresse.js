// core/portal/adresse.js
// Adresse de livraison des PROCHAINES livraisons d'un abonnement (champs s_* de Seal).
// Le pays ne change pas ici : les frais et zones de livraison en dépendent (changement de pays = support).
// Une commande déjà passée se modifie avec Relocate (lien de l'e-mail de confirmation), pas ici.

const FR = new Set(['FR', 'MC']);

/** Champs pré-remplis du formulaire (renvoyés seulement au propriétaire de l'abonnement). */
function champs(sub) {
  const v = (k) => String(sub?.[k] ?? '').trim();
  return {
    prenom: v('s_first_name'),
    nom: v('s_last_name'),
    societe: v('s_company'),
    adresse1: v('s_address1'),
    adresse2: v('s_address2'),
    cp: v('s_zip'),
    ville: v('s_city'),
    telephone: v('s_phone'),
    pays: v('s_country'),
    pays_code: v('s_country_code').toUpperCase(),
  };
}

// Texte propre : sans caractères de contrôle ni chevrons, espaces resserrés
const net = (x) => String(x ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Vérifie la saisie du client. Renvoie { edit } (champs Seal à envoyer) ou { refus } (message pour le client).
 * Le pays reste celui de l'abonnement.
 */
function valider(body, sub) {
  const b = body || {};
  const f = {
    prenom: net(b.prenom), nom: net(b.nom), societe: net(b.societe),
    adresse1: net(b.adresse1), adresse2: net(b.adresse2),
    cp: net(b.cp).toUpperCase(), ville: net(b.ville), telephone: net(b.telephone),
  };
  if (!f.prenom || !f.nom) return { refus: 'Indique le prénom et le nom du destinataire.' };
  if (f.prenom.length > 60 || f.nom.length > 60 || f.societe.length > 60) return { refus: 'Un des noms est trop long.' };
  if (f.adresse1.length < 3) return { refus: "Indique l'adresse (numéro et rue)." };
  if (f.adresse1.length > 100 || f.adresse2.length > 100) return { refus: "L'adresse est trop longue." };
  if (!f.ville || f.ville.length > 60) return { refus: 'Indique la ville.' };
  const pays = champs(sub).pays_code;
  if (FR.has(pays) ? !/^\d{5}$/.test(f.cp) : !/^[A-Z0-9][A-Z0-9 -]{1,10}$/.test(f.cp)) return { refus: 'Le code postal ne semble pas valide.' };
  if (f.telephone && !/^[0-9+().\s-]{6,25}$/.test(f.telephone)) return { refus: 'Le numéro de téléphone ne semble pas valide.' };
  return {
    edit: {
      s_first_name: f.prenom,
      s_last_name: f.nom,
      s_company: f.societe,
      s_address1: f.adresse1,
      s_address2: f.adresse2,
      s_zip: f.cp,
      s_city: f.ville,
      s_phone: f.telephone,
    },
  };
}

module.exports = { champs, valider };
