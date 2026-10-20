-- Photos, videos, voice notes and documents in client and team messages (Supabase Storage).
-- Run in Supabase SQL Editor AFTER 20261031_billing_decisions.sql. Safe to rerun.
-- Files go to the private bucket "attachments": client/<client id>/… or team/<conversation id>/…

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do nothing;

-- Who may read or upload a file, from its folder.
create or replace function public.can_access_attachment(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_id uuid;
begin
  if array_length(v_parts, 1) < 3 then
    return false;
  end if;
  begin
    v_id := v_parts[2]::uuid;
  exception when others then
    return false;
  end;
  if v_parts[1] = 'client' then
    return public.has_feature('messages.manage') or (v_id = public.current_client_id() and public.has_feature('client.messages'));
  elsif v_parts[1] = 'team' then
    return public.is_team_conversation_member(v_id);
  end if;
  return false;
end;
$$;
REVOKE ALL ON FUNCTION public.can_access_attachment(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_attachment(text) TO authenticated;

drop policy if exists "attachments_read" on storage.objects;
create policy "attachments_read" on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (select public.can_access_attachment(name)));
drop policy if exists "attachments_upload" on storage.objects;
create policy "attachments_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (select public.can_access_attachment(name)));

-- A message may be only an attachment (no text).
alter table public.messages add column if not exists attachment jsonb;
alter table public.team_messages add column if not exists attachment jsonb;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT conrelid::regclass::text AS tbl, conname FROM pg_catalog.pg_constraint
    WHERE contype = 'c' AND conrelid IN ('public.messages'::regclass, 'public.team_messages'::regclass)
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%char_length%' AND conname NOT LIKE '%_body_or_attachment'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'messages_body_or_attachment') THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_body_or_attachment
      CHECK (char_length(body) <= 2000 AND (char_length(btrim(body)) >= 1 OR attachment IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'team_messages_body_or_attachment') THEN
    ALTER TABLE public.team_messages ADD CONSTRAINT team_messages_body_or_attachment
      CHECK (char_length(body) <= 2000 AND (char_length(btrim(body)) >= 1 OR attachment IS NOT NULL));
  END IF;
END;
$$;

-- {path, kind: image|video|audio|file, name, size, mime}; the path must be in the conversation's folder.
create or replace function public.clean_attachment(p_attachment jsonb, p_folder text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_attachment is null or p_attachment = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_attachment) <> 'object' or coalesce(p_attachment ->> 'path', '') not like p_folder || '/%'
     or coalesce(p_attachment ->> 'kind', '') not in ('image', 'video', 'audio', 'file') then
    raise exception using errcode = '22023', message = 'Pièce jointe invalide.';
  end if;
  return jsonb_build_object(
    'path', p_attachment ->> 'path',
    'kind', p_attachment ->> 'kind',
    'name', left(coalesce(nullif(p_attachment ->> 'name', ''), 'fichier'), 120),
    'size', coalesce((p_attachment ->> 'size')::bigint, 0),
    'mime', left(coalesce(p_attachment ->> 'mime', ''), 100)
  );
end;
$$;

create or replace function public.send_message_v2(p_client_id uuid, p_body text, p_attachment jsonb default null)
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

  insert into public.messages (client_id, sender_id, from_staff, body, attachment)
  values (v_client_id, auth.uid(), v_is_staff, btrim(coalesce(p_body, '')), v_attachment)
  returning * into v_message;

  return jsonb_build_object(
    'id', v_message.id, 'client_id', v_message.client_id, 'from_staff', v_message.from_staff,
    'body', v_message.body, 'attachment', v_message.attachment, 'created_at', v_message.created_at, 'read_at', v_message.read_at
  );
end;
$$;
REVOKE ALL ON FUNCTION public.send_message_v2(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message_v2(uuid, text, jsonb) TO authenticated;

create or replace function public.send_message(p_client_id uuid, p_body text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.send_message_v2(p_client_id, p_body, null);
$$;

create or replace function public.team_send_message_v2(p_conversation_id uuid, p_body text, p_attachment jsonb default null)
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
  insert into public.team_messages (conversation_id, sender_id, body, attachment)
  values (p_conversation_id, v_me, btrim(coalesce(p_body, '')), v_attachment)
  returning * into v_message;
  update public.team_conversations set last_message_at = v_message.created_at where id = p_conversation_id;
  insert into public.team_conversation_reads (conversation_id, user_id, last_read_at) values (p_conversation_id, v_me, v_message.created_at)
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;

  select coalesce(nullif(btrim(pr.full_name), ''), u.email) into v_sender
  from public.profiles pr left join auth.users u on u.id = pr.id where pr.id = v_me;
  v_preview := coalesce(nullif(left(v_message.body, 140), ''), case v_attachment ->> 'kind'
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
    'sender_name', v_sender, 'body', v_message.body, 'attachment', v_message.attachment, 'created_at', v_message.created_at);
end;
$$;
REVOKE ALL ON FUNCTION public.team_send_message_v2(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_send_message_v2(uuid, text, jsonb) TO authenticated;

create or replace function public.team_send_message(p_conversation_id uuid, p_body text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.team_send_message_v2(p_conversation_id, p_body, null);
$$;

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
        'body', tm.body, 'attachment', tm.attachment, 'created_at', tm.created_at
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
