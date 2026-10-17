# AgriFresh — starter React + TSX + PWA

Starter d'interface pour une application de commande de jus et de produits agricoles.

## Prérequis
- Node.js LTS récent
- npm
- Un projet Supabase (pour activer le backend)

## Lancer le projet
```bash
npm install
npm run dev
```
Vite affiche l'adresse locale dans le terminal.

## Vérifier la compilation
```bash
npm run build
npm run preview
```

## Supabase
1. Crée un projet dans Supabase.
2. Dans le SQL Editor, examine puis exécute `supabase/schema.sql`. Le script crée les tables, les règles RLS, le trigger de profil et un catalogue d'exemple.
3. Copie `.env.example` vers `.env.local`.
4. Renseigne `VITE_SUPABASE_URL` et la clé publishable/anon du projet.
5. Redémarre Vite après modification du fichier d'environnement.
6. Dans Supabase, configure la confirmation par e-mail et les URL de redirection Auth pour ton environnement.

Les clés publiques Supabase peuvent être utilisées côté client uniquement avec des politiques RLS correctes. **Ne mets jamais une clé `service_role` dans `.env.local` d'une application frontend.**

## Déploiement sur Vercel
- Importe le dépôt GitHub dans Vercel; le framework Vite est détecté automatiquement.
- Commande de build : `npm run build` ; dossier de sortie : `dist`.
- Ajoute `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` dans les variables d'environnement Vercel pour chaque environnement utilisé, puis redéploie.
- Dans Supabase Auth, ajoute le domaine Vercel déployé aux URL de site et de redirection autorisées.
- Exécute `supabase/schema.sql` sur le projet Supabase utilisé par le déploiement.

## Générer l'application Android (APK)
1. Installe Android Studio, puis ajoute Android SDK Platform 36 via SDK Manager. Android Gradle Plugin 8.13 nécessite Java 17 ou plus récent; le JDK fourni avec Android Studio peut être utilisé.
2. Crée `.env.local` à la racine à partir de `.env.example` et renseigne l'URL Supabase et la clé publique anon/publishable. Ces variables sont intégrées à l'application lors du build; les variables Vercel ne sont pas automatiquement réutilisées.
3. Vérifie que `supabase/schema.sql` a été exécuté sur le projet Supabase visé et que RLS est activé. Le client Android utilise l'API Supabase avec la clé publique et les politiques RLS — jamais une connexion SQL directe ni la clé `service_role`.
4. Lance `npm run android:apk`. L'APK de débogage est généré dans `android/app/build/outputs/apk/debug/app-debug.apk`.
5. Pour installer sur un téléphone Android connecté avec le débogage USB activé, ouvre le projet avec `npm run android:open` dans Android Studio ou utilise `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.

Chaque changement du frontend ou des variables Supabase nécessite une nouvelle génération et distribution de l'APK. Pour publier sur Google Play, crée ensuite une version signée (AAB recommandé) depuis Android Studio; ne partage pas une clé de signature.

### Génération cloud de l'APK avec GitHub Actions
1. Dans GitHub, ouvre **Settings → Secrets and variables → Actions**, puis ajoute les secrets de dépôt `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY`. Utilise l'URL du projet et sa clé publique publishable/anon; ne crée jamais un secret `service_role` dans le workflow.
2. Pousse le workflow `.github/workflows/android-apk.yml` sur GitHub.
3. Ouvre **Actions → Build Android APK → Run workflow** et lance le workflow sur `main`.
4. Quand le workflow réussit, ouvre son exécution et télécharge l'artefact `agrifresh-debug-apk`.

Le workflow configure Node, Java et le SDK Android sur un runner GitHub, puis construit l'APK. L'artefact est un APK debug à tester/distribuer manuellement, pas une version signée pour Google Play.

## État actuel
- Écran d'accueil et catalogue responsive
- Recherche et filtres de catégories
- Chargement des produits actifs depuis Supabase (avec catalogue de démonstration si le backend n'est pas configuré ou joignable)
- Inscription client, connexion e-mail/mot de passe et déconnexion
- Création automatique du profil lors de l'inscription
- Panier interactif en mémoire
- Interface PWA configurée
- Schéma SQL initial avec profils, produits, commandes, lignes, historique, factures et paiements
- La commande réelle, le suivi en temps réel et la génération des factures restent à implémenter

## Étapes suivantes
1. Ajouter icônes PWA `public/pwa-192.png` et `public/pwa-512.png`.
2. Créer une RPC transactionnelle sécurisée pour valider prix, stock et commande.
3. Ajouter suivi de commande, factures PDF et notifications.
4. Ajouter l'espace d'administration web.
