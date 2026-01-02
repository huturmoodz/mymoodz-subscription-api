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

const app = express();
const PORT = process.env.PORT || 10000;

const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN;
const SEAL_BASE_URL = 'https://app.sealsubscriptions.com/shopify/merchant/api';

// -------- Middlewares globaux --------
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Seal-Hmac-Sha256'],
  })
);

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
    } catch (err) {
      console.error('[seal webhook] ERROR', err?.seal || err);
    }
  }
);

// JSON pour le reste de l'API
app.use(express.json());

// -------- Routes de base --------
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'MyMoodz Subscription API' });
});

/**
 * Debug : voir les variables d'environnement importantes
 */
app.get('/debug/env', (req, res) => {
  res.json({
    ok: true,
    env: {
      SHOPIFY_STORE_DOMAIN: !!process.env.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_ADMIN_ACCESS_TOKEN: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || null,
      SEAL_API_TOKEN: !!process.env.SEAL_API_TOKEN,
      SEAL_WEBHOOK_SECRET: !!process.env.SEAL_WEBHOOK_SECRET,
      NODE_ENV: process.env.NODE_ENV || null,
    },
  });
});

/**
 * Debug : liste tous les choix de cadeaux en mémoire
 */
app.get('/debug/gifts', (req, res) => {
  res.json({ ok: true, data: getAllGiftChoices() });
});

/**
 * Retourne les abonnements Seal d'un client (par email)
 * GET /subscriptions-for-customer?email=xxx
 */
app.get('/subscriptions-for-customer', async (req, res) => {
  try {
    const email = req.query.email;
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

    return res.json({ ok: true, subscriptions: simplified, sealRaw: json });
  } catch (err) {
    console.error('[/subscriptions-for-customer] ERROR', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * Endpoint utilisé par ta page "Gérer mon cadeau"
 */
app.post('/change-gift', async (req, res) => {
  try {
    const { subscriptionId, customerEmail, giftCode } = req.body || {};
    if (!subscriptionId || !giftCode) {
      return res.status(400).json({ success: false, error: 'subscriptionId et giftCode sont obligatoires' });
    }

    const result = await applyGiftChange({ subscriptionId, customerEmail, giftCode });
    return res.json(result);
  } catch (err) {
    console.error('[/change-gift] ERROR', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`MyMoodz subscription API running on port ${PORT}`);
});
