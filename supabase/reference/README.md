# Base de données : référence et règles

## Installer ou mettre à jour

1. Une base neuve : exécuter `supabase/schema.sql`, puis toutes les migrations de `supabase/migrations/` dans l'ordre de leur nom.
2. Une base existante : coller `supabase/check_migrations.sql` dans l'éditeur SQL de Supabase. Il affiche « OK » ou « À EXÉCUTER » pour chaque migration. Exécuter celles qui manquent, dans l'ordre.

Chaque migration peut être relancée sans risque.

## `functions_current.sql`

C'est la définition actuelle de chaque fonction, une fois toutes les migrations installées. Elle est générée depuis la base de test. Ce fichier ne s'exécute pas : il sert de référence.

## Règles pour les nouvelles migrations

- Pour modifier une fonction, recopier sa définition complète depuis `functions_current.sql`, la modifier, puis la redéfinir en entier avec `create or replace function`.
- Ne plus modifier le texte d'une fonction avec `replace(pg_get_functiondef(...))`. Cette méthode dépend des retours à la ligne et de l'ordre des migrations : c'est elle qui causait des erreurs.
- Après chaque migration, régénérer `functions_current.sql` et ajouter une ligne dans `check_migrations.sql`.
