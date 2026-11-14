// server.js
const express = require('express');
const cors = require('cors');

const { getAllGiftChoices } = require('./core/customerGifts');
const { applyGiftChange } = require('./core/giftEngine');


// ✅ NEW: webhook helpers
const {
  verifySealHmac,
  fetchSubscription,
  addRecurringGiftFromPropertyWithRetry,
} = require('./core/sealWebhook');

// ✅ Kits recharge ZÉRO (brique A : commandes / brique B : « Mes saveurs »)
const { verifyShopifyWebhook, ensureOrderWebhook } = require('./core/kits/shopify');
const { processOrder } = require('./core/kits/orderFlow');
const { syncSubscription } = require('./core/kits/subscriptionKit');
const flavorsApi = require('./core/kits/flavorsApi');
const { requireCustomer } = require('./core/kits/customerAuth');
// ✅ Stock des packs recalculé à partir des composants (MyLink)
const stockSync = require('./core/stock/sync');
// ✅ Cadeaux de fidélité des abonnés (paliers réglés dans Shopify, REWARDS_MODE ≠ off)
const rewards = require('./core/rewards/engine');
const { loadTiers } = require('./core/rewards/tiers');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 10000;

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

// -------- Middlewares globaux --------
// CORS ouvert pour les routes historiques ; les routes /kits ont leur propre liste d'origines autorisées.
const openCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Seal-Hmac-Sha256', 'Authorization'],
  }
);
app.use((req, res, next) => (req.path.startsWith('/kits') ? next() : openCors(req, res, next)));

/**
 * ✅ WEBHOOK Seal: RAW body obligatoire pour HMAC
 * IMPORTANT: on répond 200 immédiatement (anti retry Seal => anti doublons)
 */
app.post(
  '/webhooks/seal/subscription-created',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    // ✅ ACK DIRECT
    res.status(200).send('ok');

    try {
      const receivedHmac = req.header('X-Seal-Hmac-Sha256');
      const ok = verifySealHmac(req.body, receivedHmac);
      if (!ok) {
        console.error('[seal webhook] Invalid HMAC');
        return;
      }

      const payload = JSON.parse(req.body.toString('utf-8'));
      const subscriptionId = payload?.id;
      if (!subscriptionId) {
        console.error('[seal webhook] Missing subscription id');
        return;
      }

      // ✅ Retries pour attendre que Seal ait bien attaché items/properties
      const fullSub = await fetchSubscription(subscriptionId);
      const result = await addRecurringGiftFromPropertyWithRetry(fullSub, 6, 1500);


      console.log('[seal webhook] Done', { subscriptionId, result });

      // ✅ Kits : met les boîtes saveur dans le contrat (renouvellements complets)
      try {
        const kit = await syncSubscription(subscriptionId);
        console.log('[seal webhook] Kit', { subscriptionId, kit });
      } catch (e) {
        console.error('[seal webhook] Kit ERROR', e?.seal || e?.message || e);
      }
    } catch (err) {
      console.error('[seal webhook] ERROR', err?.seal || err);
    }
  }
);

/**
 * ✅ Webhook Seal « abonnement modifié » : réaligne les boîtes du kit
 * (changement de durée ou de quantité dans l'espace client Seal).
 */
app.post('/webhooks/seal/subscription-updated', express.raw({ type: '*/*' }), async (req, res) => {
  res.status(200).send('ok');
  try {
    if (!verifySealHmac(req.body, req.header('X-Seal-Hmac-Sha256'))) {
      console.error('[seal updated] Invalid HMAC');
      return;
    }
    const payload = JSON.parse(req.body.toString('utf-8'));
    if (!payload?.id) return;
    const kit = await syncSubscription(payload.id);
    console.log('[seal updated] Kit', { id: payload.id, kit });
  } catch (err) {
    console.error('[seal updated] ERROR', err?.seal || err?.message || err);
  }
});

/**
 * ✅ Webhook Shopify « commande créée / modifiée » : brique A
 * (mise en attente → ajout des boîtes → libération pour MyLink).
 */
app.post('/webhooks/shopify/orders', express.raw({ type: '*/*' }), async (req, res) => {
  if (!verifyShopifyWebhook(req.body, req.header('X-Shopify-Hmac-Sha256'))) {
    return res.status(401).send('invalid hmac');
  }
  res.status(200).send('ok');
  try {
    const payload = JSON.parse(req.body.toString('utf-8'));
    const topic = req.header('X-Shopify-Topic') || 'orders';
    if (!payload?.id) return;
    // Cadeau de fidélité d'abord : la commande est encore retenue, MyLink ne l'a pas (ne bloque jamais).
    const cadeau = await rewards.applyToOrder(payload.id);
    if (!cadeau.skipped) console.log('[shopify orders] cadeau', payload.name || payload.id, JSON.stringify(cadeau));
    const result = await processOrder(payload.id, topic);
    console.log('[shopify orders]', topic, payload.name || payload.id, result);
  } catch (err) {
    console.error('[shopify orders] ERROR', err?.message || err, err?.userErrors || '');
  }
});

/**
 * ✅ Webhook Shopify « niveau de stock modifié » : recalcul du stock des packs (STOCK_SYNC_MODE ≠ off).
 */
app.post('/webhooks/shopify/inventory', express.raw({ type: '*/*' }), (req, res) => {
  if (!verifyShopifyWebhook(req.body, req.header('X-Shopify-Hmac-Sha256'))) {
    return res.status(401).send('invalid hmac');
  }
  res.status(200).send('ok');
  try {
    stockSync.onInventoryWebhook(JSON.parse(req.body.toString('utf-8')));
  } catch (err) {
    console.error('[stock webhook] ERROR', err?.message || err);
  }
});

// JSON pour le reste de l'API (taille limitée)
app.use(express.json({ limit: '50kb' }));

// ✅ Brique B : « Mes saveurs » (client connecté, jeton signé par le thème)
const KITS_ORIGINS = (process.env.KITS_ALLOWED_ORIGINS || 'https://mymoodz.co,https://www.mymoodz.co,https://testshopilol.myshopify.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
// ✅ Portail « Mon abonnement » (prochaine livraison, décaler, sauter, pause, progression, paliers)
app.use(
  '/kits/portal',
  cors({ origin: KITS_ORIGINS, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }),
  require('./core/portal/portalApi')
);
// ✅ « Suivre ma commande » (public, sans connexion : n° de suivi, ou n° de commande + e-mail d'achat)
app.use(
  '/kits/suivi',
  cors({ origin: KITS_ORIGINS, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }),
  require('./core/suivi/suiviApi')
);
app.use(
  '/kits',
  cors({ origin: KITS_ORIGINS, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }),
  flavorsApi
);

// ✅ Rejouer le traitement d'une commande (réservé à l'équipe : clé d'admin)
app.post('/admin/kits/orders/:id/reprocess', async (req, res) => {
  const key = process.env.KITS_ADMIN_KEY;
  if (!key || req.get('x-admin-key') !== key) return res.status(401).json({ ok: false });
  try {
    const result = await processOrder(String(req.params.id), 'manuel');
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, details: e.userErrors || null });
  }
});

// ✅ Stock des packs : aperçu (n'écrit jamais) et synchro manuelle (écrit seulement en mode live)
const adminOk = (req) => process.env.KITS_ADMIN_KEY && req.get('x-admin-key') === process.env.KITS_ADMIN_KEY;
app.get('/admin/stock/preview', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false });
  try { return res.json({ ok: true, report: await stockSync.run({ write: false }) }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/admin/stock/sync', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false });
  try { return res.json({ ok: true, report: await stockSync.run() }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ✅ Paliers de fidélité : contrôle des réglages Shopify, situation d'un client, rejouer une commande
app.get('/admin/paliers', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false });
  const tiers = await loadTiers({ force: true });
  if (!tiers) return res.status(502).json({ ok: false, error: 'Paliers illisibles (droit read_metaobjects ?)' });
  return res.json({ ok: true, mode: rewards.mode(), paliers: tiers });
});
app.get('/admin/paliers/clients/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false });
  try { return res.json({ ok: true, fidelite: await rewards.statusFor(String(req.params.id)) }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/admin/paliers/commandes/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ ok: false });
  // ?simulation=1 : calcule sans rien toucher, même si REWARDS_MODE=live
  const force = req.query.simulation === '1' ? 'dry' : undefined;
  return res.json({ ok: true, result: await rewards.applyToOrder(String(req.params.id), { force }) });
});

// -------- Routes de base --------
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'MyMoodz Subscription API' });
});

/**
 * Retourne les abonnements Seal d'un client (par email)
 * GET /subscriptions-for-customer?email=xxx
 */
// ⚠️ Route historique (page « Gérer mon cadeau ») : elle ne renvoie plus les données brutes de Seal.
// Avec GIFT_REQUIRE_TOKEN=true, elle exige le jeton client signé et ignore l'e-mail passé en paramètre.
const giftGuard = (req, res, next) =>
  String(process.env.GIFT_REQUIRE_TOKEN || '').toLowerCase() === 'true' ? requireCustomer(req, res, next) : next();

app.get('/subscriptions-for-customer', giftGuard, async (req, res) => {
  try {
    const email = req.customer ? req.customer.email : req.query.email;
    if (!email) {
      return res.status(400).json({ ok: false, error: 'Paramètre email manquant' });
    }

    if (!SEAL_API_TOKEN) {
      return res.status(500).json({ ok: false, error: 'SEAL_API_TOKEN manquant côté serveur' });
    }

    const url = `${SEAL_BASE_URL}/subscriptions?query=${encodeURIComponent(email)}&with-items=true&active-only=true`;
    console.log('[subscriptions-for-customer] Call Seal URL =', url);

    const sealRes = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Seal-Token': SEAL_API_TOKEN },
    });

    let json = null;
    try {
      json = await sealRes.json();
    } catch (e) {
      console.error('[subscriptions-for-customer] Réponse Seal non JSON');
    }

    if (!sealRes.ok || !json) {
      console.error('[subscriptions-for-customer] Erreur Seal brute', { status: sealRes.status, body: json });
      return res.status(500).json({
        ok: false,
        error: 'Erreur Seal API',
        sealStatus: sealRes.status,
        sealBody: json || null,
      });
    }

    let subsRaw = [];
    if (json.payload && Array.isArray(json.payload.subscriptions)) subsRaw = json.payload.subscriptions;
    else if (Array.isArray(json.subscriptions)) subsRaw = json.subscriptions;
    else if (Array.isArray(json.payload)) subsRaw = json.payload;
    else if (Array.isArray(json)) subsRaw = json;

    const simplified = subsRaw.map((s) => ({
      id: s.id,
      status: s.status,
      email: s.email,
      total_value: s.total_value,
      items: (s.items || []).map((item) => ({
        id: item.id,
        title: item.title,
        variant_id: item.variant_id,
        price: item.price,
        quantity: item.quantity,
      })),
    }));

    return res.json({ ok: true, subscriptions: simplified });
  } catch (err) {
    console.error('[/subscriptions-for-customer] ERROR', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * Endpoint utilisé par ta page "Gérer mon cadeau"
 */
app.post('/change-gift', giftGuard, async (req, res) => {
  try {
    const { subscriptionId, customerEmail, giftCode } = req.body || {};
    if (!subscriptionId || !giftCode) {
      return res.status(400).json({ success: false, error: 'subscriptionId et giftCode sont obligatoires' });
    }

    // Avec le jeton client : on vérifie que l'abonnement appartient bien à ce client
    if (req.customer) {
      const sub = await fetchSubscription(subscriptionId);
      if (String(sub?.email || '').trim().toLowerCase() !== req.customer.email) {
        return res.status(404).json({ success: false, error: 'Abonnement introuvable' });
      }
    }
    const result = await applyGiftChange({ subscriptionId, customerEmail, giftCode });
    return res.json(result);
  } catch (err) {
    console.error('[/change-gift] ERROR', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


app.get('/health', (req, res) => {
  console.log('[health] ping', new Date().toISOString());
  res.status(200).send('ok');
});



app.listen(PORT, () => {
  console.log(`MyMoodz subscription API running on port ${PORT}`);
  const base = (process.env.KITS_PUBLIC_URL || 'https://mymoodz-subscription-api.onrender.com').replace(/\/$/, '');
  ensureOrderWebhook(base + '/webhooks/shopify/orders')
    .then((r) => console.log('[kits] webhook commandes', JSON.stringify(r)))
    .catch((e) => console.error('[kits] webhook commandes non créé :', e.message));
  require('./core/kits/seal')
    .ensureSealWebhook('subscription/updated', base + '/webhooks/seal/subscription-updated')
    .then((r) => console.log('[kits] webhook Seal abonnement modifié', JSON.stringify(r)))
    .catch((e) => console.error('[kits] webhook Seal non créé :', e.message, JSON.stringify(e.seal || '')));
  // Stock des packs : seulement si activé (STOCK_SYNC_MODE=dry ou live)
  if (stockSync.mode() !== 'off') {
    stockSync.ensureInventoryWebhook(base + '/webhooks/shopify/inventory')
      .then((r) => console.log('[stock] webhook stock', r))
      .catch((e) => console.error('[stock] webhook stock non créé (droit read_inventory ?) :', e.message));
    stockSync.schedule(30000);
    setInterval(() => stockSync.schedule(1000), 30 * 60 * 1000);
  }
});
