# AgriFresh — React Native + Expo

Application mobile native Android/iOS construite avec Expo SDK 57 et React Native. Expo Go sert aux essais de développement; EAS Build génère l'APK installable dans le cloud.

## Développement avec Expo Go
1. Installe Node.js LTS et l'application **Expo Go** sur un téléphone Android.
2. Exécute `npm install` une première fois, puis `npx expo start` à la racine du projet.
3. Scanne le QR code avec Expo Go. L'ordinateur et le téléphone doivent être sur le même réseau; si nécessaire, lance `npx expo start --tunnel`.

Expo Go est l'environnement de test; ce n'est pas le fichier APK autonome. Utilise EAS Build ci-dessous pour générer celui-ci.

## Supabase
1. Crée `.env.local` à la racine depuis `.env.example`.
2. Renseigne `EXPO_PUBLIC_SUPABASE_URL` et `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` avec les valeurs de **Connect** dans le tableau de bord Supabase.
3. Dans le SQL Editor Supabase, exécute `supabase/schema.sql` une seule fois si le schéma n'est pas déjà installé. Vérifie les politiques RLS avant d'utiliser des données réelles.
4. Exécute ensuite `supabase/migrations/20261017_customer_features.sql` une seule fois dans le SQL Editor. Cette migration ajoute les favoris et la fonction RPC transactionnelle de commande.
5. Exécute ensuite `supabase/migrations/20261017_invoice_realtime.sql` une seule fois. Elle crée les reçus de commande et active la publication des changements de statut.
6. Exécute ensuite `supabase/migrations/20261017_staff_orders.sql` (rôle personnel, rôle non modifiable par le client).
7. Exécute **seul** `supabase/migrations/20261018_b2b_1_enums.sql` (nouveaux statuts et rôle livreur), puis `supabase/migrations/20261018_b2b_2_flow.sql` (fiches clients, points de livraison, QR codes, décisions du personnel, livraison par scan, messagerie). Le second fichier peut être relancé sans risque.
   Puis `supabase/migrations/20261019_invoices_delivery_notes.sql` : TVA par produit, options de fiche (prix affichés, réception par QR client, facturation automatique ou manuelle), factures et livraison en deux scans. Renseigne ensuite le taux de TVA de chaque produit dans **Table Editor → products → vat_rate** (0, 7, 13 ou 19) et les coordonnées légales d'AgriFresh dans `src/config/company.ts`.
   Puis **seul** `supabase/migrations/20261020_1_enums.sql` (statut « À reconfirmer »), puis `supabase/migrations/20261020_2_reconfirm_drafts.sql` (reconfirmation par le client, brouillons de facture, origine des produits, gestion du catalogue, réclamations).
   Puis **seul** `supabase/migrations/20261021_1_roles.sql` (rôles superviseur et production), puis `supabase/migrations/20261021_2_planning_stock.sql` (rôles et droits, file de production, options de stock par client, gestion de l'équipe). Les anciens comptes « staff » deviennent superviseurs ; nomme ensuite un administrateur (requête en fin de fichier) qui gérera les comptes depuis l'onglet **Admin → Comptes** (ajout direct, validation, rôle, désactivation).
   Puis `supabase/migrations/20261022_permissions.sql` : droits par profil (oui/non par fonctionnalité), réglables par l'administrateur dans **Admin → Profils et droits** et appliqués aussi par la base de données.
   Puis `supabase/migrations/20261023_accounts.sql` : administration des comptes (liste, validation de l'e-mail, désactivation qui bloque la connexion et tous les droits).
   Puis `supabase/migrations/20261024_account_status.sql` : validation des comptes par l'administrateur (en attente, actif, refusé, suspendu). Désactive ensuite **Authentication → Providers → Email → Confirm email** : une inscription crée un compte « en attente » que l'administrateur valide dans **Admin → Comptes** ; un compte créé par l'administrateur est actif tout de suite.
   Puis `supabase/migrations/20261025_alerts.sql` : onglet **Alertes**, notifications sur l'écran de verrouillage (Expo Push) et e-mails (Resend), envoyés par la base avec pg_net. Réglages dans **Admin → Alertes et e-mails** (événements, expéditeur, clé API stockée dans Vault) et **Compte → Notifications** (choix de chacun). Pour Android, les notifications d'écran de verrouillage demandent un projet Firebase : `google-services.json` à la racine, `"googleServicesFile": "./google-services.json"` dans `app.json` (android), et la clé FCM V1 importée dans EAS (`npx eas-cli credentials`).

   Puis `supabase/migrations/20261026_staff_orders.sql` : l'administrateur et le superviseur peuvent passer une commande pour un client (droit « Passer une commande pour un client »), et le livreur expédie lui-même les commandes préparées au moment de les récupérer (onglet **Livraisons → À récupérer**).

   Puis `supabase/migrations/20261027_settings_fleet_audit.sql` :
   - **paramétrage par thème** (Admin → Paramétrage) : chaque onglet et chaque droit se règle par profil, puis par utilisateur (exception) ; les onglets client aussi par fiche client ;
   - **options des clients** : une valeur commune à tous les clients (prix, origine, stock, historique visible, reconfirmation des commandes rouvertes, scan du bon, scan du QR client, QR de réception, facturation), que chaque fiche peut remplacer ;
   - **flotte** (Admin → Flotte) et **expéditions groupées** : le livreur coche plusieurs bons et choisit le véhicule ;
   - **journal des actions** (Admin → Journal) : chaque modification, son auteur et sa date ;
   - **accueil paramétrable** : par profil (administrateur) puis par utilisateur.

   Exécute-la **avant** de déployer cette version de l'application : les écrans lisent ses nouvelles colonnes.

   Puis `supabase/migrations/20261028_alert_important.sql` : étoile « importante » sur les alertes (filtre *Importantes*). Toucher une alerte ouvre directement la commande, la conversation, les factures ou le compte concerné, depuis l'onglet Alertes comme depuis la notification de l'écran de verrouillage.

   Puis `supabase/migrations/20261029_team_messages.sql` : **messagerie d'équipe** (Messages → Équipe). « Nouveau message » propose quatre choix : une personne, plusieurs personnes (groupe nommé), un profil (tous les livreurs, toute la production…) ou toute l'équipe. Invisible des clients ; chaque message crée une alerte qui ouvre la conversation. Droit « Messagerie entre membres de l'équipe » dans Admin → Paramétrage → Messages et factures.

   Puis, dans l'ordre :
   - `20261030_numbering_returns.sql` : numérotation des documents (Paramétrage → Numérotation : préfixe, année, chiffres, numéro de départ), retours et avoirs, notes et « non lu » sur les alertes ;
   - `20261031_billing_decisions.sql` : règlements partiels et multi-moyens, relances de paiement (activables par client, désactivables par le client si autorisé), fréquence de facturation par client, pastilles « suivi spécial » et « à reprogrammer », messages à répondre ;
   - `20261101_message_attachments.sql` : photos, vidéos, messages vocaux et documents dans les messages (stockage Supabase, dossier privé « attachments ») ;
   - `20261102_needs_reply.sql` : « nécessite une réponse » sur tous les messages, ajout de participants à une discussion d'équipe.
   - `20261103_location_reminders_leaves.sql` : localisation des comptes (avec l'accord de chacun, seulement application ouverte), rappels et alarmes, calendrier, congés (validation activable par l'admin), incidents de livraison et de véhicule, droit « Statistiques ».
8. Comptes personnel et livreur : crée le compte dans l'appli (« Activer mon accès »), puis exécute dans le SQL Editor `update public.profiles set role = 'staff' where id = (select id from auth.users where email = 'adresse@exemple.com');` (ou `'driver'` pour un livreur). La validation par l'administrateur (Admin → Comptes) empêche quelqu'un d'utiliser l'accès d'un client avec son e-mail.
9. Dans Supabase **Authentication → URL Configuration → Redirect URLs**, autorise `agrifresh://auth/callback` pour les confirmations e-mail qui doivent revenir dans l'appli native.
10. Redémarre Expo après une modification de `.env.local`.

L'application accède à la base via l'API Supabase et les règles RLS; elle n'ouvre jamais de connexion PostgreSQL directe. Seule une clé Publishable/anon peut être intégrée au client. **N'utilise jamais une clé `secret` ou `service_role` dans l'application.** Les sessions Auth sont conservées sur l'appareil avec AsyncStorage.

## Générer l'APK Android dans le cloud (EAS Build)
1. Crée un compte gratuit sur [expo.dev](https://expo.dev/signup), puis connecte-toi avec `npx eas-cli@latest login`.
2. Depuis le dossier du projet, lance `npx eas-cli@latest build:configure` et accepte la création/l'association du projet Expo si demandé.
3. Dans les paramètres du projet sur [expo.dev](https://expo.dev), ajoute ces variables d'environnement pour l'environnement **preview** : `EXPO_PUBLIC_SUPABASE_URL` et `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Ce sont des variables client publiques; n'ajoute jamais de clé `service_role`.
4. Lance `npm run build:apk`. À la première compilation, accepte la génération des identifiants Android EAS si demandé.
5. Suis l'URL EAS affichée dans le terminal. À la fin, télécharge l'APK depuis la page du build et installe-le sur ton appareil Android.

Le profil `preview` dans `eas.json` produit un `.apk` distribuable directement pour les tests. Le profil `production` produit un Android App Bundle (`.aab`) pour Google Play. Une adhésion Google Play est requise uniquement pour publier sur le store.

## Générer l'APK sur ce PC (sans EAS)
`npm.cmd run apk` compile l'APK localement (Android Studio installé : son SDK est utilisé, et un Java 17 portable est téléchargé une seule fois). L'APK arrive dans `dist-apk/`.

La signature utilise la clé EAS pour que l'appli se mette à jour par-dessus l'installation existante : récupère-la une fois avec `npx.cmd eas-cli@latest credentials` → Android → preview → « credentials.json » → « Download credentials from EAS to credentials.json ». `credentials.json` et le dossier `credentials/` restent hors de git ; garde-en une copie de sauvegarde. Sans eux, `npm.cmd run apk -- --debug-sign` produit un APK de test (désinstaller l'appli avant de l'installer).

## Déployer la version web Expo sur Vercel
1. Dans Vercel, importe le dépôt GitHub et choisis la branche `expo-react-native`. Le fichier `vercel.json` configure `npm ci`, `npm run build:web` et le dossier `dist`.
2. Dans **Project Settings → Environment Variables**, ajoute `EXPO_PUBLIC_SUPABASE_URL` et `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` pour **Production**, **Preview** et **Development** selon les environnements utilisés. Vercel ne lit pas `.env.local` du poste de développement.
3. Lance un déploiement. Quand il réussit, teste l’URL Vercel sur navigateur et vérifie connexion, commande, suivi, messages et export PDF.
4. La branche `main` est déployée en production ; `expo-react-native` produit des déploiements Preview.

La version web partage les composants React Native via React Native Web. Les URL de confirmation Auth sur le web doivent également être autorisées dans Supabase **Authentication → URL Configuration → Redirect URLs**; l’URL `agrifresh://auth/callback` est destinée à l’application native et non au site web.

## Fonctionnement
Application de commande professionnelle pour des clients connus et récurrents.

**Client** (compte rattaché à une fiche créée par AgriFresh)
- **Commander** : liste des produits avec saisie directe des quantités, nouveautés mises en avant, origine des produits si la fiche l'active, reprise d'une ou plusieurs commandes précédentes pour remplir le panier, panier vidé après l'envoi. Aucune information à ressaisir : l'adresse vient de la fiche. Le point de livraison n'est demandé que si la fiche en compte plusieurs. Date de livraison souhaitée facultative.
- **Commandes** : historique filtrable par statut, statut en temps réel avec historique détaillé (qui, quand, motif), reconfirmation des commandes rouvertes par AgriFresh, réclamations, bon de livraison, QR de réception si la fiche l'exige.
- **Factures** : factures émises, à régler ou réglées, consultables en PDF.
- **Messages** : échange direct avec l'équipe AgriFresh.

**Rôles internes** : *administrateur* (tout, seul à créer des clients et à gérer l'équipe), *superviseur* (commandes, planification, factures, réclamations, messages), *production* (onglet Production uniquement), *livreur*.

**Navigation** : barre du bas : Accueil, À décider, Production (feuillets En cours · Clôturées · Production · Planning), Facturation, Livraisons et Plus (rubriques, personnaliser l'accueil, compte, affichage, notifications, autorisations, produits, clients). Messages et Alertes sont en haut de l'écran avec une pastille. **À décider** regroupe ce qui est en suspens : commandes en attente, suivis spéciaux, à reprogrammer, réclamations, messages à répondre, facturation à faire, factures en retard, retours, comptes à valider.

**Administrateur et superviseur**
- **Commander** : choisir un client puis saisir sa commande comme lui (prix, origine et stock visibles) ; le client la retrouve dans son historique et en est averti.
- **Commandes** : recherche et bouton *Filtres* (jour de livraison, étape). *À décider* : accepter en choisissant la place dans la file de production, mettre en attente, décliner, proposer à reconfirmer. *En cours* dans l'ordre d'exécution (bouton *Déplacer*), *Réclamations*, *Historique*.
- **Production** : comme l'équipe de production.
- **Clients** : fiches (création par l'administrateur), e-mail de connexion, matricule fiscal, options (prix affichés, origine, gestion et affichage du stock, réception par QR client, facturation), points de livraison, impression des QR codes, partage de l'invitation.
- **Factures** : brouillons modifiables puis validation (numéro attribué à la validation), PDF, suivi payé / à encaisser.
- **Produits** (onglet Compte) : création, prix, TVA, stock, disponibilité, origine et qualité.
- **Messages** : une conversation par client, compteur de non-lus.

**Production** : *À préparer* (totaux par produit à cocher, dépliables par client), *File d'exécution* dans l'ordre fixé par l'administration (Commencer / Prête), *Historique* des préparations filtrable.

**Livreur** (`driver`) : *À récupérer* (cocher les bons chargés, choisir le véhicule, « Expédier »), *À livrer* groupé par client (cocher puis « Livrer » : scans selon les options du client), *À livrer* (commandes expédiées) et *Historique* filtrable par client, période et tranche horaire. Remise en deux scans : le QR de chaque bon de livraison, puis le QR du client — celui collé au point de livraison, ou le QR de réception affiché dans l'appli du client si sa fiche l'exige.

**Documents**
- *Bon de livraison* (BL-000123) : un par commande, avec QR code et zones de signature ; prix masqués si la fiche du client le demande.
- *Facture* (FA-2026-00001) : regroupe un ou plusieurs BL acceptés d'un client ; TVA par produit (prix HT), timbre fiscal, net à payer TTC. Créée automatiquement à l'acceptation pour les fiches en facturation automatique, sinon par le personnel depuis l'onglet **Factures**. Annuler une facture libère ses BL.

Statuts : Nouvelle → Acceptée / En attente / Déclinée (→ À reconfirmer → reconfirmée par le client) → En préparation → Préparée → Expédiée → Livrée (uniquement par les deux scans). Un refus ou une annulation remet le stock.

Les nouveaux produits s'ajoutent depuis **Compte → Gérer les produits** et sont affichés comme *Nouveau* pendant 30 jours. Les documents (BL, factures, étiquettes QR) s'ouvrent d'abord en aperçu : téléchargement PDF ou impression sur le web, impression ou partage sur mobile.

**Stock** : chaque produit a un stock (Compte → Gérer les produits). Pour un client en *gestion du stock*, ses commandes sont limitées au stock disponible et le réservent ; un refus ou une annulation le rend. Sans gestion du stock, ses commandes ne sont pas limitées (production à la demande). *Afficher le stock* montre au client les quantités disponibles. Vérifie les mentions légales des factures (coordonnées, matricule fiscal, taux de TVA) avec ton comptable avant de les émettre.
