begin;
alter table public.ritmo_tasks add column if not exists deleted_at timestamptz;
alter table public.ritmo_tasks add column if not exists deleted_from_status text;
alter table public.ritmo_tasks drop constraint if exists ritmo_tasks_status_check;
alter table public.ritmo_tasks add constraint ritmo_tasks_status_check check(status in ('pending','active','completed','continued','postponed','skipped','deferred','deleted'));

-- Recoverable deletion keeps task data, links and events, and stops scheduling.
create or replace function public.ritmo_delete_task(task_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;
begin
 select * into t from public.ritmo_tasks where id=task_id and user_id=uid for update;
 if not found then raise exception 'Tarea no encontrada.';end if;
 if t.status='deleted' then return jsonb_build_object('id',t.id,'title',t.title,'status','deleted');end if;
 update public.ritmo_tasks set deleted_from_status=t.status,status='deleted',deleted_at=now(),actual_end=case when t.status='active' then coalesce(actual_end,now()) else actual_end end,updated_at=now()where id=t.id;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'deleted',jsonb_build_object('previous_status',t.status));
 return jsonb_build_object('id',t.id,'title',t.title,'status','deleted');
end;$$;

create or replace function public.ritmo_restore_task(task_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;restored_status text;
begin
 select * into t from public.ritmo_tasks where id=task_id and user_id=uid for update;
 if not found or t.status<>'deleted' then raise exception 'Esta tarea ya no está en la papelera.';end if;
 restored_status:=coalesce(t.deleted_from_status,'deferred');
 if restored_status='active' then restored_status:='continued';end if;
 if restored_status='pending' and(t.starts_at<now()or exists(select 1 from public.ritmo_tasks where user_id=uid and id<>t.id and status in ('pending','active')and starts_at<t.ends_at and ends_at>t.starts_at))then restored_status:='deferred';end if;
 update public.ritmo_tasks set status=restored_status,deleted_at=null,deleted_from_status=null,updated_at=now()where id=t.id;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'restored',jsonb_build_object('status',restored_status));
 return jsonb_build_object('id',t.id,'title',t.title,'status',restored_status);
end;$$;

create or replace function public.ritmo_import_plan(plan_day date,items jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();item jsonb;n integer:=0;
begin
  if jsonb_typeof(items)<>'array' or jsonb_array_length(items)not between 1 and 80 then raise exception 'El plan debe tener entre 1 y 80 tareas.';end if;
  if exists(select 1 from public.ritmo_tasks where user_id=uid and (starts_at at time zone 'Europe/Madrid')::date=plan_day and status not in ('pending','deleted'))then raise exception 'Este día ya tiene bloques empezados o revisados. Edítalos desde la agenda.';end if;
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
 for t in select * from public.ritmo_tasks where user_id=uid and recurrence='daily' and status not in ('skipped','deleted') and(goal_starts_at at time zone 'Europe/Madrid')::date=from_day order by goal_starts_at loop
  s:=(to_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.goal_ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
  if not exists(select 1 from public.ritmo_tasks where user_id=uid and(((goal_starts_at at time zone 'Europe/Madrid')::date=to_day and source_task_id=t.id) or(status in ('pending','active') and starts_at<e and ends_at>s)))then
   insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time,goal_fixed_time)values(uid,t.title,s,e,t.category,t.priority,t.notes,'daily',t.id,t.goal_fixed_time,t.goal_fixed_time);n:=n+1;
  end if;
 end loop;return n;
end;$$;

create or replace function public.ritmo_reorganize(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();plan_day date:=(request->>'plan_day')::date;items jsonb:=request->'items';prepared jsonb:='[]';item jsonb;t public.ritmo_tasks;changes jsonb;window_start timestamptz:=(request->>'window_start')::timestamptz;window_end timestamptz:=(request->>'window_end')::timestamptz;clock_at timestamptz:=date_trunc('minute',now())+interval '1 minute';active_end timestamptz;budget integer;fixed boolean;include_today boolean;s timestamptz;e timestamptz;n integer:=0;restored integer:=0;child_id uuid;apply_changes boolean:=coalesce((request->>'apply')::boolean,false);
begin
 if plan_day is null or plan_day<(now() at time zone 'Europe/Madrid')::date or window_start is null or window_end is null or window_end<=window_start or(window_start at time zone 'Europe/Madrid')::date<>plan_day or(window_end at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Elige un día de hoy en adelante y una hora de inicio y fin dentro del mismo día.';end if;
 if plan_day=(now() at time zone 'Europe/Madrid')::date then window_start:=greatest(window_start,clock_at);end if;
 select max(ends_at) into active_end from public.ritmo_tasks where user_id=uid and status='active';window_start:=greatest(window_start,coalesce(active_end,window_start));
 if window_start>=window_end then raise exception 'El bloque en curso o la hora actual deja este horario sin tiempo. Elige una hora de fin posterior.';end if;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)not between 1 and 80 then raise exception 'Elige entre 1 y 80 bloques para reorganizar.';end if;
 if(select count(distinct value->>'id')from jsonb_array_elements(items))<>jsonb_array_length(items)then raise exception 'Hay tareas repetidas en el ajuste.';end if;
 for item in select value from jsonb_array_elements(items)loop
  select * into t from public.ritmo_tasks x where id=(item->>'id')::uuid and user_id=uid and(status in ('pending','deferred') or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid and child.status<>'deleted')) and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day for update;
  if not found then raise exception 'La agenda ha cambiado. Vuelve a abrir Reorganizar mi día para usar su estado actual.';end if;
  budget:=(item->>'minutes')::integer;fixed:=coalesce((item->>'fixed_time')::boolean,false);include_today:=coalesce((item->>'include')::boolean,true);s:=coalesce((item->>'starts_at')::timestamptz,t.starts_at);e:=s+make_interval(mins=>budget);
  if budget is null or budget not between 5 and 720 or(s at time zone 'Europe/Madrid')::date<>plan_day or(fixed and(e at time zone 'Europe/Madrid')::date<>plan_day)then raise exception 'Revisa las horas: cada duración debe estar entre 5 y 720 minutos y quedar dentro del día.';end if;
  prepared:=prepared||jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'fixed_starts_at',s,'fixed_ends_at',e,'minutes',budget,'fixed_time',fixed,'include',include_today,'was_deferred',t.status<>'pending','continuation',t.status='continued'));n:=n+1;
 end loop;
 if n<>(select count(*)from public.ritmo_tasks x where user_id=uid and(status in ('pending','deferred') or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid and child.status<>'deleted')) and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day)then raise exception 'Hay nuevos bloques en tu agenda. Vuelve a abrir Reorganizar mi día para incluirlos.';end if;
 changes:=public.ritmo_pack(prepared,window_start,window_end);
 for item in select value from jsonb_array_elements(changes)loop
  if item->>'status'='pending' and(item->>'was_deferred')::boolean then restored:=restored+1;end if;
  if apply_changes then
   -- Unplaced blocks retain their previous times; they occupy no scheduled window.
   if(item->>'continuation')::boolean then
    if item->>'status'='pending'then
     select * into t from public.ritmo_tasks where id=(item->>'id')::uuid and user_id=uid;
     insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time,goal_fixed_time)values(uid,t.title,(item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,t.category,t.priority,left(concat_ws(E'\n',nullif(t.notes,''),nullif(t.review,'')),4000),'none',t.id,(item->>'fixed_time')::boolean,(item->>'fixed_time')::boolean)returning id into child_id;
     insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'continuation_scheduled',jsonb_build_object('new_task_id',child_id,'starts_at',item->>'starts_at'));
    end if;
   else
    update public.ritmo_tasks set status=item->>'status',starts_at=case when item->>'status'='pending' then(item->>'starts_at')::timestamptz else starts_at end,ends_at=case when item->>'status'='pending' then(item->>'ends_at')::timestamptz else ends_at end,fixed_time=(item->>'fixed_time')::boolean,fixed_starts_at=(item->>'fixed_starts_at')::timestamptz,fixed_ends_at=(item->>'fixed_ends_at')::timestamptz,updated_at=now()where id=(item->>'id')::uuid and user_id=uid;
   end if;
   insert into public.ritmo_events(user_id,task_id,event,details)values(uid,(item->>'id')::uuid,'day_reorganized',item);
  end if;
 end loop;
 return jsonb_build_object('changes',changes,'restored',restored,'unplaced',(select count(*)from jsonb_array_elements(changes)x where x->>'status'='deferred'),'window_start',window_start,'window_end',window_end,'applied',apply_changes);
end;$$;

revoke all on function public.ritmo_delete_task(uuid),public.ritmo_restore_task(uuid) from public,anon;
grant execute on function public.ritmo_delete_task(uuid),public.ritmo_restore_task(uuid) to authenticated;
commit;
