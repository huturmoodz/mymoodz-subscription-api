// core/seal.js
const axios = require("axios");

const BASE = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${process.env.SHOPIFY_API_VERSION}`;

const shopifyHeaders = {
  "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  "Content-Type": "application/json",
};

// Exemple: update metafield "gift_choice" sur un abonnement Seal
async function updateSealSubscriptionGift(subscriptionId, giftCode) {
  try {
    const res = await axios.put(
      `${BASE}/subscriptions/${subscriptionId}.json`,
      {
        subscription: {
          id: subscriptionId,
          metafields: [
            { key: "gift_choice", value: giftCode, type: "single_line_text_field" }
          ],
        },
      },
      { headers: shopifyHeaders }
    );
    return res.data;
  } catch (e) {
    console.error("Error Seal Update:", e.response?.data || e.message);
    throw e;
  }
}

module.exports = { updateSealSubscriptionGift };
