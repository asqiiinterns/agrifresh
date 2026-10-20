-- Lot 1 — out of "the AgriFresh app":
--   * categories belong to Appro+: one shared list (with sub-categories), managed by the superadmin and the
--     Appro+ team (permission platform.catalog); every Pro files its products in it, which also makes
--     products comparable between suppliers;
--   * order numbers are counted per supplier (no gaps seen by a supplier because of the others).
--     Existing orders keep their number; each supplier continues from its highest one.
-- Run in Supabase SQL Editor AFTER 20261115_multi_supplier_cart.sql. Safe to rerun.

-- ---------------------------------------------------------------------------
-- Categories managed by Appro+.
-- ---------------------------------------------------------------------------
alter table public.categories add column if not exists parent_id uuid references public.categories(id) on delete set null;
alter table public.categories add column if not exists updated_at timestamptz not null default now();

-- A general list for every kind of Pro (the original ones are kept and filed under it).
insert into public.categories (name, slug, sort_order)
select v.name, v.slug, v.sort_order from (values
  ('Fruits', 'fruits', 10), ('Légumes', 'legumes', 20), ('Boissons', 'boissons', 30),
  ('Épicerie', 'epicerie', 40), ('Produits laitiers et œufs', 'produits-laitiers', 50),
  ('Viandes et volailles', 'viandes-volailles', 60), ('Poissons et fruits de mer', 'poissons', 70),
  ('Boulangerie et pâtisserie', 'boulangerie', 80), ('Surgelés', 'surgeles', 90),
  ('Hygiène et entretien', 'hygiene-entretien', 100), ('Emballages et consommables', 'emballages', 110),
  ('Autres', 'autres', 900)
) as v(name, slug, sort_order)
where not exists (select 1 from public.categories c where c.name = v.name or c.slug = v.slug);
update public.categories set parent_id = (select id from public.categories where slug = 'boissons')
where name = 'Jus frais' and parent_id is null;

-- The Appro+ team member who manages the shared catalogue: superadmin, and account managers.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.platform_can(text)'::regprocedure);
BEGIN
  IF v_def not like '%platform.catalog%' THEN
    EXECUTE replace(v_def,
      'when ''account_manager'' then p_permission in (''platform.pros.view'', ''platform.pros.manage'', ''platform.roles.assign'', ''platform.support.access'')',
      'when ''account_manager'' then p_permission in (''platform.pros.view'', ''platform.pros.manage'', ''platform.roles.assign'', ''platform.support.access'', ''platform.catalog'')');
  END IF;
END;
$$;

-- Every signed-in account reads the list (inactive ones too, for products already filed there).
drop policy if exists "categories_read_all" on public.categories;
create policy "categories_read_all" on public.categories for select to authenticated using (true);

create or replace function public.platform_save_category(p_id uuid, p_name text, p_parent_id uuid default null, p_sort_order int default null, p_active boolean default true)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text;
begin
  if not public.platform_can('platform.catalog') then
    raise exception using errcode = '42501', message = 'Seule l’équipe Appro+ gère les catégories.';
  end if;
  if v_name = '' then
    raise exception using errcode = '22023', message = 'Indiquez le nom de la catégorie.';
  end if;
  if p_parent_id is not null and (p_parent_id = p_id or exists (select 1 from public.categories c where c.id = p_parent_id and c.parent_id is not null)) then
    raise exception using errcode = '22023', message = 'Une sous-catégorie se range sous une catégorie principale.';
  end if;
  if exists (select 1 from public.categories c where lower(c.name) = lower(v_name) and c.id is distinct from p_id) then
    raise exception using errcode = '23505', message = 'Cette catégorie existe déjà.';
  end if;
  v_slug := trim(both '-' from regexp_replace(lower(translate(v_name, 'àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ', 'aaaceeeeiioouuuyoaAAACEEEEIIOOUUUY')), '[^a-z0-9]+', '-', 'g'));
  while exists (select 1 from public.categories c where c.slug = v_slug and c.id is distinct from p_id) loop
    v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
  end loop;
  if v_id is null then
    insert into public.categories (name, slug, sort_order, active, parent_id)
    values (v_name, v_slug, coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 10 from public.categories)), coalesce(p_active, true), p_parent_id)
    returning id into v_id;
  else
    update public.categories set name = v_name, slug = v_slug, sort_order = coalesce(p_sort_order, sort_order),
      active = coalesce(p_active, active), parent_id = p_parent_id, updated_at = now()
    where id = v_id;
    if not found then
      raise exception using errcode = 'P0002', message = 'Catégorie introuvable.';
    end if;
  end if;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.platform_save_category(uuid, text, uuid, int, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_save_category(uuid, text, uuid, int, boolean) TO authenticated;

-- The list with how many products use each category (for the Appro+ console).
create or replace function public.platform_categories()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'parent_id', c.parent_id, 'sort_order', c.sort_order, 'active', c.active,
    'products', (select count(*) from public.products p where p.category_id = c.id)) order by c.sort_order, c.name), '[]'::jsonb)
  from public.categories c where public.platform_can('platform.catalog');
$$;
REVOKE ALL ON FUNCTION public.platform_categories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_categories() TO authenticated;

-- The buyer catalogue carries the category's rank, to list categories in Appro+'s order.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.buyer_catalog()'::regprocedure);
BEGIN
  IF v_def not like '%category_sort%' THEN
    EXECUTE replace(v_def, '''category'', cat.name,', '''category'', cat.name, ''category_sort'', cat.sort_order,');
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Order numbers per supplier.
-- ---------------------------------------------------------------------------
create table if not exists public.org_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,
  last_value bigint not null default 0,
  primary key (org_id, kind)
);
alter table public.org_counters enable row level security;

DO $$
BEGIN
  IF exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'
             and column_name = 'order_number' and is_identity = 'YES') THEN
    alter table public.orders alter column order_number drop identity;
  END IF;
  IF exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_order_number_key') THEN
    alter table public.orders drop constraint orders_order_number_key;
  END IF;
END;
$$;
create unique index if not exists orders_supplier_number_idx on public.orders(supplier_org_id, order_number);
-- The early informational receipts (one per order, unused by the app) were numbered after the order:
-- two suppliers may now share an order number, the receipt stays unique by its order.
DO $$
BEGIN
  IF exists (select 1 from pg_constraint where conrelid = 'public.invoices'::regclass and conname = 'invoices_invoice_number_key') THEN
    alter table public.invoices drop constraint invoices_invoice_number_key;
  END IF;
END;
$$;

insert into public.org_counters (org_id, kind, last_value)
select o.supplier_org_id, 'order', max(o.order_number) from public.orders o where o.supplier_org_id is not null group by o.supplier_org_id
on conflict (org_id, kind) do update set last_value = greatest(public.org_counters.last_value, excluded.last_value);

create or replace function public.next_org_counter(p_org_id uuid, p_kind text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  insert into public.org_counters (org_id, kind, last_value) values (p_org_id, p_kind, 1)
  on conflict (org_id, kind) do update set last_value = public.org_counters.last_value + 1
  returning last_value into v_next;
  return v_next;
end;
$$;
REVOKE ALL ON FUNCTION public.next_org_counter(uuid, text) FROM PUBLIC, anon, authenticated;

-- Runs after orders_fill_supplier (alphabetical order of triggers): the supplier is known.
create or replace function public.orders_number_per_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_number is null then
    new.supplier_org_id := coalesce(new.supplier_org_id, (select c.supplier_org_id from public.clients c where c.id = new.client_id), public.legacy_org_id());
    new.order_number := public.next_org_counter(new.supplier_org_id, 'order');
  end if;
  return new;
end;
$$;
drop trigger if exists orders_number_per_supplier on public.orders;
create trigger orders_number_per_supplier before insert on public.orders for each row execute function public.orders_number_per_supplier();
