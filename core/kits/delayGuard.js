// core/kits/delayGuard.js
// Délai avant envoi au logisticien (15 min) : Shopify Flow met en attente chaque demande d'expédition
// à la création de la commande (note « MMZ-DELAI-15 »), puis la libère (flux « Délai logisticien 15 minutes »,
// et à défaut le flux « Filet de sécurité », toutes les heures).
//
// Trou que ce module bouche : un article ajouté APRÈS la création (boîtes du composeur, cadeau fidélité,
// offre après achat, modification à la main) peut arriver dans une NOUVELLE demande d'expédition, sans
// attente : MyLink pourrait l'expédier seul, avant les 15 minutes. On retient ces nouvelles demandes avec la
// même note, tant que la commande a moins de 14 minutes : Flow les libère avec le reste.
//
// Ne fait rien si :
//  - DELAY_GUARD_MINUTES vaut 0 ou est absente (défaut) ;
//  - la commande ne porte pas déjà l'attente posée par Flow (flux désactivé : personne ne lèverait la nôtre).

const shopify = require('./shopify');
const { isParentVariant } = require('./config');
const { withLock } = require('./lock');

const HANDLE = 'mmz-delai';
const MARK = 'MMZ-DELAI-15';
const NOTE = `${MARK} : délai avant envoi logisticien (serveur)`;

const minutes = () => {
  const n = parseInt(process.env.DELAY_GUARD_MINUTES, 10);
  return Number.isInteger(n) && n > 1 ? n : 0;
};
const isDelayHold = (h) => h.handle === HANDLE || String(h.reasonNotes || '').includes(MARK);
const fos = (order) => order?.fulfillmentOrders?.nodes || [];
// Attente posée par le flux Flow (pas par ce serveur) : preuve que le délai est actif pour cette commande.
const flowDelayActive = (order) => fos(order).some((fo) => (fo.fulfillmentHolds || [])
  .some((h) => String(h.reasonNotes || '').includes(MARK) && h.handle !== HANDLE));

/** Demandes d'expédition à retenir maintenant (calcul pur). */
function toHold(order, now = Date.now(), win = minutes()) {
  if (!win || !order || order.cancelledAt || !order.createdAt) return [];
  const age = now - new Date(order.createdAt).getTime();
  if (!(age >= 0 && age < (win - 1) * 60000)) return [];   // marge d'1 min : Flow libère à 15 min
  if (!flowDelayActive(order)) return [];
  return fos(order).filter((fo) => {
    if (!['OPEN', 'SCHEDULED', 'ON_HOLD'].includes(fo.status)) return false;
    if ((fo.fulfillmentHolds || []).some(isDelayHold)) return false;
    const lines = (fo.lineItems?.nodes || []).filter((l) => Number(l.remainingQuantity) > 0);
    if (!lines.some((l) => l.requiresShipping !== false)) return false;   // rien à expédier (application numérique)
    // Ligne Recharge seule : rien de physique, close à part par le traitement des kits
    if (lines.every((l) => isParentVariant(shopify.legacyId(l.lineItem?.variant?.id)))) return false;
    return true;
  });
}

/** Retient les demandes concernées d'une commande déjà lue. Retourne le nombre de demandes retenues. */
async function protect(order) {
  const list = toHold(order);
  for (const fo of list) await shopify.holdFulfillmentOrder(fo.id, NOTE, HANDLE);
  if (list.length) console.log('[délai]', order.name, `${list.length} demande(s) d'expédition retenue(s)`);
  return list.length;
}

/** Point d'entrée du webhook « commande créée / modifiée » (après le traitement des kits). */
async function guardOrder(orderId) {
  if (!minutes()) return { skipped: true, reason: 'delai_desactive' };
  return withLock(`order:${shopify.legacyId(orderId)}`, async () => {
    const order = await shopify.getOrder(orderId);
    return { retenues: await protect(order) };
  });
}

module.exports = { guardOrder, protect, toHold, isDelayHold, minutes, HANDLE, MARK };
