// server.js

const express = require("express");
const cors = require("cors");

const {
  getFlavorForSubscription,
  getDefaultGiftForFlavor,
} = require("./core/giftEngine");

const {
  saveGiftChoice,
  getGiftChoiceForSubscription,
  listAllGiftChoices,
} = require("./core/customerGifts");

const app = express();
const PORT = process.env.PORT || 3000;

// ----- Middlewares -----
app.use(
  cors({
    origin: [
      "https://mymoodz.co",
      "https://www.mymoodz.co",
      "https://mymoodz.fr",
      "https://www.mymoodz.fr",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);

// Pour lire le JSON envoyé par le front
app.use(express.json());

// ----- Routes de base -----
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "MyMoodz Subscription API",
  });
});

// ----- Route principale : choix de cadeau -----
app.post("/api/gift-choice", (req, res) => {
  try {
    const {
      subscriptionId, // ex: "1050" (ou ID interne temporaire)
      customerId,
      flavorCode, // ex: "BN"
      giftCode,   // optionnel : si non fourni, on en déduit un par défaut
    } = req.body || {};

    if (!subscriptionId) {
      return res
        .status(400)
        .json({ ok: false, error: "missing-subscription-id" });
    }

    // 1) Si pas de giftCode explicite, on en déduit un à partir de la flavor
    let finalGiftCode = giftCode || null;

    if (!finalGiftCode) {
      const flavor =
        flavorCode || getFlavorForSubscription(subscriptionId) || null;

      finalGiftCode = flavor ? getDefaultGiftForFlavor(flavor) : null;
    }

    if (!finalGiftCode) {
      return res
        .status(400)
        .json({ ok: false, error: "missing-gift-code-and-flavor" });
    }

    // 2) On stocke le choix en mémoire
    const saved = saveGiftChoice({
      subscriptionId,
      customerId,
      giftCode: finalGiftCode,
    });

    return res.json({ ok: true, data: saved });
  } catch (err) {
    console.error("[/api/gift-choice] error:", err);
    return res.status(500).json({ ok: false, error: "server-error" });
  }
});

// ----- Alias de compatibilité : /change-gift -----
app.post("/change-gift", (req, res) => {
  // On réutilise exactement la même logique que /api/gift-choice
  req.url = "/api/gift-choice";
  app._router.handle(req, res);
});

// ----- Debug : un abonnement précis -----
app.get("/debug/gifts/:subscriptionId", (req, res) => {
  const { subscriptionId } = req.params;
  const record = getGiftChoiceForSubscription(subscriptionId);

  if (!record) {
    return res.status(404).json({ ok: false, error: "not-found" });
  }
  return res.json({ ok: true, data: record });
});

// ----- Debug : tous les choix enregistrés -----
app.get("/debug/gifts", (req, res) => {
  const all = listAllGiftChoices();
  return res.json({ ok: true, data: all });
});

// ----- Start -----
app.listen(PORT, () => {
  console.log(`MyMoodz subscription API listening on port ${PORT}`);
});
