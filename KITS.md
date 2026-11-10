# Kits recharge ZÉRO (Seal + Shopify)

Deux briques indépendantes :

## Brique A — Commandes (`core/kits/orderFlow.js`)
Webhook Shopify `orders/create` et `orders/updated` → `POST /webhooks/shopify/orders`.
1. La commande est mise en attente d'expédition dès sa création par une règle **Shopify Flow** (note `MMZ-KIT`),
   puis par le serveur s'il ne l'est pas encore (hold `mmz-kit`) → MyLink ne la prend pas, même si le serveur dort.
2. Vérifie la composition `_moodz_compose` (total = 4 boîtes × mois × quantité, saveurs connues).
3. Ajoute les boîtes saveur à 0 € à la commande (édition de commande, client non notifié).
4. Lève l'attente (uniquement les attentes `mmz-kit` / `MMZ-KIT`, jamais celles posées par d'autres), tag `mmz-kit-ok`.
5. Clôt la demande d'expédition qui ne contient que la ligne Recharge (rattachée à un emplacement hors MyLink). En cas de problème : reste en attente + tag `mmz-kit-erreur`.
Idempotent (rejouable). Rejouer à la main : `POST /admin/kits/orders/:id/reprocess` avec l'en-tête `x-admin-key`.

## Brique B — « Mes saveurs » (`core/kits/flavorsApi.js`)
`GET /kits/subscriptions` et `POST /kits/subscriptions/:id/composition`, jeton client signé par le thème
(section `mmz-mes-saveurs`). Remplace les boîtes dans l'abonnement Seal pour la prochaine livraison.

## Abonnement Seal (`core/kits/subscriptionKit.js`)
Webhooks Seal `subscription/created` (route existante) et `subscription/updated`
→ `POST /webhooks/seal/subscription-updated` : les boîtes à 0 € sont mises dans le contrat,
donc chaque renouvellement les contient. Changement de durée → proportions conservées.

## Variables d'environnement (Render)
| Variable | Rôle |
|---|---|
| `KITS_LIVE` | `true` pour activer la brique A (laisser `false` tant que pods-zero vend l'ancien ZÉRO) |
| `SHOPIFY_STORE_DOMAIN` | ex. `testshopilol.myshopify.com` (déjà présente) |
| `SHOPIFY_KITS_ACCESS_TOKEN` | jeton Admin API avec `read_orders`, `write_order_edits`, `write_merchant_managed_fulfillment_orders` (+ `write_third_party_fulfillment_orders` si MyLink est un service d'expédition) |
| `SHOPIFY_WEBHOOK_SECRET` | clé de signature des webhooks Shopify |
| `KITS_CUSTOMER_SECRET` | secret partagé avec la section « Mes saveurs » |
| `KITS_ADMIN_KEY` | clé pour rejouer une commande |
| `KITS_ALLOWED_ORIGINS` | facultatif, origines autorisées pour /kits |
| `GIFT_REQUIRE_TOKEN` | `true` pour protéger les routes cadeau historiques (après mise à jour de la page cadeau) |
| `KITS_CONFIG` | facultatif, JSON pour surcharger saveurs / variantes |

Tests : `npm test` (Shopify et Seal simulés).
