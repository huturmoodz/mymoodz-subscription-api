// server.js
const express = require('express');
const cors = require('cors');

const {
  saveGiftChoice,
  getGiftChoiceForSubscription,
  getAllGiftChoices,
} = require('./core/customerGifts');
// plus tard on utilisera vraiment giftEngine
const { changeGiftForSubscription } = require('./core/giftEngine');

const app = express();
const PORT = process.env.PORT || 10000;

// -------- Middlewares globaux --------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
}));

app.use(express.json());

// -------- Routes de base --------

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'MyMoodz Subscription API' });
});

/**
 * Debug : voir les variables d'environnement importantes
 * (on ne renvoie que des booléens, pas les valeurs)
 */
app.get('/debug/env', (req, res) => {
  res.json({
    ok: true,
    env: {
      SHOPIFY_STORE_DOMAIN: !!process.env.SHOPIFY_STORE_DOMAIN,
      SHOPIFY_ADMIN_ACCESS_TOKEN: !!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || null,
      SEAL_WEBHOOK_SECRET: !!process.env.SEAL_WEBHOOK_SECRET,
      NODE_ENV: process.env.NODE_ENV || null,
    },
  });
});

/**
 * Debug : liste tous les choix de cadeaux en mémoire
 */
app.get('/debug/gifts', (req, res) => {
  res.json({
    ok: true,
    data: getAllGiftChoices(),
  });
});

/**
 * Endpoint utilisé par ta page "Gérer mon cadeau"
 * pour enregistrer le nouveau cadeau choisi.
 */
app.post('/change-gift', async (req, res) => {
  try {
    const { subscriptionId, customerId, giftCode } = req.body || {};

    if (!subscriptionId || !giftCode) {
      return res.status(400).json({
        ok: false,
        error: 'subscriptionId et giftCode sont obligatoires',
      });
    }

    // 1) On sauvegarde la demande dans notre petit store mémoire
    const saved = saveGiftChoice({ subscriptionId, customerId, giftCode });

    // 2) Plus tard : ici on appellera vraiment Shopify / Seal
    // await changeGiftForSubscription({ subscriptionId, giftCode });

    return res.json({
      ok: true,
      data: saved,
    });
  } catch (err) {
    console.error('[/change-gift] ERROR', err);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
    });
  }
});

// -------- Lancement du serveur --------
app.listen(PORT, () => {
  console.log(`MyMoodz subscription API running on port ${PORT}`);
});
