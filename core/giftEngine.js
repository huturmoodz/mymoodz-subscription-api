// core/giftEngine.js

const GIFT_DEFINITIONS = {
  ESSENTIEL_BN: {
    code: "ESSENTIEL_BN",
    label: "Diffuseur Essentiel Gratuit - Bonnes Nuits",
    shopifyVariantId: "52035074490709",
    productHandle: "diffuseur-essentiel-bonnes-nuits-copie",
  },
};

const DEFAULT_GIFT_BY_FLAVOR = {
  BN: "ESSENTIEL_BN",
};

function getGiftDefinitionByCode(giftCode) {
  if (!giftCode) return null;
  return GIFT_DEFINITIONS[giftCode] || null;
}

function getDefaultGiftCodeForFlavor(flavorCode) {
  if (!flavorCode) return null;
  return DEFAULT_GIFT_BY_FLAVOR[flavorCode] || null;
}

function resolveGift({ flavorCode, customerGiftCode, subscriptionFreeGiftCode }) {
  if (customerGiftCode) {
    const def = getGiftDefinitionByCode(customerGiftCode);
    if (def) return def;
  }

  if (subscriptionFreeGiftCode) {
    const def = getGiftDefinitionByCode(subscriptionFreeGiftCode);
    if (def) return def;
  }

  const defaultCode = getDefaultGiftCodeForFlavor(flavorCode);
  if (defaultCode) {
    const def = getGiftDefinitionByCode(defaultCode);
    if (def) return def;
  }

  return null;
}

module.exports = {
  getGiftDefinitionByCode,
  getDefaultGiftCodeForFlavor,
  resolveGift,
};
