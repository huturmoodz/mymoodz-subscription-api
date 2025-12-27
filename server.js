// server.js
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Liste officielle des cadeaux acceptés
const ALLOWED_GIFTS = ["pod_zero", "pod_bonne_nuit", "pod_bien_etre"];

/**
 * PHASE 1 :
 * Fake function – remplacera la vraie API Seal plus tard
 */
async function updateGiftInSeal(subscriptionId, giftCode) {
  console.log("📦 [FAKE] Mise à jour dans Seal: ", subscriptionId, giftCode);
  return true;
}

app.post("/change-gift", async (req, res) => {
  console.log("📩 Nouveau /change-gift reçu :", req.body);

  const { giftCode, subscriptionId, customerEmail } = req.body;

  // 1️⃣ Validation inputs
  if (!subscriptionId || !customerEmail || !giftCode) {
    return res.status(400).json({
      success: false,
      message: "Champs manquants. Requête invalide.",
    });
  }

  // 2️⃣ Validation cadeau
  if (!ALLOWED_GIFTS.includes(giftCode)) {
    return res.status(400).json({
      success: false,
      message: `Code cadeau invalide : ${giftCode}`,
    });
  }

  try {
    /**
     * 3️⃣ Appel logique (fake pour le moment)
     */
    const ok = await updateGiftInSeal(subscriptionId, giftCode);
    if (!ok) {
      return res.status(500).json({
        success: false,
        message: "Erreur interne — impossible de mettre à jour dans Seal.",
      });
    }

    return res.json({
      success: true,
      message: "Votre cadeau a bien été mis à jour (mode test).",
    });
  } catch (err) {
    console.error("❌ ERREUR change-gift:", err);
    return res.status(500).json({
      success: false,
      message: "Erreur technique serveur.",
    });
  }
});

app.listen(PORT, () =>
  console.log(`🚀 API MyMoodz démarrée sur port ${PORT}`)
);
