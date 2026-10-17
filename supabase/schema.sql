-- AgriFresh starter schema (Supabase / PostgreSQL)
-- Apply in Supabase SQL Editor only after reviewing and adapting business rules.

create extension if not exists pgcrypto;

create type public.app_role as enum ('customer', 'staff', 'admin');
create type public.order_status as enum (
  'pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role public.app_role not null default 'customer',
  created_at timestamptz not null default now()
);

-- Create a customer profile automatically when Supabase Auth creates a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Backfill profiles for users that existed before this trigger was installed.
insert into public.profiles (id, full_name, phone)
select
  id,
  coalesce(raw_user_meta_data ->> 'full_name', ''),
  nullif(raw_user_meta_data ->> 'phone', '')
from auth.users
on conflict (id) do nothing;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  sort_order int not null default 0,
  active boolean not null default true
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id),
  name text not null,
  slug text not null unique,
  description text not null default '',
  image_url text,
  unit_label text not null default 'unité',
  price numeric(12,3) not null check (price >= 0),
  currency char(3) not null default 'TND',
  stock_quantity numeric(12,3) not null default 0 check (stock_quantity >= 0),
  active boolean not null default true,
  seasonal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Small starter catalogue; these prices, stock levels, and images are examples.
insert into public.categories (name, slug, sort_order) values
  ('Jus frais', 'jus-frais', 1),
  ('Fruits', 'fruits', 2),
  ('Légumes', 'legumes', 3),
  ('Épicerie', 'epicerie', 4)
on conflict do nothing;

insert into public.products
  (category_id, name, slug, description, image_url, unit_label, price, currency, stock_quantity)
select
  c.id, seed.name, seed.slug, seed.description, seed.image_url,
  seed.unit_label, seed.price, 'TND', 50
from (values
  ('Jus frais', 'Jus d’orange pressé', 'jus-orange', '100 % oranges, frais et ensoleillé', 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=900&q=85', 'bouteille · 1 L', 8.500::numeric),
  ('Jus frais', 'Jus fraise & pomme', 'jus-fraise', 'Une recette douce et fruitée', 'https://images.unsplash.com/photo-1622597467836-f3285f2131b8?auto=format&fit=crop&w=900&q=85', 'bouteille · 1 L', 9.900::numeric),
  ('Fruits', 'Oranges de saison', 'oranges', 'Juteuses, sélectionnées avec soin', 'https://images.unsplash.com/photo-1547514701-42782101795e?auto=format&fit=crop&w=900&q=85', 'kg', 4.200::numeric),
  ('Légumes', 'Tomates du marché', 'tomates', 'Pour des salades pleines de goût', 'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=900&q=85', 'kg', 3.400::numeric),
  ('Épicerie', 'Dattes Deglet Nour', 'dattes', 'Une douceur naturellement généreuse', 'https://images.unsplash.com/photo-1590080877777-b7d7c4d1e9a4?auto=format&fit=crop&w=900&q=85', 'boîte · 500 g', 14.500::numeric),
  ('Fruits', 'Citrons frais', 'citron', 'Parfaits pour vos boissons maison', 'https://images.unsplash.com/photo-1513558161293-cdaf765edfd7?auto=format&fit=crop&w=900&q=85', 'kg', 3.800::numeric)
) as seed(category_name, name, slug, description, image_url, unit_label, price)
join public.categories c on c.name = seed.category_name
on conflict (slug) do nothing;

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  label text not null default 'Maison',
  recipient_name text not null,
  phone text not null,
  address_line text not null,
  city text not null,
  notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  customer_id uuid not null references public.profiles(id),
  status public.order_status not null default 'pending',
  address_snapshot jsonb not null,
  subtotal numeric(12,3) not null check (subtotal >= 0),
  delivery_fee numeric(12,3) not null default 0 check (delivery_fee >= 0),
  total numeric(12,3) not null check (total >= 0),
  currency char(3) not null default 'TND',
  customer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name_snapshot text not null,
  unit_snapshot text not null,
  unit_price numeric(12,3) not null check (unit_price >= 0),
  quantity numeric(12,3) not null check (quantity > 0),
  line_total numeric(12,3) not null check (line_total >= 0)
);

create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status public.order_status not null,
  note text,
  changed_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  invoice_number text not null unique,
  issued_at timestamptz not null default now(),
  currency char(3) not null default 'TND',
  subtotal numeric(12,3) not null check (subtotal >= 0),
  tax_total numeric(12,3) not null default 0 check (tax_total >= 0),
  delivery_fee numeric(12,3) not null default 0 check (delivery_fee >= 0),
  total numeric(12,3) not null check (total >= 0),
  pdf_path text,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text,
  provider_reference text,
  method text not null default 'cash_on_delivery',
  status text not null default 'pending'
    check (status in ('pending','authorized','paid','failed','refunded','cancelled')),
  amount numeric(12,3) not null check (amount >= 0),
  currency char(3) not null default 'TND',
  created_at timestamptz not null default now()
);

create index products_active_category_idx on public.products(active, category_id);
create index orders_customer_created_idx on public.orders(customer_id, created_at desc);
create index order_items_order_idx on public.order_items(order_id);
create index order_status_history_order_idx on public.order_status_history(order_id, created_at);

-- RLS: customer-facing reads are scoped to the authenticated user.
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;

create policy "profiles_read_own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "active_categories_read" on public.categories
  for select to anon, authenticated using (active = true);
create policy "active_products_read" on public.products
  for select to anon, authenticated using (active = true);

create policy "addresses_read_own" on public.customer_addresses
  for select to authenticated using (customer_id = (select auth.uid()));
create policy "addresses_insert_own" on public.customer_addresses
  for insert to authenticated with check (customer_id = (select auth.uid()));
create policy "addresses_update_own" on public.customer_addresses
  for update to authenticated using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));
create policy "addresses_delete_own" on public.customer_addresses
  for delete to authenticated using (customer_id = (select auth.uid()));

create policy "orders_read_own" on public.orders
  for select to authenticated using (customer_id = (select auth.uid()));
create policy "order_items_read_own" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o
      where o.id = order_items.order_id and o.customer_id = (select auth.uid()))
  );
create policy "status_history_read_own" on public.order_status_history
  for select to authenticated using (
    exists (select 1 from public.orders o
      where o.id = order_status_history.order_id and o.customer_id = (select auth.uid()))
  );
create policy "invoices_read_own" on public.invoices
  for select to authenticated using (
    exists (select 1 from public.orders o
      where o.id = invoices.order_id and o.customer_id = (select auth.uid()))
  );
create policy "payments_read_own" on public.payments
  for select to authenticated using (
    exists (select 1 from public.orders o
      where o.id = payments.order_id and o.customer_id = (select auth.uid()))
  );

-- IMPORTANT:
-- Do not enable client-side direct order creation using unchecked client totals.
-- Next step: implement a transactional PostgreSQL RPC or server-side Edge Function
-- that validates products, prices and stock, then creates order + items + history.
-- Restrict role changes and all staff/admin writes to trusted server-side logic.
-- Never expose the Supabase service-role key in a browser/mobile bundle.
