-- "Needs a reply" on every message (client and team conversations), set when sending or later,
-- cleared as soon as the other side answers.
-- Run in Supabase SQL Editor AFTER 20261101_message_attachments.sql. Safe to rerun.

alter table public.team_messages add column if not exists needs_reply boolean not null default false;

drop function if exists public.send_message_v2(uuid, text, jsonb);
create or replace function public.send_message_v2(p_client_id uuid, p_body text, p_attachment jsonb default null, p_needs_reply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_staff boolean := public.is_staff();
  v_client_id uuid;
  v_message public.messages%rowtype;
  v_attachment jsonb;
begin
  if v_is_staff then
    if not public.has_feature('messages.manage') then
      raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre profil.';
    end if;
    v_client_id := p_client_id;
  else
    if not public.has_feature('client.messages') then
      raise exception using errcode = '42501', message = 'La messagerie n’est pas activée pour votre compte.';
    end if;
    v_client_id := public.current_client_id();
    if v_client_id is null then
      raise exception using errcode = '42501', message = 'Votre compte n’est rattaché à aucune fiche client.';
    end if;
    if p_client_id is not null and p_client_id <> v_client_id then
      raise exception using errcode = '42501', message = 'Vous ne pouvez écrire que dans votre propre conversation.';
    end if;
  end if;
  if not exists (select 1 from public.clients c where c.id = v_client_id) then
    raise exception using errcode = 'P0002', message = 'Client introuvable.';
  end if;
  v_attachment := public.clean_attachment(p_attachment, 'client/' || v_client_id::text);
  if char_length(coalesce(p_body, '')) > 2000 or (char_length(btrim(coalesce(p_body, ''))) = 0 and v_attachment is null) then
    raise exception using errcode = '22023', message = 'Écrivez un message (2000 caractères au plus) ou joignez un fichier.';
  end if;

  insert into public.messages (client_id, sender_id, from_staff, body, attachment, needs_reply)
  values (v_client_id, auth.uid(), v_is_staff, btrim(coalesce(p_body, '')), v_attachment, coalesce(p_needs_reply, false))
  returning * into v_message;

  return jsonb_build_object(
    'id', v_message.id, 'client_id', v_message.client_id, 'from_staff', v_message.from_staff, 'body', v_message.body,
    'attachment', v_message.attachment, 'needs_reply', v_message.needs_reply, 'created_at', v_message.created_at, 'read_at', v_message.read_at
  );
end;
$$;
REVOKE ALL ON FUNCTION public.send_message_v2(uuid, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message_v2(uuid, text, jsonb, boolean) TO authenticated;

create or replace function public.send_message(p_client_id uuid, p_body text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.send_message_v2(p_client_id, p_body, null, false);
$$;

-- Any message of the conversation, by the team or by the client (for its own conversation).
create or replace function public.staff_flag_message(p_message_id uuid, p_needs_reply boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages m set needs_reply = coalesce(p_needs_reply, false)
  where m.id = p_message_id
    and (public.has_feature('messages.manage') or (m.client_id = public.current_client_id() and public.has_feature('client.messages')));
  if not found then
    raise exception using errcode = 'P0002', message = 'Message introuvable.';
  end if;
end;
$$;

-- An answer from the other side clears what was waiting for it.
create or replace function public.clear_needs_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.messages set needs_reply = false
  where client_id = new.client_id and needs_reply and from_staff <> new.from_staff and created_at <= new.created_at;
  return new;
end;
$$;

drop function if exists public.team_send_message_v2(uuid, text, jsonb);
create or replace function public.team_send_message_v2(p_conversation_id uuid, p_body text, p_attachment jsonb default null, p_needs_reply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := public.active_uid();
  v_message public.team_messages%rowtype;
  v_sender text;
  v_attachment jsonb;
  v_preview text;
begin
  if v_me is null or not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  v_attachment := public.clean_attachment(p_attachment, 'team/' || p_conversation_id::text);
  if char_length(coalesce(p_body, '')) > 2000 or (char_length(btrim(coalesce(p_body, ''))) = 0 and v_attachment is null) then
    raise exception using errcode = '22023', message = 'Écrivez un message (2000 caractères au plus) ou joignez un fichier.';
  end if;
  insert into public.team_messages (conversation_id, sender_id, body, attachment, needs_reply)
  values (p_conversation_id, v_me, btrim(coalesce(p_body, '')), v_attachment, coalesce(p_needs_reply, false))
  returning * into v_message;
  update public.team_conversations set last_message_at = v_message.created_at where id = p_conversation_id;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, v_me, v_message.created_at)
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;

  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_sender
  from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_me;
  v_preview := case when v_message.needs_reply then '❗ Réponse attendue · ' else '' end || coalesce(nullif(left(v_message.body, 140), ''), case v_attachment ->> 'kind'
    when 'image' then '📷 Photo' when 'video' then '🎬 Vidéo' when 'audio' then '🎤 Message vocal' else '📎 ' || (v_attachment ->> 'name') end);
  insert into public.notifications (user_id, event, title, body, conversation_id)
  select m, 'team.message',
         case when c.kind = 'direct' then format('Message de %s', v_sender)
              else format('%s · %s', v_sender, public.team_conversation_title(c.id, m)) end,
         v_preview, c.id
  from public.team_member_ids(p_conversation_id) as m
  join public.team_conversations c on c.id = p_conversation_id
  where m <> v_me;

  return jsonb_build_object('id', v_message.id, 'conversation_id', v_message.conversation_id, 'sender_id', v_message.sender_id,
    'sender_name', v_sender, 'body', v_message.body, 'attachment', v_message.attachment, 'needs_reply', v_message.needs_reply,
    'created_at', v_message.created_at);
end;
$$;
REVOKE ALL ON FUNCTION public.team_send_message_v2(uuid, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_send_message_v2(uuid, text, jsonb, boolean) TO authenticated;

create or replace function public.team_send_message(p_conversation_id uuid, p_body text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.team_send_message_v2(p_conversation_id, p_body, null, false);
$$;

create or replace function public.team_flag_message(p_message_id uuid, p_needs_reply boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation uuid;
begin
  select tm.conversation_id into v_conversation from public.team_messages tm where tm.id = p_message_id;
  if v_conversation is null or not public.is_team_conversation_member(v_conversation) then
    raise exception using errcode = 'P0002', message = 'Message introuvable.';
  end if;
  update public.team_messages set needs_reply = coalesce(p_needs_reply, false) where id = p_message_id;
end;
$$;
REVOKE ALL ON FUNCTION public.team_flag_message(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_flag_message(uuid, boolean) TO authenticated;

create or replace function public.clear_team_needs_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.team_messages set needs_reply = false
  where conversation_id = new.conversation_id and needs_reply and sender_id is distinct from new.sender_id and created_at <= new.created_at;
  return new;
end;
$$;
drop trigger if exists team_messages_clear_needs_reply on public.team_messages;
create trigger team_messages_clear_needs_reply after insert on public.team_messages
  for each row execute function public.clear_team_needs_reply();

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
        'body', tm.body, 'attachment', tm.attachment, 'needs_reply', tm.needs_reply, 'created_at', tm.created_at
      ) order by tm.created_at desc)
      from (select * from public.team_messages where conversation_id = p_conversation_id order by created_at desc limit 200) tm
      left join public.profiles pr on pr.id = tm.sender_id
      left join auth.users u on u.id = pr.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Everything waiting for my answer, for "À décider": client conversations (team side) and my team conversations.
create or replace function public.messages_needing_reply()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  return jsonb_build_object(
    'clients', case when public.has_feature('messages.manage') then coalesce((
      select jsonb_agg(jsonb_build_object('client_id', c.id, 'business_name', c.business_name, 'count', x.n, 'since', x.since, 'last_body', x.last_body) order by x.since)
      from (
        select m.client_id, count(*) as n, min(m.created_at) as since, (array_agg(m.body order by m.created_at desc))[1] as last_body
        from public.messages m where m.needs_reply and not m.from_staff group by m.client_id
      ) x join public.clients c on c.id = x.client_id
    ), '[]'::jsonb) else '[]'::jsonb end,
    'team', case when public.has_feature('team.messages') then coalesce((
      select jsonb_agg(jsonb_build_object('conversation_id', x.conversation_id, 'title', public.team_conversation_title(x.conversation_id, v_me),
        'count', x.n, 'since', x.since, 'last_body', x.last_body) order by x.since)
      from (
        select tm.conversation_id, count(*) as n, min(tm.created_at) as since, (array_agg(tm.body order by tm.created_at desc))[1] as last_body
        from public.team_messages tm
        where tm.needs_reply and tm.sender_id is distinct from v_me
          and exists (select 1 from public.team_member_ids(tm.conversation_id) m where m = v_me)
        group by tm.conversation_id
      ) x
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- Adds people to a conversation; a two-person conversation becomes a group.
create or replace function public.team_add_members(p_conversation_id uuid, p_member_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  if not public.is_team_conversation_member(p_conversation_id) then
    raise exception using errcode = '42501', message = 'Vous ne participez pas à cette conversation.';
  end if;
  select c.kind into v_kind from public.team_conversations c where c.id = p_conversation_id;
  if v_kind in ('role', 'all') then
    raise exception using errcode = '22023', message = 'Cette conversation est déjà ouverte à tout un profil ou à toute l’équipe.';
  end if;
  insert into public.team_conversation_members (conversation_id, user_id)
  select p_conversation_id, pr.id from public.profiles pr
  where pr.id = any(coalesce(p_member_ids, '{}'::uuid[])) and pr.account_status = 'active' and pr.role <> 'customer'
  on conflict do nothing;
  update public.team_conversations set kind = 'group' where id = p_conversation_id and kind = 'direct'
    and (select count(*) from public.team_conversation_members m where m.conversation_id = p_conversation_id) > 2;
end;
$$;
REVOKE ALL ON FUNCTION public.team_add_members(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_add_members(uuid, uuid[]) TO authenticated;
