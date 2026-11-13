// core/stock/sync.js
// Disponibilité des packs et recharges calculée à partir du stock des composants (boîtes, diffuseur).
// MyLink met à jour le stock des COMPOSANTS dans Shopify ; un pack n'est pas un bundle natif Shopify,
// donc rien ne le fermait quand une de ses boîtes manquait. Ce module recalcule, pour chaque pack,
// le nombre de packs réalisables avec le stock des composants, et l'écrit sur la variante du pack.
//
// Modes (variable STOCK_SYNC_MODE) :
//   off  (défaut) : rien ne tourne ;
//   dry  : calcule et journalise ce qui serait écrit, n'écrit rien ;
//   live : écrit le stock des variantes de pack suivies en stock (inventaire « tracked »).
// Variante non suivie en stock : jamais modifiée (signalée dans le rapport).

const shopify = require('../kits/shopify');
const { buildBundles, componentSources } = require('./bundles');

const mode = () => String(process.env.STOCK_SYNC_MODE || 'off').toLowerCase();

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

async function locationId() {
  if (process.env.STOCK_LOCATION_ID) return shopify.gid('Location', process.env.STOCK_LOCATION_ID);
  const d = await shopify.graphql(`{ locations(first: 10, includeInactive: false) { nodes { id name } } }`);
  const nodes = d.locations?.nodes || [];
  const ml = nodes.find((n) => /mylink/i.test(n.name)) || nodes[0];
  if (!ml) throw new Error('Aucun entrepôt Shopify actif');
  return ml.id;
}

/** Variantes Shopify par SKU (un même SKU peut être porté par plusieurs produits). */
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
            nodes { id sku inventoryQuantity product { handle status }
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

let parentItemIds = new Set();   // pour ignorer les webhooks déclenchés par nos propres écritures

async function run({ write = mode() === 'live' } = {}) {
  const bundles = buildBundles();
  const sources = componentSources();
  const loc = await locationId();

  const comps = new Set();
  Object.values(bundles).forEach((b) => (b.type === 'pool' ? b.pool : b.parts.map((p) => p.sku)).forEach((c) => comps.add(c)));
  const compSku = (c) => sources[c] || c;

  const all = await variantsBySkus([...Object.keys(bundles), ...[...comps].map(compSku)], loc);

  const stock = {}, manquants = [], nonSuivis = [];
  for (const c of comps) {
    const vs = all[compSku(c)] || [];
    if (!vs.length) { manquants.push(c); continue; }
    const tracked = vs.filter((v) => v.inventoryItem?.tracked);
    if (!tracked.length) { nonSuivis.push(c); continue; }
    // Un composant peut exister sur plusieurs produits : même article physique, on prend le stock le plus bas.
    stock[c] = Math.min(...tracked.map((v) => Number(v.inventoryQuantity || 0)));
  }

  const targets = computeTargets(bundles, stock);
  const changes = [], skipped = [];
  const ids = new Set();
  for (const [sku, target] of Object.entries(targets)) {
    for (const v of all[sku] || []) {
      ids.add(v.inventoryItem?.id);
      if (target === null) { skipped.push({ sku, handle: v.product?.handle, raison: 'composant inconnu' }); continue; }
      if (!v.inventoryItem?.tracked) { skipped.push({ sku, handle: v.product?.handle, raison: 'stock non suivi', cible: target }); continue; }
      const cur = v.inventoryItem.inventoryLevel?.quantities?.[0]?.quantity;
      if (cur === undefined || cur === null) { skipped.push({ sku, handle: v.product?.handle, raison: 'pas stocké dans cet entrepôt', cible: target }); continue; }
      if (Number(cur) !== target) changes.push({ sku, handle: v.product?.handle, itemId: v.inventoryItem.id, avant: Number(cur), apres: target });
    }
  }
  parentItemIds = ids;

  let ecrits = 0, erreurs = [];
  if (write && changes.length) {
    for (let i = 0; i < changes.length; i += 100) {
      const lot = changes.slice(i, i + 100);
      try {
        const d = await shopify.graphql(
          `mutation Set($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) { userErrors { field message } }
          }`,
          { input: { name: 'available', reason: 'correction', referenceDocumentUri: 'mymoodz://stock-bundles',
            quantities: lot.map((c) => ({ inventoryItemId: c.itemId, locationId: loc, quantity: c.apres, compareQuantity: c.avant })) } });
        const ue = d.inventorySetQuantities?.userErrors || [];
        if (ue.length) erreurs.push(...ue.map((e) => e.message)); else ecrits += lot.length;
      } catch (e) { erreurs.push(e.message); }
    }
  }

  const report = { mode: mode(), ecriture: !!write, entrepot: loc, stockComposants: stock,
    composantsIntrouvables: manquants, composantsNonSuivis: nonSuivis, changements: changes, ecrits, erreurs, ignores: skipped };
  console.log('[stock]', JSON.stringify({ mode: report.mode, changements: changes.length, ecrits, erreurs: erreurs.length,
    introuvables: manquants, nonSuivis }));
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

/** Webhook « niveau de stock modifié » : on ignore les mouvements des packs eux-mêmes. */
function onInventoryWebhook(payload) {
  const item = payload?.inventory_item_id ? shopify.gid('InventoryItem', payload.inventory_item_id) : null;
  if (item && parentItemIds.has(item)) return 'ignoré (pack)';
  schedule();
  return 'programmé';
}

async function ensureInventoryWebhook(callbackUrl) {
  const topic = 'INVENTORY_LEVELS_UPDATE';
  const d = await shopify.graphql(`query S($t: [WebhookSubscriptionTopic!]) { webhookSubscriptions(first: 50, topics: $t) {
    nodes { endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`, { t: [topic] });
  if ((d.webhookSubscriptions?.nodes || []).some((n) => n.endpoint?.callbackUrl === callbackUrl)) return 'exists';
  const c = await shopify.graphql(`mutation C($t: WebhookSubscriptionTopic!, $u: URL!) {
    webhookSubscriptionCreate(topic: $t, webhookSubscription: { callbackUrl: $u, format: JSON }) { userErrors { field message } } }`,
  { t: topic, u: callbackUrl });
  const ue = c.webhookSubscriptionCreate?.userErrors || [];
  if (ue.length) throw new Error(ue.map((e) => e.message).join(' ; '));
  return 'created';
}

module.exports = { computeTargets, run, schedule, onInventoryWebhook, ensureInventoryWebhook, mode };
