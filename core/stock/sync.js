// core/stock/sync.js
// Disponibilité de tout ce qui se vend, calculée à partir du stock des composants physiques chez MyLink
// (boîtes ZÉRO, boîtes RITUEL, diffuseur).
//
// Un seul compteur par article physique :
//  - MyLink met à jour le stock de chaque composant sur sa fiche « maître » (produits_maitres dans
//    compositions.json : Boîte ZÉRO, Boîte RITUEL, diffuseur). C'est la source de vérité : ce module
//    n'écrit JAMAIS sur une fiche maître.
//  - Toute autre fiche qui porte le SKU d'un composant (recharge « 1 semaine », boîte cadeau…) est un
//    miroir : on y recopie le stock du composant.
//  - Un pack ou une recharge n'est pas un bundle natif Shopify : son stock = nombre de packs réalisables
//    avec les composants (le plus limitant), écrit sur chaque fiche qui porte ce SKU.
//  - Commandes pas encore expédiées : Shopify ne retire du stock maître que ce qui a été vendu sur la fiche
//    maître elle-même (boîtes ajoutées par le composeur, renouvellements Seal, diffuseur seul). Un pack, une
//    recharge ou un miroir vendu ne touche pas la fiche maître tant que MyLink n'a pas remonté son nouveau
//    stock : on le déduit nous-mêmes (« en attente »), pour ne jamais vendre deux fois la même boîte.
//    Variable STOCK_PENDING : unfulfilled (défaut : toutes les commandes pas encore expédiées),
//    held (seulement celles encore retenues, pas encore transmises à MyLink), off (aucune).
//
// Modes (variable STOCK_SYNC_MODE) :
//   off  (défaut) : rien ne tourne ;
//   dry  : calcule et journalise ce qui serait écrit, n'écrit rien ;
//   live : écrit le stock des fiches suivies en stock, et le stock par saveur lu par le composeur
//          (métachamp boutique mymoodz.stock_boites).
// Fiche non suivie en stock : jamais modifiée (signalée dans le rapport : à activer en même temps que la synchro).

const crypto = require('crypto');
const shopify = require('../kits/shopify');
const { buildBundles, componentSources, masterHandles } = require('./bundles');

const mode = () => String(process.env.STOCK_SYNC_MODE || 'off').toLowerCase();
const pendingMode = () => {
  const m = String(process.env.STOCK_PENDING || 'unfulfilled').toLowerCase();
  return ['unfulfilled', 'held', 'off'].includes(m) ? m : 'unfulfilled';
};
const PENDING_DAYS = 30;          // commandes plus anciennes : ignorées (déjà parties ou traitées à la main)
const PENDING_MAX_PAGES = 20;     // 20 × 15 commandes ouvertes au plus
const META = { namespace: 'mymoodz', key: 'stock_boites' };
const META_REFRESH_MS = 6 * 3600 * 1000;   // réécrit au moins toutes les 6 h (le composeur ignore une donnée de plus de 24 h)

/** Calcul pur : stock cible par SKU parent. null = un composant est inconnu → on ne touche pas. */
function computeTargets(bundles, stockByComponent) {
  const out = {};
  for (const [sku, b] of Object.entries(bundles)) {
    if (b.type === 'pool') {
      const vals = b.pool.map((c) => stockByComponent[c]);
      out[sku] = vals.some((v) => v === undefined || v === null)
        ? null : Math.max(0, Math.floor(vals.reduce((s, v) => s + Math.max(0, v), 0) / b.qty));
    } else {
      let min = Infinity, unknown = false;
      for (const p of b.parts) {
        const v = stockByComponent[p.sku];
        if (v === undefined || v === null) { unknown = true; break; }
        min = Math.min(min, Math.floor(Math.max(0, v) / p.qty));
      }
      out[sku] = unknown ? null : Math.max(0, min === Infinity ? 0 : min);
    }
  }
  return out;
}

/** Fiche maître d'un composant parmi les fiches qui portent son SKU (calcul pur). */
function pickMaster(variants, masters) {
  const tracked = (variants || []).filter((v) => v.inventoryItem?.tracked);
  const declared = tracked.filter((v) => masters.includes(v.product?.handle));
  if (declared.length === 1) return { master: declared[0] };
  if (declared.length > 1) return { error: 'plusieurs fiches maîtres suivies' };
  if (tracked.length === 1) return { master: tracked[0] };          // composant futur non déclaré : sa seule fiche suivie
  if (tracked.length > 1) return { error: 'plusieurs fiches suivies, aucune déclarée maître' };
  return { error: (variants || []).length ? 'non suivi' : 'introuvable' };
}

/**
 * Demande en attente par composant (calcul pur) : unités vendues sur des commandes pas encore expédiées,
 * que Shopify n'a PAS déjà retirées du stock de la fiche maître.
 *  - ligne d'une fiche maître : ignorée (déjà retirée du stock maître par Shopify) ;
 *  - ligne d'un pack ou d'une recharge fixe : décomposée (pack 1 mois = 1 boîte de chaque + 1 diffuseur) ;
 *  - ligne d'une recharge à composer (REC-ZERO) : ignorée (ses boîtes ont leurs propres lignes maîtres) ;
 *  - ligne miroir (SKU d'un composant sur une autre fiche) : 1 pour 1.
 */
function pendingDemand(orders, { bundles, masterVariantIds, componentOfSku }) {
  const out = {};
  const add = (c, n) => { out[c] = (out[c] || 0) + n; };
  for (const o of orders || []) {
    for (const l of o.lineItems?.nodes || []) {
      const n = Math.min(Number(l.unfulfilledQuantity || 0), Number(l.currentQuantity ?? l.unfulfilledQuantity ?? 0));
      if (!l.sku || n <= 0) continue;
      if (l.variant?.id && masterVariantIds.has(l.variant.id)) continue;
      const b = bundles[l.sku];
      if (b) {
        if (b.type === 'fixed') b.parts.forEach((p) => add(p.sku, p.qty * n));
        continue;
      }
      const c = componentOfSku[l.sku];
      if (c) add(c, n);
    }
  }
  return out;
}

async function locationId() {
  if (process.env.STOCK_LOCATION_ID) return shopify.gid('Location', process.env.STOCK_LOCATION_ID);
  const d = await shopify.graphql(`{ locations(first: 10, includeInactive: false) { nodes { id name } } }`);
  const nodes = d.locations?.nodes || [];
  const ml = nodes.find((n) => /mylink/i.test(n.name)) || nodes[0];
  if (!ml) throw new Error('Aucun entrepôt Shopify actif');
  return ml.id;
}

/** Fiches Shopify par SKU (un même SKU peut être porté par plusieurs produits), avec leur stock dans l'entrepôt. */
async function variantsBySkus(skus, loc) {
  const res = {};
  const uniq = [...new Set(skus)];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    const q = chunk.map((s) => `sku:"${s}"`).join(' OR ');
    let after = null;
    do {
      const d = await shopify.graphql(
        `query V($q: String!, $after: String, $loc: ID!) {
          productVariants(first: 100, query: $q, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id sku product { handle status }
              inventoryItem { id tracked inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } }
          }
        }`, { q, after, loc });
      const pv = d.productVariants;
      for (const n of pv.nodes || []) {
        if (!chunk.includes(n.sku)) continue;   // la recherche Shopify est approximative : on ne garde que l'exact
        (res[n.sku] = res[n.sku] || []).push(n);
      }
      after = pv.pageInfo.hasNextPage ? pv.pageInfo.endCursor : null;
    } while (after);
  }
  return res;
}

const levelOf = (v) => {
  const q = v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
  return q === undefined || q === null ? null : Number(q);
};

const isTestOrder = (o) => (o.tags || []).includes('mmz-test')
  || (o.customAttributes || []).some((a) => a.key === '_mmz_test' && String(a.value) === '1');

/** Commandes ouvertes pas encore (entièrement) expédiées, hors commandes de test. */
async function openOrders(pm) {
  const since = new Date(Date.now() - PENDING_DAYS * 86400000).toISOString().slice(0, 10);
  const filter = pm === 'held' ? 'fulfillment_status:on_hold' : '-fulfillment_status:fulfilled';
  const q = `status:open AND ${filter} AND created_at:>=${since} AND tag_not:mmz-test`;
  const out = [];
  let after = null, pages = 0;
  do {
    const d = await shopify.graphql(
      `query Pending($q: String!, $after: String) {
        orders(first: 15, query: $q, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id tags customAttributes { key value }
            lineItems(first: 30) { nodes { sku currentQuantity unfulfilledQuantity variant { id } } } }
        }
      }`, { q, after });
    out.push(...(d.orders?.nodes || []).filter((o) => !isTestOrder(o)));
    after = d.orders?.pageInfo?.hasNextPage ? d.orders.pageInfo.endCursor : null;
    pages += 1;
  } while (after && pages < PENDING_MAX_PAGES);
  return { orders: out, tronque: !!after };
}

// Écritures faites par ce module : le webhook « stock modifié » qu'elles déclenchent est ignoré
// (sinon chaque écriture relancerait un calcul pour rien).
const lastWritten = new Map();   // inventoryItemId → quantité écrite
let lastMeta = { key: '', at: 0 };
let shopGid = null;

async function writeQuantities(changes, loc, erreurs) {
  let ecrits = 0;
  for (let i = 0; i < changes.length; i += 100) {
    const lot = changes.slice(i, i + 100);
    const key = crypto.randomUUID();   // même clé si la requête est rejouée (réseau) : jamais appliquée deux fois
    try {
      const d = await shopify.graphql(
        `mutation Set($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) @idempotent(key: "${key}") { userErrors { field message } }
        }`,
        { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'mymoodz://stock-bundles',
          quantities: lot.map((c) => ({ inventoryItemId: c.itemId, locationId: loc, quantity: c.apres, changeFromQuantity: c.avant })) } });
      const ue = d.inventorySetQuantities?.userErrors || [];
      if (ue.length) erreurs.push(...ue.map((e) => e.message));
      else { ecrits += lot.length; lot.forEach((c) => lastWritten.set(c.itemId, c.apres)); }
    } catch (e) { erreurs.push(e.message); }
  }
  return ecrits;
}

/** Stock par saveur pour le composeur (le produit Boîte ZÉRO n'est pas publié : le thème ne peut pas le lire). */
async function writeMetafield(payload, erreurs) {
  const key = JSON.stringify(payload.par_sku);
  if (key === lastMeta.key && Date.now() - lastMeta.at < META_REFRESH_MS) return 'inchangé';
  try {
    if (!shopGid) shopGid = (await shopify.graphql('{ shop { id } }')).shop.id;
    const d = await shopify.graphql(
      `mutation M($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
      { m: [{ ownerId: shopGid, namespace: META.namespace, key: META.key, type: 'json', value: JSON.stringify(payload) }] });
    const ue = d.metafieldsSet?.userErrors || [];
    if (ue.length) { erreurs.push('métachamp : ' + ue.map((e) => e.message).join(' ; ')); return 'erreur'; }
    lastMeta = { key, at: Date.now() };
    return 'écrit';
  } catch (e) { erreurs.push('métachamp : ' + e.message); return 'erreur'; }
}

async function run({ write = mode() === 'live' } = {}) {
  const bundles = buildBundles();
  const sources = componentSources();
  const masters = masterHandles();
  const pm = pendingMode();
  const loc = await locationId();

  const comps = new Set();
  Object.values(bundles).forEach((b) => (b.type === 'pool' ? b.pool : b.parts.map((p) => p.sku)).forEach((c) => comps.add(c)));
  const compSku = (c) => sources[c] || c;
  const componentOfSku = {};
  for (const c of comps) componentOfSku[compSku(c)] = c;

  const all = await variantsBySkus([...Object.keys(bundles), ...[...comps].map(compSku)], loc);

  // 1. Stock de chaque composant sur sa fiche maître (dans l'entrepôt de MyLink)
  const masterOf = {}, stockMaitre = {}, manquants = [], nonSuivis = [], ambigus = [];
  for (const c of comps) {
    const pick = pickMaster(all[compSku(c)], masters);
    if (pick.error === 'introuvable') { manquants.push(c); continue; }
    if (pick.error === 'non suivi') { nonSuivis.push(c); continue; }
    if (pick.error) { ambigus.push({ composant: c, raison: pick.error }); continue; }
    const lvl = levelOf(pick.master);
    if (lvl === null) { manquants.push(c); continue; }
    masterOf[c] = pick.master;
    stockMaitre[c] = lvl;
  }

  // 2. Ce qui est vendu mais pas encore remonté par MyLink
  let enAttente = {}, attenteTronquee = false;
  if (pm !== 'off') {
    const masterVariantIds = new Set(Object.values(masterOf).map((v) => v.id));
    const { orders, tronque } = await openOrders(pm);
    enAttente = pendingDemand(orders, { bundles, masterVariantIds, componentOfSku });
    attenteTronquee = tronque;
  }
  const stock = {};
  for (const [c, s] of Object.entries(stockMaitre)) stock[c] = s - (enAttente[c] || 0);

  // 3. Ce qu'il faut écrire : miroirs (copie du composant) et packs/recharges (calcul)
  const targets = computeTargets(bundles, stock);
  const changes = [], skipped = [];
  const consider = (sku, v, target, type) => {
    if (target === null || target === undefined) { skipped.push({ sku, handle: v.product?.handle, raison: 'composant inconnu' }); return; }
    if (!v.inventoryItem?.tracked) { skipped.push({ sku, handle: v.product?.handle, raison: 'stock non suivi', cible: target }); return; }
    const cur = levelOf(v);
    if (cur === null) { skipped.push({ sku, handle: v.product?.handle, raison: 'pas stocké dans cet entrepôt', cible: target }); return; }
    if (cur !== target) changes.push({ type, sku, handle: v.product?.handle, itemId: v.inventoryItem.id, avant: cur, apres: target });
  };
  for (const c of comps) {
    for (const v of all[compSku(c)] || []) {
      if (masterOf[c] && v.id === masterOf[c].id) continue;           // fiche maître : MyLink seul l'écrit
      const t = stock[c] === undefined ? null : Math.max(0, stock[c]);
      consider(compSku(c), v, t, 'miroir');
    }
  }
  for (const [sku, target] of Object.entries(targets)) {
    for (const v of all[sku] || []) consider(sku, v, target, 'pack');
  }

  const erreurs = [];
  const ecrits = write && changes.length ? await writeQuantities(changes, loc, erreurs) : 0;

  // 4. Stock par saveur pour le composeur
  const parVariante = {}, parSku = {};
  for (const c of comps) {
    const v = stock[c] === undefined ? null : Math.max(0, stock[c]);
    parSku[compSku(c)] = v;
    if (masterOf[c]) parVariante[shopify.legacyId(masterOf[c].id)] = v;
  }
  const metachamp = write
    ? await writeMetafield({ maj: new Date().toISOString(), par_variante: parVariante, par_sku: parSku }, erreurs)
    : 'non écrit (aperçu)';

  const report = { mode: mode(), ecriture: !!write, entrepot: loc, attente: pm, attenteTronquee,
    stockMaitre, enAttente, stockComposants: stock,
    composantsIntrouvables: manquants, composantsNonSuivis: nonSuivis, composantsAmbigus: ambigus,
    changements: changes, ecrits, erreurs, ignores: skipped, metachamp };
  console.log('[stock]', JSON.stringify({ mode: report.mode, attente: pm, changements: changes.length, ecrits, erreurs: erreurs.length,
    introuvables: manquants, nonSuivis, ambigus: ambigus.length, metachamp }));
  return report;
}

// --- Déclenchement : regroupe les rafales de webhooks (une commande = plusieurs mouvements)
let timer = null, running = false, again = false;
function schedule(delayMs = 15000) {
  if (mode() === 'off') return;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try { await run(); } catch (e) { console.error('[stock] échec', e.message); }
    running = false;
    if (again) { again = false; schedule(1000); }
  }, delayMs);
}

/** Webhook « niveau de stock modifié » : on ignore l'écho de nos propres écritures, tout le reste relance le calcul. */
function onInventoryWebhook(payload) {
  const item = payload?.inventory_item_id ? shopify.gid('InventoryItem', payload.inventory_item_id) : null;
  if (item && lastWritten.has(item) && lastWritten.get(item) === Number(payload.available)) {
    lastWritten.delete(item);
    return 'ignoré (notre écriture)';
  }
  schedule();
  return 'programmé';
}

async function ensureInventoryWebhook(uri) {
  const topic = 'INVENTORY_LEVELS_UPDATE';
  const d = await shopify.graphql(`query S($t: [WebhookSubscriptionTopic!]) { webhookSubscriptions(first: 50, topics: $t) {
    nodes { uri } } }`, { t: [topic] });
  if ((d.webhookSubscriptions?.nodes || []).some((n) => n.uri === uri)) return 'exists';
  const c = await shopify.graphql(`mutation C($t: WebhookSubscriptionTopic!, $u: String!) {
    webhookSubscriptionCreate(topic: $t, webhookSubscription: { uri: $u, format: JSON }) { userErrors { field message } } }`,
  { t: topic, u: uri });
  const ue = c.webhookSubscriptionCreate?.userErrors || [];
  if (ue.length) throw new Error(ue.map((e) => e.message).join(' ; '));
  return 'created';
}

module.exports = { computeTargets, pickMaster, pendingDemand, run, schedule, onInventoryWebhook, ensureInventoryWebhook, mode };
