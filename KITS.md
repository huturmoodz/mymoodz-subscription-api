# Kits recharge ZÉRO (Seal + Shopify)

Deux briques indépendantes :

## Brique A — Commandes (`core/kits/orderFlow.js`)
Webhook Shopify `orders/create` et `orders/updated` → `POST /webhooks/shopify/orders`.
1. La commande est mise en attente d'expédition dès sa création par une règle **Shopify Flow** (note `MMZ-KIT`),
   puis par le serveur s'il ne l'est pas encore (hold `mmz-kit`) → MyLink ne la prend pas, même si le serveur dort.
2. Vérifie la composition `_moodz_compose` (total = 4 boîtes × mois × quantité, saveurs connues).
3. Ajoute les boîtes saveur à 0 € à la commande (édition de commande, client non notifié).
4. Lève l'attente (uniquement les attentes `mmz-kit` / `MMZ-KIT`, jamais celles posées par d'autres ni le délai
   logisticien `MMZ-DELAI-15`), tag `mmz-kit-ok`. Commande de test (`_mmz_test=1`) : attente `mmz-test` posée avant,
   sur toutes ses demandes d'expédition (y compris celle des boîtes ajoutées) → jamais transmise à MyLink.
5. Clôt la demande d'expédition qui ne contient que la ligne Recharge (rien de physique, MyLink ne l'enregistre pas),
   même si elle est encore retenue. En cas de problème : reste en attente + tag `mmz-kit-erreur`.
Idempotent (rejouable). Rejouer à la main : `POST /admin/kits/orders/:id/reprocess` avec l'en-tête `x-admin-key`.

## Brique B — « Mes saveurs » (`core/kits/flavorsApi.js`)
`GET /kits/subscriptions` et `POST /kits/subscriptions/:id/composition`, jeton client signé par le thème
(section `mmz-mes-saveurs`). Remplace les boîtes dans l'abonnement Seal pour la prochaine livraison.

## Abonnement Seal (`core/kits/subscriptionKit.js`)
Webhooks Seal `subscription/created` (route existante) et `subscription/updated`
→ `POST /webhooks/seal/subscription-updated` : les boîtes à 0 € sont mises dans le contrat,
donc chaque renouvellement les contient. Changement de durée → proportions conservées.

## Stock (`core/stock/sync.js`, `core/stock/compositions.json`)
Un seul compteur par article physique : MyLink met à jour le stock des 9 composants (boîtes ZÉRO, boîtes RITUEL,
diffuseur) sur leur **fiche maître** (`produits_maitres` : Boîte ZÉRO, Boîte RITUEL, diffuseur). Le serveur n'écrit
jamais sur une fiche maître. Il écrit :
- les **miroirs** (autre fiche avec le SKU d'un composant : recharges « 1 semaine », boîte cadeau) = stock du composant ;
- les **packs et recharges** (SKU de `compositions.json`, mêmes bundles que l'OMS v4 de MyLink) = nombre réalisable
  avec les composants (le plus limitant) ;
- le métachamp boutique `mymoodz.stock_boites` (stock par saveur), lu par le composeur (section `mmz-recharge-composer`),
  qui ne peut pas lire la Boîte ZÉRO (non publiée). Ignoré par le thème s'il a plus de 24 h.

Les ventes pas encore expédiées que Shopify n'a pas retirées de la fiche maître (packs, recharges, miroirs) sont déduites
(`STOCK_PENDING`), pour ne jamais vendre deux fois la même boîte entre la commande et la remontée MyLink.
Une fiche non suivie en stock n'est jamais modifiée : le rapport la liste (« stock non suivi ») ; on active son suivi
au moment d'allumer la synchro. Ancienne gamme : pas confiée à MyLink, absente de `compositions.json`, jamais touchée.
Aperçu sans rien écrire : `GET /admin/stock/preview` ; synchro immédiate : `POST /admin/stock/sync` (en-tête `x-admin-key`).

## Délai logisticien 15 min (`core/kits/delayGuard.js` + Shopify Flow)
- Flux Flow « Délai logisticien 15 minutes… » : à la création, met en attente (note `MMZ-DELAI-15`) chaque demande
  d'expédition qui a quelque chose à expédier (pas l'application numérique) ; libère au bout de 15 min, sauf tag
  `mmz-kit-erreur`, commande de test, ou commande du composeur pas encore traitée (`mmz-kit-ok` absent).
- Flux « Filet de sécurité… » : toutes les heures, libère ce qui serait resté retenu plus de 30 min, et prévient par e-mail.
- Serveur (`DELAY_GUARD_MINUTES=15`) : une demande d'expédition créée après coup (boîtes ajoutées, cadeau fidélité, offre
  après achat, ajout à la main) prend la même attente tant que la commande a moins de 14 min. Ne fait rien si la commande
  ne porte pas l'attente posée par Flow (flux désactivé).
- **À activer ensemble** : les 2 flux Flow + `DELAY_GUARD_MINUTES=15`.

## Variables d'environnement (Render)
| Variable | Rôle |
|---|---|
| `KITS_LIVE` | `true` pour activer la brique A (laisser `false` tant que pods-zero vend l'ancien ZÉRO) |
| `SHOPIFY_STORE_DOMAIN` | ex. `testshopilol.myshopify.com` (déjà présente) |
| `SHOPIFY_KITS_CLIENT_ID` | identifiant client de l'app « MyMOODz Recharges » (Dev Dashboard Shopify) |
| `SHOPIFY_KITS_CLIENT_SECRET` | secret client de cette app : le serveur en tire un jeton Admin renouvelé automatiquement (24 h), et vérifie avec lui les webhooks créés par l'app |
| `SHOPIFY_KITS_ACCESS_TOKEN` | (option de secours) jeton fixe d'une app héritée, utilisé seulement sans identifiants client |
| `SHOPIFY_WEBHOOK_SECRET` | (optionnel) secret des webhooks créés à la main dans Paramètres > Notifications |

Droits de l'app : `read_orders`, `write_orders`, `write_order_edits`, `write_merchant_managed_fulfillment_orders`, `write_third_party_fulfillment_orders`.
Au démarrage, le serveur abonne l'app au webhook « commande créée » vers `/webhooks/shopify/orders` s'il n'existe pas.
| `KITS_CUSTOMER_SECRET` | secret partagé avec la section « Mes saveurs » |
| `KITS_ADMIN_KEY` | clé pour rejouer une commande |
| `KITS_ALLOWED_ORIGINS` | facultatif, origines autorisées pour /kits |
| `GIFT_REQUIRE_TOKEN` | `true` pour protéger les routes cadeau historiques (après mise à jour de la page cadeau) |
| `KITS_CONFIG` | facultatif, JSON pour surcharger saveurs / variantes |
| `SHOPIFY_KITS_API_VERSION` | facultatif, version de l'API Admin (défaut `2026-10`) |
| `STOCK_SYNC_MODE` | `off` (défaut), `dry` (calcule et journalise, n'écrit rien), `live` (écrit) |
| `STOCK_PENDING` | `unfulfilled` (défaut : déduit toutes les ventes pas encore expédiées), `held` (seulement celles pas encore transmises à MyLink), `off` |
| `STOCK_LOCATION_ID` | facultatif : entrepôt lu et écrit (sinon celui dont le nom contient « MyLink », sinon le premier) |
| `STOCK_COMPONENT_MAP` | facultatif : JSON composant MyLink → SKU Shopify, si un composant a un autre SKU dans Shopify |
| `DELAY_GUARD_MINUTES` | `0` (défaut) ; `15` en même temps que les flux Flow du délai logisticien |

Droits supplémentaires pour le stock : `read_products`, `read_inventory`, `write_inventory`, `read_locations`, et l'écriture
du métachamp boutique (le rapport de synchro signale une erreur « métachamp » si elle est refusée).

Tests : `npm test` (Shopify et Seal simulés).
