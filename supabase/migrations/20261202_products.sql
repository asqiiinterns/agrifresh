-- Products (asked 2026-10-21):
--   * identifiers: the Pro's own reference (sku, unique in the Pro), a barcode (GTIN / EAN 8, 12, 13 or 14 digits) and an
--     Appro+ code given to every product (AP-000123), the same for every Pro;
--   * product sheets per type: Appro+ defines the fields of each category (list of choices, number or text), a
--     sub-category adds its own to those of its category; the Pro fills them in (attributes);
--   * import of a full or partial file (Excel/CSV): only the columns present change, a product is found by its id, its
--     reference or its barcode, new ones are created; every import is kept with what it changed (history);
--   * presets of the catalogue PDF (photo, prices, origin…) saved for the Pro.
-- Run AFTER 20261201_role_layouts.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- 1. Identifiers
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists sku text;
alter table public.products add column if not exists gtin text;
alter table public.products add column if not exists platform_code text;
alter table public.products add column if not exists attributes jsonb not null default '{}'::jsonb;
create sequence if not exists public.product_code_seq;

create or replace function public.fill_product_code()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.platform_code is null then
    new.platform_code := 'AP-' || lpad(nextval('public.product_code_seq')::text, 6, '0');
  end if;
  new.sku := nullif(btrim(coalesce(new.sku, '')), '');
  new.gtin := nullif(regexp_replace(coalesce(new.gtin, ''), '\s', '', 'g'), '');
  if new.gtin is not null and new.gtin !~ '^(\d{8}|\d{12}|\d{13}|\d{14})$' then
    raise exception using errcode = '22023', message = 'Code-barres invalide : 8, 12, 13 ou 14 chiffres.';
  end if;
  if new.sku is not null and char_length(new.sku) > 40 then
    raise exception using errcode = '22023', message = 'Référence trop longue (40 caractères au plus).';
  end if;
  return new;
end;
$$;
drop trigger if exists a_fill_product_code on public.products;
create trigger a_fill_product_code before insert or update of sku, gtin, platform_code on public.products for each row execute function public.fill_product_code();

DO $$
DECLARE
  r record;
BEGIN
  PERFORM set_config('appro.link_write', 'on', true);
  FOR r IN select id from public.products where platform_code is null order by created_at, id LOOP
    UPDATE public.products SET platform_code = 'AP-' || lpad(nextval('public.product_code_seq')::text, 6, '0') WHERE id = r.id;
  END LOOP;
  PERFORM set_config('appro.link_write', 'off', true);
END;
$$;
create unique index if not exists products_platform_code_idx on public.products(platform_code);
create unique index if not exists products_org_sku_idx on public.products(org_id, lower(sku)) where sku is not null;

-- ---------------------------------------------------------------------------
-- 2. Product sheets per category (Appro+)
-- ---------------------------------------------------------------------------
alter table public.categories add column if not exists attributes jsonb not null default '[]'::jsonb;

-- The fields of a category: those of its parent category, then its own.
create or replace function public.category_fields(p_category_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.attributes from public.categories c join public.categories p on p.id = c.parent_id where c.id = p_category_id), '[]'::jsonb)
      || coalesce((select c.attributes from public.categories c where c.id = p_category_id), '[]'::jsonb);
$$;
REVOKE ALL ON FUNCTION public.category_fields(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.category_fields(uuid) TO authenticated;

-- [{ "key", "label", "type": "list" | "number" | "text", "options": [...], "unit" }]
create or replace function public.platform_set_category_fields(p_category_id uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field jsonb;
  v_keys text[] := '{}';
  v_clean jsonb := '[]'::jsonb;
  v_key text;
begin
  if not public.platform_can('platform.catalog') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère les fiches produits.';
  end if;
  if jsonb_typeof(p_fields) is distinct from 'array' or jsonb_array_length(p_fields) > 20 then
    raise exception using errcode = '22023', message = 'Vingt champs au plus.';
  end if;
  for v_field in select * from jsonb_array_elements(p_fields) loop
    if char_length(btrim(coalesce(v_field ->> 'label', ''))) not between 1 and 40 then
      raise exception using errcode = '22023', message = 'Chaque champ a un nom de 1 à 40 caractères.';
    end if;
    if coalesce(v_field ->> 'type', 'list') not in ('list', 'number', 'text') then
      raise exception using errcode = '22023', message = 'Type de champ inconnu.';
    end if;
    if coalesce(v_field ->> 'type', 'list') = 'list' and (jsonb_typeof(v_field -> 'options') is distinct from 'array' or jsonb_array_length(v_field -> 'options') = 0) then
      raise exception using errcode = '22023', message = format('« %s » : ajoutez les choix de la liste.', v_field ->> 'label');
    end if;
    v_key := coalesce(nullif(btrim(v_field ->> 'key'), ''),
      trim(both '_' from regexp_replace(lower(translate(btrim(v_field ->> 'label'), 'àâäçéèêëîïôöùûüÿœæ', 'aaaceeeeiioouuuyoa')), '[^a-z0-9]+', '_', 'g')));
    if v_key = any(v_keys) then
      raise exception using errcode = '22023', message = format('Deux champs s’appellent « %s ».', v_field ->> 'label');
    end if;
    v_keys := v_keys || v_key;
    v_clean := v_clean || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('key', v_key, 'label', btrim(v_field ->> 'label'),
      'type', coalesce(v_field ->> 'type', 'list'), 'options', case when coalesce(v_field ->> 'type', 'list') = 'list' then v_field -> 'options' end,
      'unit', nullif(btrim(coalesce(v_field ->> 'unit', '')), ''))));
  end loop;
  update public.categories set attributes = v_clean, updated_at = now() where id = p_category_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Catégorie introuvable.';
  end if;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_set_category_fields(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_category_fields(uuid, jsonb) TO authenticated;

create or replace function public.platform_categories()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'parent_id', c.parent_id, 'sort_order', c.sort_order, 'active', c.active,
    'attributes', c.attributes, 'products', (select count(*) from public.products p where p.category_id = c.id)) order by c.sort_order, c.name), '[]'::jsonb)
  from public.categories c where public.platform_can('platform.catalog');
$$;
REVOKE ALL ON FUNCTION public.platform_categories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_categories() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Import (full or partial) with history
-- ---------------------------------------------------------------------------
create table if not exists public.product_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  imported_by uuid references public.profiles(id) on delete set null,
  imported_at timestamptz not null default now(),
  file_name text,
  created int not null default 0,
  updated int not null default 0,
  unchanged int not null default 0,
  ignored int not null default 0,
  changes jsonb not null default '[]'::jsonb
);
alter table public.product_imports enable row level security;
drop policy if exists "product_imports_read" on public.product_imports;
create policy "product_imports_read" on public.product_imports for select to authenticated using (public.org_visible(org_id));

-- p_rows: [{ id?, sku?, gtin?, name?, description?, category?, unit_label?, price?, vat_rate?, stock_quantity?, active?,
--            origin_producer?, origin_region?, origin_label?, origin_note?, attributes? }] — only the keys present change.
create or replace function public.products_import(p_file text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.acting_supplier_org_id();
  v_row jsonb;
  v_index int := 0;
  v_product public.products%rowtype;
  v_found boolean;
  v_category uuid;
  v_before jsonb;
  v_after jsonb;
  v_text_keys text[] := array['name', 'description', 'unit_label', 'sku', 'gtin', 'origin_producer', 'origin_region', 'origin_label', 'origin_note'];
  v_key text;
  v_changes jsonb := '[]'::jsonb;
  v_ignored jsonb := '[]'::jsonb;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_import uuid;
  v_num numeric;
begin
  if v_org is null or not public.has_feature('products.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer les produits.';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception using errcode = '22023', message = 'Fichier invalide (2000 lignes au plus).';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_index := v_index + 1;
    begin
      v_found := false;
      if nullif(v_row ->> 'id', '') is not null then
        select * into v_product from public.products p where p.org_id = v_org and p.id::text = v_row ->> 'id';
        v_found := found;
      end if;
      if not v_found and nullif(btrim(v_row ->> 'sku'), '') is not null then
        select * into v_product from public.products p where p.org_id = v_org and lower(p.sku) = lower(btrim(v_row ->> 'sku'));
        v_found := found;
      end if;
      if not v_found and nullif(btrim(v_row ->> 'gtin'), '') is not null then
        select * into v_product from public.products p where p.org_id = v_org and p.gtin = regexp_replace(v_row ->> 'gtin', '\s', '', 'g') limit 1;
        v_found := found;
      end if;
      if not v_found then
        if nullif(btrim(v_row ->> 'name'), '') is null or nullif(v_row ->> 'price', '') is null then
          v_ignored := v_ignored || jsonb_build_object('line', v_index, 'reason', 'Produit introuvable : pour le créer, indiquez au moins le nom et le prix.');
          continue;
        end if;
        insert into public.products (org_id, name, slug, price, unit_label)
        values (v_org, btrim(v_row ->> 'name'),
          trim(both '-' from regexp_replace(lower(translate(btrim(v_row ->> 'name'), 'àâäçéèêëîïôöùûüÿœæ', 'aaaceeeeiioouuuyoa')), '[^a-z0-9]+', '-', 'g')) || '-' || substr(md5(random()::text), 1, 6),
          0, 'unité')
        returning * into v_product;
      end if;
      v_before := to_jsonb(v_product);
      -- Category: by name (Appro+'s list), else unchanged.
      v_category := v_product.category_id;
      if v_row ? 'category' and nullif(btrim(v_row ->> 'category'), '') is not null then
        select c.id into v_category from public.categories c where lower(c.name) = lower(btrim(regexp_replace(v_row ->> 'category', '^.*›\s*', ''))) and c.active limit 1;
        if v_category is null then
          raise exception 'Catégorie inconnue : %', v_row ->> 'category';
        end if;
      end if;
      foreach v_key in array v_text_keys loop
        if v_row ? v_key then
          execute format('update public.products set %I = $1 where id = $2', v_key)
            using case when v_key in ('name', 'unit_label') then coalesce(nullif(btrim(v_row ->> v_key), ''), case when v_key = 'name' then v_product.name else 'unité' end)
                       when v_key = 'description' then coalesce(btrim(v_row ->> v_key), '')
                       else nullif(btrim(coalesce(v_row ->> v_key, '')), '') end, v_product.id;
        end if;
      end loop;
      if v_row ? 'price' then
        v_num := replace(v_row ->> 'price', ',', '.')::numeric;
        if v_num < 0 then raise exception 'Prix négatif'; end if;
        update public.products set price = v_num where id = v_product.id;
      end if;
      if v_row ? 'vat_rate' then
        v_num := replace(v_row ->> 'vat_rate', ',', '.')::numeric;
        if v_num not in (0, 7, 13, 19) then raise exception 'TVA invalide (0, 7, 13 ou 19)'; end if;
        update public.products set vat_rate = v_num where id = v_product.id;
      end if;
      if v_row ? 'stock_quantity' then
        v_num := replace(v_row ->> 'stock_quantity', ',', '.')::numeric;
        if v_num < 0 then raise exception 'Stock négatif'; end if;
        update public.products set stock_quantity = v_num where id = v_product.id;
      end if;
      if v_row ? 'active' then
        update public.products set active = lower(v_row ->> 'active') in ('true', 'oui', 'yes', '1', 'x', 'vrai') where id = v_product.id;
      end if;
      if v_row ? 'attributes' and jsonb_typeof(v_row -> 'attributes') = 'object' then
        update public.products set attributes = jsonb_strip_nulls(attributes || (v_row -> 'attributes')) where id = v_product.id;
      end if;
      update public.products set category_id = v_category where id = v_product.id and category_id is distinct from v_category;
      select to_jsonb(p) into v_after from public.products p where p.id = v_product.id;
      if v_found and v_after - 'updated_at' = v_before - 'updated_at' then
        v_unchanged := v_unchanged + 1;
      else
        update public.products set updated_at = now() where id = v_product.id;
        -- What changed, before and after (the history of the import).
        v_changes := v_changes || jsonb_build_object('product_id', v_product.id, 'name', v_after ->> 'name', 'created', not v_found,
          'before', case when v_found then (select coalesce(jsonb_object_agg(k, v_before -> k), '{}'::jsonb) from jsonb_object_keys(v_after) k
                                            where k <> 'updated_at' and v_before -> k is distinct from v_after -> k) else '{}'::jsonb end,
          'after', (select coalesce(jsonb_object_agg(k, v_after -> k), '{}'::jsonb) from jsonb_object_keys(v_after) k
                    where k not in ('updated_at', 'id', 'org_id', 'slug', 'created_at') and v_before -> k is distinct from v_after -> k));
        if v_found then
          v_updated := v_updated + 1;
        else
          v_created := v_created + 1;
        end if;
      end if;
    exception when others then
      v_ignored := v_ignored || jsonb_build_object('line', v_index, 'reason', sqlerrm);
    end;
  end loop;
  insert into public.product_imports (org_id, imported_by, file_name, created, updated, unchanged, ignored, changes)
  values (v_org, auth.uid(), left(coalesce(p_file, ''), 200), v_created, v_updated, v_unchanged, jsonb_array_length(v_ignored), v_changes)
  returning id into v_import;
  return jsonb_build_object('import_id', v_import, 'created', v_created, 'updated', v_updated, 'unchanged', v_unchanged, 'ignored', v_ignored);
end;
$$;
REVOKE ALL ON FUNCTION public.products_import(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.products_import(text, jsonb) TO authenticated;

create or replace function public.product_import_history()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'imported_at', i.imported_at, 'by', public.location_name(i.imported_by), 'file_name', i.file_name,
      'created', i.created, 'updated', i.updated, 'unchanged', i.unchanged, 'ignored', i.ignored, 'changes', i.changes) order by i.imported_at desc), '[]'::jsonb)
  from (select * from public.product_imports x where x.org_id = public.acting_supplier_org_id() order by x.imported_at desc limit 50) i
  where public.has_feature('products.manage');
$$;
REVOKE ALL ON FUNCTION public.product_import_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.product_import_history() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Presets of the catalogue PDF
-- ---------------------------------------------------------------------------
alter table public.organizations add column if not exists catalog_presets jsonb not null default '[]'::jsonb;

create or replace function public.my_catalog_presets()
returns jsonb language sql stable security definer set search_path = ''
as $$ select coalesce((select o.catalog_presets from public.organizations o where o.id = public.acting_supplier_org_id()), '[]'::jsonb); $$;
REVOKE ALL ON FUNCTION public.my_catalog_presets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_catalog_presets() TO authenticated;

-- [{ "name", "options": { "photo": true, "price": true, … }, "default": true }]
create or replace function public.set_catalog_presets(p_presets jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.acting_supplier_org_id() is null or not public.has_feature('products.manage') then
    raise exception using errcode = '42501', message = 'Votre profil ne permet pas de gérer le catalogue.';
  end if;
  if jsonb_typeof(p_presets) is distinct from 'array' or jsonb_array_length(p_presets) > 10 then
    raise exception using errcode = '22023', message = 'Dix modèles au plus.';
  end if;
  update public.organizations set catalog_presets = p_presets, updated_at = now() where id = public.acting_supplier_org_id();
end;
$$;
REVOKE ALL ON FUNCTION public.set_catalog_presets(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_catalog_presets(jsonb) TO authenticated;

notify pgrst, 'reload schema';
