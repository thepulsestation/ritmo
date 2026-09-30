begin;
alter table public.ritmo_tasks add column if not exists recurrence_days smallint[];
alter table public.ritmo_tasks add column if not exists repeat_series_id uuid;
alter table public.ritmo_tasks drop constraint if exists ritmo_tasks_recurrence_check;
alter table public.ritmo_tasks add constraint ritmo_tasks_recurrence_check check(recurrence in ('none','daily','weekly'));
update public.ritmo_tasks set recurrence_days=case when recurrence='daily' then array[1,2,3,4,5,6,7]::smallint[] else array[]::smallint[] end where recurrence_days is null;

-- A series represents one recurring time slot; routine_id groups its duration metrics.
with recursive series as (
 select t.id,t.user_id,t.id as root from public.ritmo_tasks t
 where t.recurrence='none' or not exists(select 1 from public.ritmo_tasks p where p.id=t.source_task_id and p.user_id=t.user_id and p.recurrence<>'none')
 union all
 select c.id,c.user_id,p.root from public.ritmo_tasks c join series p on c.source_task_id=p.id and c.user_id=p.user_id
 where c.recurrence<>'none' and exists(select 1 from public.ritmo_tasks x where x.id=p.id and x.recurrence<>'none')
)
update public.ritmo_tasks t set repeat_series_id=s.root from series s where t.id=s.id and t.repeat_series_id is null;
update public.ritmo_tasks set repeat_series_id=id where repeat_series_id is null;

create or replace function public.ritmo_normalize_days(days smallint[]) returns smallint[] language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from unnest(days)d where d is null or d not between 1 and 7) then raise exception 'Elige días de lunes (1) a domingo (7).';end if;
 return coalesce((select array_agg(distinct d order by d) from unnest(days)d),array[]::smallint[]);
end;$$;
create or replace function public.ritmo_days_from_item(item jsonb) returns smallint[] language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if item ? 'recurrence_days' then
  if jsonb_typeof(item->'recurrence_days') is distinct from 'array' then raise exception 'Selecciona los días de repetición.';end if;
  if exists(select 1 from jsonb_array_elements(item->'recurrence_days')d where jsonb_typeof(d)<>'number' or d::text !~ '^[1-7]$')then raise exception 'Elige días de lunes (1) a domingo (7).';end if;
  return public.ritmo_normalize_days(array(select d::text::smallint from jsonb_array_elements(item->'recurrence_days')d));
 end if;
 if item->>'recurrence'='weekly' then raise exception 'Selecciona los días de la repetición semanal.';end if;
 return case when item->>'recurrence'='daily' then array[1,2,3,4,5,6,7]::smallint[] else array[]::smallint[] end;
end;$$;
create or replace function public.ritmo_weekday_identity() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.ritmo_tasks;
begin
 if tg_op='INSERT' then
  select * into p from public.ritmo_tasks where id=new.source_task_id and user_id=new.user_id;
  if new.recurrence_days is null then
   new.recurrence_days:=case when new.recurrence<>'none' and p.recurrence=new.recurrence then p.recurrence_days when new.recurrence='daily' then array[1,2,3,4,5,6,7]::smallint[] else array[]::smallint[] end;
  end if;
  new.repeat_series_id:=coalesce(new.repeat_series_id,case when new.recurrence<>'none' and p.recurrence<>'none' then p.repeat_series_id end,new.id);
 elsif new.recurrence is distinct from old.recurrence and new.recurrence_days is not distinct from old.recurrence_days then
  if new.recurrence='none' then new.recurrence_days:=array[]::smallint[];
  elsif new.recurrence='daily' then new.recurrence_days:=array[1,2,3,4,5,6,7]::smallint[];end if;
 end if;
 new.recurrence_days:=public.ritmo_normalize_days(new.recurrence_days);
 new.recurrence:=case when cardinality(new.recurrence_days)=7 then 'daily' when cardinality(new.recurrence_days)>0 then 'weekly' else 'none' end;
 return new;
end;$$;
drop trigger if exists ritmo_weekday_identity on public.ritmo_tasks;
create trigger ritmo_weekday_identity before insert or update of recurrence,recurrence_days on public.ritmo_tasks for each row execute function public.ritmo_weekday_identity();
alter table public.ritmo_tasks alter column recurrence_days set not null;
alter table public.ritmo_tasks alter column repeat_series_id set not null;
alter table public.ritmo_tasks drop constraint if exists ritmo_tasks_weekdays_check;
alter table public.ritmo_tasks add constraint ritmo_tasks_weekdays_check check(recurrence_days=public.ritmo_normalize_days(recurrence_days) and ((recurrence='none' and cardinality(recurrence_days)=0) or (recurrence='weekly' and cardinality(recurrence_days) between 1 and 6) or (recurrence='daily' and cardinality(recurrence_days)=7)));
create index if not exists ritmo_tasks_series_day on public.ritmo_tasks(user_id,repeat_series_id,goal_starts_at);

create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;days smallint[]:=public.ritmo_days_from_item(item);rule text:=case when cardinality(days)=7 then 'daily' when cardinality(days)>0 then 'weekly' else 'none' end;
begin
 if task_id is not null and not exists(select 1 from public.ritmo_tasks where id=task_id and user_id=uid and status in ('pending','deferred'))then raise exception 'Solo puedes editar tareas pendientes o por recolocar. Cierra primero el bloque en curso.';end if;
 perform public.ritmo_check_slot(uid,s,e,task_id);
 if task_id is null then
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,fixed_time)values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),rule,days,coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')))returning id into result;
 else
  update public.ritmo_tasks set title=item->>'title',status='pending',goal_starts_at=case when starts_at<>s or ends_at<>e then s else goal_starts_at end,goal_ends_at=case when starts_at<>s or ends_at<>e then e else goal_ends_at end,starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=rule,recurrence_days=days,fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),goal_fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),fixed_starts_at=s,fixed_ends_at=e,updated_at=now()where id=task_id and user_id=uid returning id into result;
 end if;
 insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;

drop function if exists public.ritmo_repeat_task(uuid,timestamptz,timestamptz,boolean);
create or replace function public.ritmo_repeat_task(task_id uuid,new_start timestamptz,new_end timestamptz,repeat_daily boolean default false,repeat_days smallint[] default null)returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;result uuid;days smallint[]:=public.ritmo_normalize_days(coalesce(repeat_days,case when repeat_daily then array[1,2,3,4,5,6,7]::smallint[] else array[]::smallint[] end));
begin
 select * into t from public.ritmo_tasks where id=task_id and user_id=uid and status<>'deleted';if not found then raise exception 'Tarea no encontrada.';end if;
 if new_start<now()then raise exception 'Elige una hora futura para la repetición.';end if;
 perform public.ritmo_check_slot(uid,new_start,new_end);
 insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,routine_id,fixed_time,goal_fixed_time)values(uid,t.title,new_start,new_end,t.category,t.priority,t.notes,case when cardinality(days)=7 then 'daily' when cardinality(days)>0 then 'weekly' else 'none' end,days,t.routine_id,t.goal_fixed_time,t.goal_fixed_time)returning id into result;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'repeated',jsonb_build_object('new_task_id',result,'starts_at',new_start,'ends_at',new_end));return result;
end;$$;

-- Use the latest occurrence before the source day, so days off do not erase a routine.
create or replace function public.ritmo_copy_routine(from_day date,to_day date) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;s timestamptz;e timestamptz;n integer:=0;
begin
 if from_day is null or to_day is null or to_day<=from_day or to_day<(now()at time zone 'Europe/Madrid')::date then raise exception 'Elige un día futuro posterior al día de origen.';end if;
 for t in select * from (
  select distinct on (repeat_series_id) * from public.ritmo_tasks where user_id=uid and status<>'deleted' and(goal_starts_at at time zone 'Europe/Madrid')::date<=from_day
  order by repeat_series_id,goal_starts_at desc,created_at desc,id
 )latest where recurrence<>'none' and status<>'skipped' and extract(isodow from to_day)::smallint=any(recurrence_days) order by goal_starts_at loop
  s:=(to_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.goal_ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
  if s>=now() and not exists(select 1 from public.ritmo_tasks where user_id=uid and (((goal_starts_at at time zone 'Europe/Madrid')::date=to_day and repeat_series_id=t.repeat_series_id)or(status in ('pending','active')and starts_at<e and greatest(ends_at,case when status='active' then now() else ends_at end)>s)))then
   insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,source_task_id,repeat_series_id,routine_id,fixed_time,goal_fixed_time)values(uid,t.title,s,e,t.category,t.priority,t.notes,t.recurrence,t.recurrence_days,t.id,t.repeat_series_id,t.routine_id,t.goal_fixed_time,t.goal_fixed_time);n:=n+1;
  end if;
 end loop;return n;
end;$$;
revoke all on function public.ritmo_normalize_days(smallint[]),public.ritmo_days_from_item(jsonb),public.ritmo_weekday_identity()from public,anon,authenticated;
revoke all on function public.ritmo_repeat_task(uuid,timestamptz,timestamptz,boolean,smallint[])from public,anon;
grant execute on function public.ritmo_repeat_task(uuid,timestamptz,timestamptz,boolean,smallint[])to authenticated;
-- The check constraint also runs for service-role maintenance.
grant execute on function public.ritmo_normalize_days(smallint[])to service_role;
notify pgrst,'reload schema';
commit;
