-- Messages between team members: one person, several people, a whole profile, or everyone.
-- Run in Supabase SQL Editor AFTER 20261028_alert_important.sql. Safe to rerun.

insert into public.role_permissions (role, feature, allowed) values
  ('supervisor', 'team.messages', true), ('production', 'team.messages', true),
  ('driver', 'team.messages', true), ('customer', 'team.messages', false)
on conflict (role, feature) do nothing;

insert into public.notification_settings (event, label, audience, push_enabled, email_enabled, sort_order)
values ('team.message', 'Message de l’équipe', 'Équipe', true, false, 9)
on conflict (event) do nothing;

-- direct = two people; group = chosen people; role = everyone with a profile; all = the whole team.
create table if not exists public.team_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group', 'role', 'all')),
  title text,
  target_role public.app_role,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);
create table if not exists public.team_conversation_members (
  conversation_id uuid not null references public.team_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (conversation_id, user_id)
);
create table if not exists public.team_conversation_reads (
  conversation_id uuid not null references public.team_conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create table if not exists public.team_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.team_conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists team_messages_conversation_idx on public.team_messages (conversation_id, created_at desc);
alter table public.notifications add column if not exists conversation_id uuid references public.team_conversations(id) on delete set null;

-- Active team accounts (not clients), with the profile used for "role" conversations.
create or replace function public.team_role_of(p_role public.app_role)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_role::text = 'staff' then 'supervisor' else p_role::text end;
$$;

create or replace function public.team_member_ids(p_conversation_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id
  from public.team_conversations c
  join public.profiles pr on pr.account_status = 'active' and pr.role <> 'customer'
  where c.id = p_conversation_id and (
    c.kind = 'all'
    or (c.kind = 'role' and public.team_role_of(pr.role) = c.target_role::text)
    or pr.id = c.created_by
    or exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = pr.id)
  );
$$;
REVOKE ALL ON FUNCTION public.team_member_ids(uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.is_team_conversation_member(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_feature('team.messages')
     and exists (select 1 from public.team_member_ids(p_conversation_id) m where m = (select auth.uid()));
$$;
REVOKE ALL ON FUNCTION public.is_team_conversation_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_team_conversation_member(uuid) TO authenticated;

alter table public.team_conversations enable row level security;
alter table public.team_conversation_members enable row level security;
alter table public.team_conversation_reads enable row level security;
alter table public.team_messages enable row level security;
GRANT SELECT ON public.team_conversations, public.team_conversation_members, public.team_messages TO authenticated;
drop policy if exists "team_conversations_read" on public.team_conversations;
create policy "team_conversations_read" on public.team_conversations
  for select to authenticated using ((select public.is_team_conversation_member(id)));
drop policy if exists "team_members_read" on public.team_conversation_members;
create policy "team_members_read" on public.team_conversation_members
  for select to authenticated using ((select public.is_team_conversation_member(conversation_id)));
drop policy if exists "team_messages_read" on public.team_messages;
create policy "team_messages_read" on public.team_messages
  for select to authenticated using ((select public.is_team_conversation_member(conversation_id)));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'team_messages'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.team_messages';
  END IF;
END;
$$;

create or replace function public.team_role_label(p_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_role when 'admin' then 'administrateurs' when 'supervisor' then 'superviseurs'
    when 'production' then 'équipe de production' when 'driver' then 'livreurs' else p_role end;
$$;

-- People the signed-in member can write to.
create or replace function public.team_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', pr.id,
      'name', coalesce(nullif(btrim(pr.full_name), ''), u.email),
      'role', public.team_role_of(pr.role)
    ) order by public.team_role_of(pr.role), coalesce(nullif(btrim(pr.full_name), ''), u.email))
    from public.profiles pr left join auth.users u on u.id = pr.id
    where pr.account_status = 'active' and pr.role <> 'customer' and pr.id <> auth.uid()
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.team_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_directory() TO authenticated;

-- Opens a conversation, reusing the existing one for the same person, profile or the whole team.
create or replace function public.team_start_conversation(
  p_kind text,
  p_member_ids uuid[] default null,
  p_role public.app_role default null,
  p_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.active_uid();
  v_others uuid[];
  v_id uuid;
begin
  if v_me is null or not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  select coalesce(array_agg(distinct pr.id), '{}'::uuid[]) into v_others
  from public.profiles pr
  where pr.id = any(coalesce(p_member_ids, '{}'::uuid[])) and pr.id <> v_me
    and pr.account_status = 'active' and pr.role <> 'customer';

  if p_kind = 'direct' then
    if cardinality(v_others) <> 1 then
      raise exception using errcode = '22023', message = 'Choisissez une personne.';
    end if;
    select c.id into v_id from public.team_conversations c
    where c.kind = 'direct'
      and exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = v_me)
      and exists (select 1 from public.team_conversation_members m where m.conversation_id = c.id and m.user_id = v_others[1])
    limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, created_by) values ('direct', v_me) returning id into v_id;
      insert into public.team_conversation_members (conversation_id, user_id) values (v_id, v_me), (v_id, v_others[1]);
    end if;
  elsif p_kind = 'group' then
    if cardinality(v_others) < 1 then
      raise exception using errcode = '22023', message = 'Choisissez au moins une personne.';
    end if;
    insert into public.team_conversations (kind, title, created_by)
    values ('group', nullif(btrim(coalesce(p_title, '')), ''), v_me) returning id into v_id;
    insert into public.team_conversation_members (conversation_id, user_id)
    select v_id, u from unnest(array_append(v_others, v_me)) as u;
  elsif p_kind = 'role' then
    if p_role is null or p_role::text in ('customer', 'staff') then
      raise exception using errcode = '22023', message = 'Choisissez un profil de l’équipe.';
    end if;
    select c.id into v_id from public.team_conversations c where c.kind = 'role' and c.target_role = p_role limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, target_role, created_by) values ('role', p_role, v_me) returning id into v_id;
    end if;
    -- Whoever writes to a profile also follows the conversation.
    insert into public.team_conversation_members (conversation_id, user_id) values (v_id, v_me) on conflict do nothing;
  elsif p_kind = 'all' then
    select c.id into v_id from public.team_conversations c where c.kind = 'all' limit 1;
    if v_id is null then
      insert into public.team_conversations (kind, created_by) values ('all', v_me) returning id into v_id;
    end if;
  else
    raise exception using errcode = '22023', message = 'Type de conversation inconnu.';
  end if;
  return v_id;
end;
$$;
REVOKE ALL ON FUNCTION public.team_start_conversation(text, uuid[], public.app_role, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_start_conversation(text, uuid[], public.app_role, text) TO authenticated;

-- Name shown for a conversation, from the reader's point of view.
create or replace function public.team_conversation_title(p_conversation_id uuid, p_viewer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case c.kind
    when 'all' then 'Toute l’équipe'
    when 'role' then 'Tous les ' || public.team_role_label(c.target_role::text)
    else coalesce(nullif(btrim(c.title), ''), (
      select string_agg(coalesce(nullif(btrim(pr.full_name), ''), u.email), ', ' order by pr.full_name)
      from public.team_conversation_members m
      join public.profiles pr on pr.id = m.user_id
      left join auth.users u on u.id = pr.id
      where m.conversation_id = c.id and m.user_id <> p_viewer
    ), 'Conversation')
  end
  from public.team_conversations c where c.id = p_conversation_id;
$$;
REVOKE ALL ON FUNCTION public.team_conversation_title(uuid, uuid) FROM PUBLIC, anon, authenticated;

create or replace function public.team_send_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.active_uid();
  v_message public.team_messages%rowtype;
  v_sender text;
begin
  if v_me is null or not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Le message doit contenir entre 1 et 2000 caractères.';
  end if;
  insert into public.team_messages (conversation_id, sender_id, body) values (p_conversation_id, v_me, btrim(p_body))
  returning * into v_message;
  update public.team_conversations set last_message_at = v_message.created_at where id = p_conversation_id;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, v_me, v_message.created_at)
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;

  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_sender
  from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_me;
  insert into public.notifications (user_id, event, title, body, conversation_id)
  select m, 'team.message',
         case when c.kind = 'direct' then format('Message de %s', v_sender)
              else format('%s · %s', v_sender, public.team_conversation_title(c.id, m)) end,
         left(v_message.body, 140), c.id
  from public.team_member_ids(p_conversation_id) as m
  join public.team_conversations c on c.id = p_conversation_id
  where m <> v_me;

  return jsonb_build_object('id', v_message.id, 'conversation_id', v_message.conversation_id, 'sender_id', v_message.sender_id,
    'sender_name', v_sender, 'body', v_message.body, 'created_at', v_message.created_at);
end;
$$;
REVOKE ALL ON FUNCTION public.team_send_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_send_message(uuid, text) TO authenticated;

create or replace function public.team_mark_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    return;
  end if;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, auth.uid(), now())
  on conflict (conversation_id, user_id) do update set last_read_at = now();
  update public.notifications set read_at = now()
  where user_id = auth.uid() and conversation_id = p_conversation_id and read_at is null;
end;
$$;
REVOKE ALL ON FUNCTION public.team_mark_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_mark_read(uuid) TO authenticated;

-- My conversations, most recent first, with the last message and my unread count.
create or replace function public.team_conversations_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if not public.has_feature('team.messages') then
    raise exception using errcode = '42501', message = 'La messagerie d’équipe n’est pas activée pour votre profil.';
  end if;
  return coalesce((
    select jsonb_agg(entry order by (entry ->> 'last_at') desc nulls last)
    from (
      select jsonb_build_object(
        'id', c.id,
        'kind', c.kind,
        'title', public.team_conversation_title(c.id, v_me),
        'target_role', c.target_role,
        'member_count', (select count(*) from public.team_member_ids(c.id)),
        'last_at', coalesce(c.last_message_at, c.created_at),
        'last_body', last_message.body,
        'last_sender', last_message.sender_name,
        'last_mine', last_message.sender_id = v_me,
        'unread', (select count(*) from public.team_messages tm
                   where tm.conversation_id = c.id and tm.sender_id is distinct from v_me
                     and tm.created_at > coalesce((select r.last_read_at from public.team_conversation_reads r
                                                   where r.conversation_id = c.id and r.user_id = v_me), '-infinity'::timestamptz))
      ) as entry
      from public.team_conversations c
      left join lateral (
        select tm.body, tm.sender_id, coalesce(nullif(btrim(pr.full_name), ''), u.email) as sender_name
        from public.team_messages tm
        left join public.profiles pr on pr.id = tm.sender_id
        left join auth.users u on u.id = pr.id
        where tm.conversation_id = c.id order by tm.created_at desc limit 1
      ) last_message on true
      where exists (select 1 from public.team_member_ids(c.id) m where m = v_me)
        and (c.last_message_at is not null or c.created_by = v_me)
    ) entries
  ), '[]'::jsonb);
end;
$$;
REVOKE ALL ON FUNCTION public.team_conversations_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_conversations_list() TO authenticated;

create or replace function public.team_messages_of(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  return jsonb_build_object(
    'title', public.team_conversation_title(p_conversation_id, auth.uid()),
    'members', (select coalesce(jsonb_agg(coalesce(nullif(btrim(pr.full_name), ''), u.email) order by pr.full_name), '[]'::jsonb)
                from public.team_member_ids(p_conversation_id) m
                join public.profiles pr on pr.id = m left join auth.users u on u.id = pr.id),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', tm.id, 'conversation_id', tm.conversation_id, 'sender_id', tm.sender_id,
        'sender_name', coalesce(nullif(btrim(pr.full_name), ''), u.email, 'Ancien membre'),
        'body', tm.body, 'created_at', tm.created_at
      ) order by tm.created_at desc)
      from (select * from public.team_messages where conversation_id = p_conversation_id order by created_at desc limit 200) tm
      left join public.profiles pr on pr.id = tm.sender_id
      left join auth.users u on u.id = pr.id
    ), '[]'::jsonb)
  );
end;
$$;
REVOKE ALL ON FUNCTION public.team_messages_of(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_messages_of(uuid) TO authenticated;

create or replace function public.team_unread_count()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((e ->> 'unread')::int), 0)::int
  from jsonb_array_elements(case when public.has_feature('team.messages') then public.team_conversations_list() else '[]'::jsonb end) e;
$$;
REVOKE ALL ON FUNCTION public.team_unread_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_unread_count() TO authenticated;
