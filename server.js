const express = require('express');
const cors = require('cors');

const app = express();

// Autoriser ton site Shopify à appeler l'API
app.use(
  cors({
    origin: 'https://mymoodz.co', // ton domaine Shopify
    methods: ['GET', 'POST'],
  })
);

// Pour lire le JSON ET les formulaires classiques
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Simple check
app.get('/', (req, res) => {
  res.send('MyMOODz subscription API is running');
});

// Endpoint appelé par le formulaire "changer de cadeau"
app.post('/change-gift', (req, res) => {
  console.log('Received body:', req.body);

  const { customerEmail, subscriptionId, giftCode } = req.body;

  // Pour l’instant : juste une simulation
  // Plus tard on branchera ici l’API SEAL Subscription
  if (!subscriptionId || !giftCode) {
    return res.status(400).json({
      success: false,
      message: 'subscriptionId et giftCode sont requis',
    });
  }

  // Log pour debug
  console.log(
    `Demande de changement de cadeau: sub #${subscriptionId}, cadeau = ${giftCode}, email = ${customerEmail}`
  );

  // Réponse "OK" temporaire
  return res.json({
    success: true,
    message: 'Cadeau mis à jour (simulation, sans SEAL pour le moment)',
  });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
