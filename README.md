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
8. Comptes personnel et livreur : crée le compte dans l'appli (« Activer mon accès »), puis exécute dans le SQL Editor `update public.profiles set role = 'staff' where id = (select id from auth.users where email = 'adresse@exemple.com');` (ou `'driver'` pour un livreur). Garde **Confirm email** activé dans Supabase Auth : c'est ce qui empêche quelqu'un d'activer l'accès d'un client avec son e-mail.
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

## Déployer la version web Expo sur Vercel
1. Dans Vercel, importe le dépôt GitHub et choisis la branche `expo-react-native`. Le fichier `vercel.json` configure `npm ci`, `npm run build:web` et le dossier `dist`.
2. Dans **Project Settings → Environment Variables**, ajoute `EXPO_PUBLIC_SUPABASE_URL` et `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` pour **Production**, **Preview** et **Development** selon les environnements utilisés. Vercel ne lit pas `.env.local` du poste de développement.
3. Lance un déploiement. Quand il réussit, teste l’URL Vercel sur navigateur et vérifie connexion, commande, suivi, messages et export PDF.
4. La branche `main` est déployée en production ; `expo-react-native` produit des déploiements Preview.

La version web partage les composants React Native via React Native Web. Les URL de confirmation Auth sur le web doivent également être autorisées dans Supabase **Authentication → URL Configuration → Redirect URLs**; l’URL `agrifresh://auth/callback` est destinée à l’application native et non au site web.

## Fonctionnement
Application de commande professionnelle pour des clients connus et récurrents.

**Client** (compte rattaché à une fiche créée par AgriFresh)
- **Commander** : liste des produits avec saisie directe des quantités, nouveautés mises en avant, reprise de la dernière commande, brouillon conservé sur l'appareil. Aucune information à ressaisir : l'adresse vient de la fiche. Le point de livraison n'est demandé que si la fiche en compte plusieurs. Date de livraison souhaitée facultative.
- **Commandes** : historique, statut en temps réel, motif en cas d'attente ou de refus, bon de commande PDF.
- **Messages** : échange direct avec l'équipe AgriFresh.

**Personnel** (`staff` / `admin`)
- **Commandes** : *À décider* (accepter, mettre en attente, décliner avec motif), *En cours* (préparation → préparée → expédiée), *Quantités à préparer* (totaux par produit), *Historique*.
- **Clients** : fiches, e-mail de connexion, points de livraison, impression des QR codes, partage de l'invitation.
- **Messages** : une conversation par client, compteur de non-lus.

**Livreur** (`driver`) : liste des commandes expédiées et scan du QR code collé au point de livraison. Le livreur coche les commandes remises ; elles passent en *Livrée* avec l'heure et le livreur.

Statuts : Nouvelle → Acceptée / En attente / Déclinée → En préparation → Préparée → Expédiée → Livrée (uniquement par scan). Un refus ou une annulation remet le stock.

Les nouveaux produits s'ajoutent dans Supabase (**Table Editor → products**) et sont affichés comme *Nouveau* pendant 30 jours. Le document PDF est un récapitulatif informatif, pas une facture fiscale.
