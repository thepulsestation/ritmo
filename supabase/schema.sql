-- Ritmo owns only tables/functions prefixed ritmo_. Existing applications are untouched.
create table if not exists public.ritmo_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notifications_enabled boolean not null default false
);
create table if not exists public.ritmo_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ritmo_owners(user_id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  starts_at timestamptz not null, ends_at timestamptz not null,
  category text not null check(category in ('personal','work','business','english','meals','rest')),
  priority text not null default 'media' check(priority in ('alta','media','baja')),
  notes text not null default '' check(length(notes)<=4000),
  recurrence text not null default 'none' check(recurrence in ('none','daily')),
  status text not null default 'pending' check(status in ('pending','active','completed','continued','postponed','skipped')),
  actual_start timestamptz, actual_end timestamptz,
  review text not null default '' check(length(review)<=4000), rating integer check(rating between 1 and 5),
  source_task_id uuid references public.ritmo_tasks(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(ends_at>starts_at),check(ends_at-starts_at between interval '5 minutes' and interval '12 hours'),
  check((starts_at at time zone 'Europe/Madrid')::date=(ends_at at time zone 'Europe/Madrid')::date)
);
create index if not exists ritmo_tasks_schedule on public.ritmo_tasks(user_id,starts_at);
create unique index if not exists ritmo_one_active on public.ritmo_tasks(user_id) where status='active';
create table if not exists public.ritmo_events (
  id bigint generated always as identity primary key,user_id uuid not null references public.ritmo_owners(user_id) on delete cascade,
  task_id uuid references public.ritmo_tasks(id) on delete set null,event text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create table if not exists public.ritmo_push_subscriptions (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references public.ritmo_owners(user_id) on delete cascade,
  endpoint text not null check(length(endpoint)<4096),subscription jsonb not null,device_label text not null default '',created_at timestamptz not null default now(),
  unique(user_id,endpoint),check(subscription->>'endpoint'=endpoint)
);
create table if not exists public.ritmo_notification_deliveries (
  id uuid primary key default gen_random_uuid(),task_id uuid references public.ritmo_tasks(id) on delete cascade,
  subscription_id uuid not null references public.ritmo_push_subscriptions(id) on delete cascade,
  kind text not null,slot integer not null,delivered_at timestamptz,claimed_at timestamptz not null default now(),error text,
  unique(task_id,subscription_id,kind,slot)
);
create table if not exists public.ritmo_health(id integer primary key check(id=1),checked_at timestamptz not null default now());
create unique index if not exists ritmo_test_rate_limit on public.ritmo_notification_deliveries(subscription_id,kind,slot) where task_id is null;
alter table public.ritmo_owners enable row level security;
alter table public.ritmo_tasks enable row level security;
alter table public.ritmo_events enable row level security;
alter table public.ritmo_push_subscriptions enable row level security;
alter table public.ritmo_notification_deliveries enable row level security;
alter table public.ritmo_health enable row level security;
create policy ritmo_owner_read on public.ritmo_owners for select to authenticated using(user_id=(select auth.uid()));
create policy ritmo_task_read on public.ritmo_tasks for select to authenticated using(user_id=(select auth.uid()));
create policy ritmo_event_read on public.ritmo_events for select to authenticated using(user_id=(select auth.uid()));
create policy ritmo_push_own on public.ritmo_push_subscriptions for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()) and exists(select 1 from public.ritmo_owners where user_id=(select auth.uid())));
create policy ritmo_health_read on public.ritmo_health for select to authenticated using(exists(select 1 from public.ritmo_owners where user_id=(select auth.uid())));
revoke all on public.ritmo_owners,public.ritmo_tasks,public.ritmo_events,public.ritmo_health,public.ritmo_notification_deliveries from anon,authenticated;
revoke all on public.ritmo_push_subscriptions from anon,authenticated;
grant select on public.ritmo_owners,public.ritmo_tasks,public.ritmo_events,public.ritmo_health to authenticated;
grant select,insert,update,delete on public.ritmo_push_subscriptions to authenticated;
grant all on public.ritmo_owners,public.ritmo_tasks,public.ritmo_events,public.ritmo_health,public.ritmo_notification_deliveries,public.ritmo_push_subscriptions to service_role;

create or replace function public.ritmo_require_owner() returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=auth.uid();
begin
  if uid is null or not exists(select 1 from public.ritmo_owners where user_id=uid) then raise exception 'Esta cuenta no tiene acceso a tu agenda personal.';end if;
  perform pg_advisory_xact_lock(hashtextextended('ritmo:'||uid::text,0));
  return uid;
end;$$;
create or replace function public.ritmo_check_slot(uid uuid,s timestamptz,e timestamptz,exclude_id uuid default null) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if s is null or e is null or e-s<interval '5 minutes' or e-s>interval '12 hours' or (s at time zone 'Europe/Madrid')::date<>(e at time zone 'Europe/Madrid')::date then raise exception 'El bloque debe durar de 5 minutos a 12 horas y quedar dentro del mismo día.';end if;
  if exists(select 1 from public.ritmo_tasks where user_id=uid and (exclude_id is null or id<>exclude_id) and status<>'skipped' and starts_at<e and ends_at>s)then raise exception 'Ese horario se solapa con otro bloque. Elige otro momento.';end if;
end;$$;
create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;
begin
  if task_id is not null and not exists(select 1 from public.ritmo_tasks where id=task_id and user_id=uid and status='pending')then raise exception 'Solo puedes editar tareas pendientes. Cierra primero el bloque en curso.';end if;
  perform public.ritmo_check_slot(uid,s,e,task_id);
  if task_id is null then
    insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence) values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),coalesce(item->>'recurrence','none'))returning id into result;
  else
    update public.ritmo_tasks set title=item->>'title',starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=coalesce(item->>'recurrence','none'),updated_at=now()where id=task_id and user_id=uid returning id into result;
  end if;
  insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;
create or replace function public.ritmo_start_task(task_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();
begin
  if exists(select 1 from public.ritmo_tasks where user_id=uid and status='active')then raise exception 'Cierra primero el bloque que sigue en curso.';end if;
  update public.ritmo_tasks set status='active',actual_start=now(),updated_at=now()where id=task_id and user_id=uid and status='pending' and ends_at>now();
  if not found then raise exception 'Esta tarea ya cambió o su horario terminó. Revisa la agenda.';end if;
  insert into public.ritmo_events(user_id,task_id,event)values(uid,task_id,'started');
end;$$;
create or replace function public.ritmo_reschedule_task(task_id uuid,new_start timestamptz,new_end timestamptz) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;result uuid;
begin
  select * into t from public.ritmo_tasks where id=task_id and user_id=uid for update;if not found then raise exception 'Tarea no encontrada.';end if;
  if new_start<now()then raise exception 'Elige un horario futuro para el nuevo bloque.';end if;
  if exists(select 1 from public.ritmo_tasks where user_id=uid and source_task_id=task_id and status in ('pending','active'))then raise exception 'Ya hay una continuación pendiente de esta tarea. Revisa la agenda.';end if;
  perform public.ritmo_check_slot(uid,new_start,new_end,task_id);
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id)values(uid,t.title,new_start,new_end,t.category,t.priority,concat_ws(E'\n',nullif(t.notes,''),nullif(t.review,'')),t.recurrence,t.id)returning id into result;
  if t.status in ('pending','active')then update public.ritmo_tasks set status='postponed',actual_end=now(),updated_at=now()where id=task_id;end if;
  insert into public.ritmo_events(user_id,task_id,event,details)values(uid,task_id,'rescheduled',jsonb_build_object('new_task_id',result,'starts_at',new_start));return result;
end;$$;
create or replace function public.ritmo_close_task(task_id uuid,outcome text,review_text text default '',score integer default null,new_start timestamptz default null,new_end timestamptz default null) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();
begin
  if outcome not in ('completed','continued','postponed','skipped')then raise exception 'Estado no válido.';end if;
  if score is not null and(score<1 or score>5)then raise exception 'La valoración debe ser de 1 a 5.';end if;
  update public.ritmo_tasks set status=outcome,actual_end=now(),review=coalesce(review_text,''),rating=score,updated_at=now()where id=task_id and user_id=uid and status in ('pending','active');
  if not found then raise exception 'Este bloque ya se ha revisado. Actualiza tu agenda.';end if;
  if outcome='postponed'then perform public.ritmo_reschedule_task(task_id,new_start,new_end);end if;
  insert into public.ritmo_events(user_id,task_id,event,details)values(uid,task_id,outcome,jsonb_build_object('review',review_text,'rating',score));
end;$$;
create or replace function public.ritmo_import_plan(plan_day date,items jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();item jsonb;n integer:=0;
begin
  if jsonb_typeof(items)<>'array' or jsonb_array_length(items)not between 1 and 80 then raise exception 'El plan debe tener entre 1 y 80 tareas.';end if;
  if exists(select 1 from public.ritmo_tasks where user_id=uid and (starts_at at time zone 'Europe/Madrid')::date=plan_day and status<>'pending')then raise exception 'Este día ya tiene bloques empezados o revisados. Edítalos desde la agenda.';end if;
  -- Transactional replacement: any invalid item rolls back the whole import.
  delete from public.ritmo_tasks where user_id=uid and (starts_at at time zone 'Europe/Madrid')::date=plan_day and status='pending';
  for item in select value from jsonb_array_elements(items)loop
    if((item->>'starts_at')::timestamptz at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Todos los bloques deben pertenecer al día del plan.';end if;
    perform public.ritmo_save_task(null,item);n:=n+1;
  end loop;
  insert into public.ritmo_events(user_id,event,details)values(uid,'plan_imported',jsonb_build_object('day',plan_day,'count',n));return n;
end;$$;
create or replace function public.ritmo_copy_routine(from_day date,to_day date) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;s timestamptz;e timestamptz;n integer:=0;
begin
  if to_day<=from_day then raise exception 'Elige un día posterior.';end if;
  for t in select * from public.ritmo_tasks where user_id=uid and recurrence='daily' and status<>'skipped' and(starts_at at time zone 'Europe/Madrid')::date=from_day order by starts_at loop
    s:=(to_day+(t.starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
    if not exists(select 1 from public.ritmo_tasks where user_id=uid and status<>'skipped' and starts_at<e and ends_at>s)then
      insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id)values(uid,t.title,s,e,t.category,t.priority,t.notes,'daily',t.id);n:=n+1;
    end if;
  end loop;return n;
end;$$;
create or replace function public.ritmo_set_notifications(enabled boolean) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();begin update public.ritmo_owners set notifications_enabled=enabled where user_id=uid;end;$$;

revoke all on function public.ritmo_require_owner(),public.ritmo_check_slot(uuid,timestamptz,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.ritmo_save_task(uuid,jsonb),public.ritmo_start_task(uuid),public.ritmo_reschedule_task(uuid,timestamptz,timestamptz),public.ritmo_close_task(uuid,text,text,integer,timestamptz,timestamptz),public.ritmo_import_plan(date,jsonb),public.ritmo_copy_routine(date,date),public.ritmo_set_notifications(boolean) from public,anon;
grant execute on function public.ritmo_save_task(uuid,jsonb),public.ritmo_start_task(uuid),public.ritmo_reschedule_task(uuid,timestamptz,timestamptz),public.ritmo_close_task(uuid,text,text,integer,timestamptz,timestamptz),public.ritmo_import_plan(date,jsonb),public.ritmo_copy_routine(date,date),public.ritmo_set_notifications(boolean) to authenticated;
