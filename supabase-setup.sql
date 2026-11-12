-- WERKSTANDAARD TEAM V2 - eenmalig uitvoeren in Supabase > SQL Editor
-- Beveiliging: privé teamdata, leden moeten worden goedgekeurd, foto's in een privé bucket.
-- Voer het hele bestand in één keer uit in een NIEUW Supabase-project.
create extension if not exists pgcrypto;

create table if not exists public.ws_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 90),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.ws_memberships (
  team_id uuid not null references public.ws_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 70),
  role text not null check (role in ('admin','member')),
  status text not null check (status in ('active','pending')),
  joined_at timestamptz not null default now(),
  primary key(team_id,user_id)
);

create table if not exists public.ws_tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.ws_teams(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 150),
  machine text not null default '',
  category text not null default 'Inspectie',
  frequency text not null default '',
  safety text not null default '',
  tools text not null default '',
  steps jsonb not null default '[]'::jsonb check(jsonb_typeof(steps)='array'),
  checks jsonb not null default '[]'::jsonb check(jsonb_typeof(checks)='array'),
  assigned_to uuid references auth.users(id),
  due_date date,
  status text not null default 'todo' check(status in ('todo','doing','done')),
  created_by uuid not null references auth.users(id),
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ws_photos (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.ws_teams(id) on delete cascade,
  task_id uuid not null references public.ws_tasks(id) on delete cascade,
  storage_path text not null unique,
  caption text not null default '',
  step_id text not null default '',
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check(storage_path = team_id::text || '/' || task_id::text || '/' || split_part(storage_path, '/', 3))
);

create index if not exists ws_memberships_user_idx on public.ws_memberships(user_id);
create index if not exists ws_tasks_team_idx on public.ws_tasks(team_id,status);
create index if not exists ws_photos_task_idx on public.ws_photos(task_id);

-- SECURITY DEFINER leest memberships zonder RLS-recursie; auth.uid() bepaalt altijd de aanvrager.
create or replace function public.ws_is_member(p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.ws_memberships m where m.team_id=p_team and m.user_id=(select auth.uid()) and m.status='active');
$$;
create or replace function public.ws_is_admin(p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.ws_memberships m where m.team_id=p_team and m.user_id=(select auth.uid()) and m.status='active' and m.role='admin');
$$;
create or replace function public.ws_can_work(p_task uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.ws_tasks t
    where t.id=p_task and public.ws_is_member(t.team_id)
    and (t.assigned_to is null or t.assigned_to=(select auth.uid()) or public.ws_is_admin(t.team_id)));
$$;

-- Zorg dat je niet iemand buiten het team aan een taak kunt koppelen.
create or replace function public.ws_validate_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is not null and not exists(
    select 1 from public.ws_memberships m where m.team_id=new.team_id and m.user_id=new.assigned_to and m.status='active'
  ) then raise exception 'De toegewezen medewerker is geen actief teamlid'; end if;
  new.updated_at=now();
  return new;
end; $$;
drop trigger if exists ws_validate_task_trigger on public.ws_tasks;
create trigger ws_validate_task_trigger before insert or update on public.ws_tasks
for each row execute function public.ws_validate_task();

alter table public.ws_teams enable row level security;
alter table public.ws_memberships enable row level security;
alter table public.ws_tasks enable row level security;
alter table public.ws_photos enable row level security;

-- Minimaliseer toegang via de gewone Data API.
revoke all on public.ws_teams,public.ws_memberships,public.ws_tasks,public.ws_photos from anon,authenticated;
grant select on public.ws_teams,public.ws_memberships to authenticated;
grant select,insert,update,delete on public.ws_tasks,public.ws_photos to authenticated;

create policy "Teams: alleen leden" on public.ws_teams for select to authenticated
  using (public.ws_is_member(id));
create policy "Leden: eigen aanvraag of actief team" on public.ws_memberships for select to authenticated
  using (user_id=(select auth.uid()) or public.ws_is_member(team_id));
create policy "Taken: alle actieve leden mogen lezen" on public.ws_tasks for select to authenticated
  using (public.ws_is_member(team_id));
create policy "Taken: alleen beheerder mag toevoegen" on public.ws_tasks for insert to authenticated
  with check (public.ws_is_admin(team_id) and created_by=(select auth.uid()));
create policy "Taken: alleen beheerder mag bewerken" on public.ws_tasks for update to authenticated
  using (public.ws_is_admin(team_id)) with check(public.ws_is_admin(team_id));
create policy "Taken: alleen beheerder mag verwijderen" on public.ws_tasks for delete to authenticated
  using (public.ws_is_admin(team_id));
create policy "Foto's: actieve leden mogen lezen" on public.ws_photos for select to authenticated
  using (public.ws_is_member(team_id));
create policy "Foto's: gemachtigde uitvoerder mag toevoegen" on public.ws_photos for insert to authenticated
  with check (uploaded_by=(select auth.uid()) and public.ws_can_work(task_id)
    and exists(select 1 from public.ws_tasks t where t.id=task_id and t.team_id=ws_photos.team_id));
create policy "Foto's: uploader of beheerder mag verwijderen" on public.ws_photos for delete to authenticated
  using (uploaded_by=(select auth.uid()) or public.ws_is_admin(team_id));

-- Teams maken en lid worden kan alleen via gecontroleerde serverfuncties.
create or replace function public.ws_create_team(p_name text,p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Log eerst in'; end if;
  if char_length(trim(p_name)) not between 2 and 90 or char_length(trim(p_display_name)) not between 2 and 70 then
    raise exception 'Vul een geldige teamnaam en gebruikersnaam in'; end if;
  insert into public.ws_teams(name,created_by) values(trim(p_name),auth.uid()) returning id into v_id;
  insert into public.ws_memberships(team_id,user_id,display_name,role,status)
    values(v_id,auth.uid(),trim(p_display_name),'admin','active');
  return v_id;
end; $$;

create or replace function public.ws_request_join(p_team uuid,p_display_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Log eerst in'; end if;
  if char_length(trim(p_display_name)) not between 2 and 70 then raise exception 'Vul een geldige naam in'; end if;
  if not exists(select 1 from public.ws_teams where id=p_team) then raise exception 'Teamcode onbekend'; end if;
  insert into public.ws_memberships(team_id,user_id,display_name,role,status)
    values(p_team,auth.uid(),trim(p_display_name),'member','pending')
    on conflict(team_id,user_id) do nothing;
end; $$;

create or replace function public.ws_review_member(p_team uuid,p_user uuid,p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.ws_is_admin(p_team) then raise exception 'Alleen beheerders mogen leden goedkeuren'; end if;
  if not exists(select 1 from public.ws_memberships where team_id=p_team and user_id=p_user and status='pending') then
    raise exception 'Geen openstaande aanvraag gevonden'; end if;
  if p_approve then
    update public.ws_memberships set status='active' where team_id=p_team and user_id=p_user and status='pending';
  else
    delete from public.ws_memberships where team_id=p_team and user_id=p_user and status='pending';
  end if;
end; $$;

-- Checklist veilig afvinken: een gewone medewerker mag de werkinstructie niet wijzigen.
create or replace function public.ws_set_check(p_task uuid,p_check_id text,p_done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.ws_tasks%rowtype;
begin
  select * into t from public.ws_tasks where id=p_task for update;
  if not found then raise exception 'Taak niet gevonden'; end if;
  if not public.ws_can_work(p_task) then raise exception 'Deze taak is aan iemand anders toegewezen'; end if;
  if not exists(select 1 from jsonb_array_elements(t.checks) c where c->>'id'=p_check_id) then
    raise exception 'Controlepunt niet gevonden'; end if;
  update public.ws_tasks set
    checks=(select coalesce(jsonb_agg(
      case when c->>'id'=p_check_id then
        c || jsonb_build_object('done',p_done,'doneBy',case when p_done then auth.uid()::text else null end,'doneAt',case when p_done then now()::text else null end)
      else c end order by n), '[]'::jsonb)
      from jsonb_array_elements(t.checks) with ordinality as x(c,n)),
    status=case when t.status='done' and not p_done then 'doing' when t.status='todo' and p_done then 'doing' else t.status end,
    completed_at=case when t.status='done' and not p_done then null else t.completed_at end,
    completed_by=case when t.status='done' and not p_done then null else t.completed_by end
    where id=p_task;
end; $$;

create or replace function public.ws_set_status(p_task uuid,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.ws_tasks%rowtype;
begin
  if p_status not in ('todo','doing','done') then raise exception 'Ongeldige status'; end if;
  select * into t from public.ws_tasks where id=p_task for update;
  if not found then raise exception 'Taak niet gevonden'; end if;
  if not public.ws_can_work(p_task) then raise exception 'Deze taak is aan iemand anders toegewezen'; end if;
  if p_status='done' and exists(select 1 from jsonb_array_elements(t.checks) c where coalesce((c->>'done')::boolean,false)=false) then
    raise exception 'Vink eerst alle controlepunten af'; end if;
  update public.ws_tasks set status=p_status,
    completed_by=case when p_status='done' then auth.uid() else null end,
    completed_at=case when p_status='done' then now() else null end
  where id=p_task;
end; $$;

-- Alleen ingelogde gebruikers mogen de RPC-functies aanroepen.
revoke execute on function public.ws_is_member(uuid),public.ws_is_admin(uuid),public.ws_can_work(uuid),
  public.ws_create_team(text,text),public.ws_request_join(uuid,text),public.ws_review_member(uuid,uuid,boolean),
  public.ws_set_check(uuid,text,boolean),public.ws_set_status(uuid,text) from public,anon;
grant execute on function public.ws_is_member(uuid),public.ws_is_admin(uuid),public.ws_can_work(uuid),
  public.ws_create_team(text,text),public.ws_request_join(uuid,text),public.ws_review_member(uuid,uuid,boolean),
  public.ws_set_check(uuid,text,boolean),public.ws_set_status(uuid,text) to authenticated;

-- Afgeschermde foto-opslag: 5 MB per bestand, alleen JPEG, alle foto's gecomprimeerd.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('werkstandaard-team-fotos','werkstandaard-team-fotos',false,5242880,array['image/jpeg'])
on conflict (id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg'];

create policy "Teamfoto's bekijken" on storage.objects for select to authenticated
  using(bucket_id='werkstandaard-team-fotos'
    and exists(select 1 from public.ws_memberships m where m.team_id::text=split_part(name,'/',1)
      and m.user_id=(select auth.uid()) and m.status='active'));
create policy "Teamfoto's toevoegen" on storage.objects for insert to authenticated
  with check(bucket_id='werkstandaard-team-fotos'
    and exists(select 1 from public.ws_tasks t where t.team_id::text=split_part(name,'/',1)
      and t.id::text=split_part(name,'/',2) and public.ws_can_work(t.id)));
create policy "Teamfoto's verwijderen" on storage.objects for delete to authenticated
  using(bucket_id='werkstandaard-team-fotos' and
    (owner_id=(select auth.uid())::text or exists(
      select 1 from public.ws_memberships m where m.team_id::text=split_part(name,'/',1)
      and m.user_id=(select auth.uid()) and m.status='active' and m.role='admin')));

-- EINDE SQL: controleer in Table Editor de 4 tabellen en in Storage de privé bucket.
