// server.js
const express = require('express');
const cors = require('cors');

const {
  getAllGiftChoices,
} = require('./core/customerGifts');

const { applyGiftChange } = require('./core/giftEngine');


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
      SEAL_API_TOKEN: !!process.env.SEAL_API_TOKEN,   // 👈 AJOUT
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
    const { subscriptionId, customerEmail, giftCode } = req.body || {};

    if (!subscriptionId || !giftCode) {
      return res.status(400).json({
        success: false,
        error: 'subscriptionId et giftCode sont obligatoires',
      });
    }

    // On délègue tout au moteur de cadeau
    const result = await applyGiftChange({
      subscriptionId,
      customerEmail,
      giftCode,
    });

    // result ressemble à : { success: true, data: { ... } }
    return res.json(result);
  } catch (err) {
    console.error('[/change-gift] ERROR', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});


// -------- Lancement du serveur --------
app.listen(PORT, () => {
  console.log(`MyMoodz subscription API running on port ${PORT}`);
});
