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
6. Dans Supabase **Authentication → URL Configuration → Redirect URLs**, autorise `agrifresh://auth/callback` pour les confirmations e-mail qui doivent revenir dans l'appli native.
7. Redémarre Expo après une modification de `.env.local`.

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
3. Lance un déploiement. Quand il réussit, teste l’URL Vercel sur navigateur et vérifie catalogue, connexion, favoris, commandes et export PDF.
4. La branche `main` contient toujours l’ancienne version Vite du site pour éviter de la remplacer sans validation. La version Expo se déploie d’abord comme Preview depuis `expo-react-native`; après vérification, définis cette branche comme branche Production dans les paramètres Vercel ou fusionne la branche dans la branche Production utilisée par Vercel.

La version web partage les composants React Native via React Native Web. Les URL de confirmation Auth sur le web doivent également être autorisées dans Supabase **Authentication → URL Configuration → Redirect URLs**; l’URL `agrifresh://auth/callback` est destinée à l’application native et non au site web.

## Fonctionnalités mobiles présentes
- Catalogue Supabase, filtres par catégorie et recherche
- Affichage du catalogue de démonstration si le backend n'est pas configuré ou joignable
- Création de compte, connexion et déconnexion Supabase Auth
- Session conservée entre les ouvertures de l'application
- Panier conservé localement sur l'appareil
- Favoris et historique des commandes associés au compte client
- Commande enregistrée de façon transactionnelle via RPC, avec contrôle serveur des prix et stocks
- Reçu PDF partageable et statut de commande actualisé en temps réel lorsque la page Commandes est ouverte
- Paiement à la livraison; aucun prestataire de paiement par carte n'est encore intégré

Le reçu généré est un document récapitulatif informatif, pas une facture fiscale. Les taux de taxe et règles de facturation légale doivent être validés avant une exploitation commerciale. Le suivi en temps réel reçoit les changements effectués côté base; un écran d'administration pour les modifier reste à développer. Ne réexécute pas les scripts SQL sur une base déjà initialisée sans examiner leurs effets.
