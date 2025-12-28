// server.js

const express = require("express");
const cors = require("cors");

// 🧠 Notre moteur de cadeaux + stockage
const { resolveGift } = require("./core/giftEngine");
const {
  saveGiftChoice,
  getGiftChoiceForSubscription,
} = require("./core/customerGifts");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: "*", // MVP : on ouvrira éventuellement plus finement plus tard
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// --- Healthcheck basique ---
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "MyMoodz Subscription API",
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// --------------------------------------------------
// 1) Endpoint appellé par ta page "Gérer mon cadeau"
//    -> enregistre le choix du client
// --------------------------------------------------
app.post("/change-gift", (req, res) => {
  try {
    const { subscriptionId, customerId, giftCode } = req.body || {};

    if (!subscriptionId || !giftCode) {
      return res.status(400).json({
        ok: false,
        error: "subscriptionId et giftCode sont obligatoires",
      });
    }

    const record = saveGiftChoice({ subscriptionId, customerId, giftCode });

    return res.json({
      ok: true,
      message: "Choix de cadeau enregistré",
      data: record,
    });
  } catch (err) {
    console.error("[change-gift] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Erreur interne",
    });
  }
});

// --------------------------------------------------
// 2) Endpoint pour "résoudre" le cadeau final
//    (sera utilisé par le webhook plus tard)
// --------------------------------------------------
app.post("/gift/resolve", (req, res) => {
  try {
    const {
      subscriptionId,
      flavorCode,
      subscriptionFreeGiftCode,
    } = req.body || {};

    // On regarde s'il y a déjà un choix client enregistré
    let customerGiftCode = null;
    if (subscriptionId) {
      const existing = getGiftChoiceForSubscription(subscriptionId);
      if (existing && existing.giftCode) {
        customerGiftCode = existing.giftCode;
      }
    }

    // On laisse le moteur décider
    const gift = resolveGift({
      flavorCode: flavorCode || null,
      customerGiftCode,
      subscriptionFreeGiftCode: subscriptionFreeGiftCode || null,
    });

    return res.json({
      ok: true,
      gift,
    });
  } catch (err) {
    console.error("[gift/resolve] error:", err);
    return res.status(500).json({
      ok: false,
      error: "Erreur interne",
    });
  }
});

// --------------------------------------------------
// 3) Endpoint de debug pour voir ce qui est stocké
// --------------------------------------------------
app.get("/debug/gifts/:subscriptionId", (req, res) => {
  const { subscriptionId } = req.params;
  const record = getGiftChoiceForSubscription(subscriptionId);
  return res.json({
    ok: true,
    data: record || null,
  });
});

// Lancement du serveur
app.listen(PORT, () => {
  console.log(`MyMoodz subscription API listening on port ${PORT}`);
});
