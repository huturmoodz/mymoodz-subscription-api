// server.js
const express = require("express");
const cors = require("cors");

const {
  saveGiftChoice,
  getGiftChoiceForSubscription,
  getAllGiftChoices,
} = require("./core/customerGifts");

const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares
app.use(cors());
app.use(express.json());

// Ping de base
app.get("/", (req, res) => {
  res.json({ ok: true, message: "MyMoodz Subscription API" });
});

/**
 * POST /change-gift
 * Body JSON :
 * {
 *   "subscriptionId": "TEST_SUB_1",
 *   "customerId": "123",        // optionnel
 *   "giftCode": "ESSENTIEL_BN"
 * }
 */
app.post("/change-gift", (req, res) => {
  console.log("[/change-gift] body =", req.body);

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
      data: record,
    });
  } catch (err) {
    console.error("[/change-gift] ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Internal server error",
    });
  }
});

/**
 * GET /debug/gifts
 * -> liste tous les choix enregistrés (MVP)
 */
app.get("/debug/gifts", (req, res) => {
  const all = getAllGiftChoices();
  res.json({ ok: true, data: all });
});

/**
 * GET /debug/gifts/:subscriptionId
 * -> détail pour un abonnement
 */
app.get("/debug/gifts/:subscriptionId", (req, res) => {
  const subId = req.params.subscriptionId;
  const record = getGiftChoiceForSubscription(subId);

  if (!record) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  res.json({ ok: true, data: record });
});

app.listen(PORT, () => {
  console.log(`MyMoodz Subscription API listening on port ${PORT}`);
});
