begin;
-- A postponed occurrence is punctual; remember which routine it replaces that day.
alter table public.ritmo_tasks add column if not exists carry_series_id uuid;

create or replace function public.ritmo_extend_active(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;tid uuid:=(request->>'task_id')::uuid;
 e timestamptz:=(request->>'ends_at')::timestamptz;plan_day date;anchor public.ritmo_tasks;
 changes jsonb;item jsonb;delta interval;apply_changes boolean:=coalesce((request->>'apply')::boolean,false);
begin
 select * into t from public.ritmo_tasks where id=tid and user_id=uid for update;
 if not found or t.status<>'active' then raise exception 'Este bloque ya no está en curso. Actualiza la agenda.';end if;
 if nullif(request->>'version','') is null or (request->>'version')::timestamptz<>t.updated_at then raise exception 'La tarea ha cambiado. Vuelve a abrir Necesito más tiempo.';end if;
 plan_day:=(t.goal_starts_at at time zone 'Europe/Madrid')::date;
 if e is null or e<=greatest(now(),t.ends_at) or e-t.starts_at>interval '12 hours' or(e at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Elige un fin posterior al actual y a la hora de ahora, dentro del día y de las 12 horas máximas del bloque.';end if;
 select * into anchor from public.ritmo_tasks where user_id=uid and id<>tid and status='pending' and fixed_time
  and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day and fixed_ends_at>t.starts_at
  order by fixed_starts_at,id limit 1;
 if anchor.id is not null and e>anchor.fixed_starts_at then raise exception 'La ampliación alcanzaría «%», que empieza a las %. Conserva esa hora fija o cambia primero ese bloque.',anchor.title,to_char(anchor.fixed_starts_at at time zone 'Europe/Madrid','HH24:MI');end if;
 delta:=greatest(interval '0',e-coalesce(t.reflow_until,t.ends_at));
 changes:=jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',t.starts_at,'ends_at',e,'status','active','fixed_time',t.fixed_time));
 if apply_changes then
  update public.ritmo_tasks set ends_at=e,reflow_until=e,fixed_ends_at=case when fixed_time then e else fixed_ends_at end,updated_at=clock_timestamp() where id=tid;
  insert into public.ritmo_events(user_id,task_id,event,details)values(uid,tid,'active_extended',jsonb_build_object('old_end',t.ends_at,'ends_at',e,'goal_end',t.goal_ends_at));
 end if;
 changes:=changes||public.ritmo_reflow(uid,plan_day,t.starts_at,tid,delta,e,apply_changes);
 if apply_changes then
  -- Keep delivery history, but release deduplication keys for the new deadlines.
  -- The sender rechecks status and times before delivering any in-flight notice.
  for item in select value from jsonb_array_elements(changes)loop
   update public.ritmo_notification_deliveries set kind=kind||'@before-extension-'||extract(epoch from clock_timestamp())::text
    where task_id=(item->>'id')::uuid and kind in ('end','repeat');
  end loop;
 end if;
 return jsonb_build_object('changes',changes,'ends_at',e,'applied',apply_changes);
end;$$;

create or replace function public.ritmo_postpone_tomorrow(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;child public.ritmo_tasks;tid uuid:=(request->>'task_id')::uuid;
 target_day date; s timestamptz;e timestamptz;stamp timestamptz:=clock_timestamp();event_id bigint;
begin
 select * into t from public.ritmo_tasks where id=tid and user_id=uid for update;
 if not found or t.status not in ('pending','deferred')then raise exception 'Solo puedes pasar directamente tareas pendientes o sin hueco. Cierra primero el bloque en curso.';end if;
 if nullif(request->>'version','') is null or(request->>'version')::timestamptz<>t.updated_at then raise exception 'Esta tarea ha cambiado. Actualiza tu agenda antes de pasarla a mañana.';end if;
 if exists(select 1 from public.ritmo_tasks where user_id=uid and source_task_id=tid and status<>'deleted')then raise exception 'Esta tarea ya tiene otro bloque. Revisa su continuación.';end if;
 target_day:=greatest((now() at time zone 'Europe/Madrid')::date,(t.goal_starts_at at time zone 'Europe/Madrid')::date)+1;
 s:=(target_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
 e:=s+least(interval '12 hours',greatest(interval '5 minutes',case when t.status='deferred' then t.goal_ends_at-t.goal_starts_at else t.ends_at-t.starts_at end));
 -- The times only preserve a suggested window. Deferred tasks reserve no slot or notices.
 if(e at time zone 'Europe/Madrid')::date<>target_day then e:=((target_day+1)::timestamp at time zone 'Europe/Madrid')-interval '1 minute';s:=least(s,e-interval '5 minutes');end if;
 insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,source_task_id,routine_id,carry_series_id,status,fixed_time,goal_fixed_time,updated_at)
 values(uid,t.title,s,e,t.category,t.priority,t.notes,'none',array[]::smallint[],tid,t.routine_id,coalesce(t.carry_series_id,t.repeat_series_id),'deferred',t.fixed_time,t.goal_fixed_time,stamp)returning * into child;
 update public.ritmo_tasks set status='postponed',updated_at=stamp where id=tid;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,tid,'quick_postponed',jsonb_build_object('new_task_id',child.id,'target_day',target_day,'previous_status',t.status))returning id into event_id;
 return jsonb_build_object('id',tid,'title',t.title,'new_task_id',child.id,'target_day',target_day,'source_version',stamp,'target_version',child.updated_at,'event_id',event_id);
end;$$;

create or replace function public.ritmo_undo_postpone(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;child public.ritmo_tasks;decision public.ritmo_events;restored_status text;
begin
 select * into t from public.ritmo_tasks where id=(request->>'task_id')::uuid and user_id=uid for update;
 select * into child from public.ritmo_tasks where id=(request->>'new_task_id')::uuid and user_id=uid for update;
 select * into decision from public.ritmo_events where id=(request->>'event_id')::bigint and user_id=uid and task_id=t.id and event='quick_postponed' and details->>'new_task_id'=child.id::text;
 if decision.id is null or t.status<>'postponed' or child.status<>'deferred' or child.source_task_id<>t.id or child.actual_start is not null
  or (request->>'source_version')::timestamptz is distinct from t.updated_at or(request->>'target_version')::timestamptz is distinct from child.updated_at
  or exists(select 1 from public.ritmo_tasks where user_id=uid and source_task_id=child.id and status<>'deleted')then raise exception 'La tarea de mañana ya ha cambiado. Conservamos esos cambios; puedes revisarla en la agenda.';end if;
 restored_status:=decision.details->>'previous_status';
 if restored_status='pending' and(t.starts_at<now()or exists(select 1 from public.ritmo_tasks where user_id=uid and id<>t.id and status in ('pending','active')and starts_at<t.ends_at and ends_at>t.starts_at))then restored_status:='deferred';end if;
 -- This cancelled copy is not a user deletion and does not belong in the trash.
 delete from public.ritmo_tasks where id=child.id and user_id=uid;
 update public.ritmo_tasks set status=restored_status,updated_at=clock_timestamp()where id=t.id;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'postpone_undone',jsonb_build_object('new_task_id',child.id,'postpone_event_id',decision.id,'status',restored_status));
 return jsonb_build_object('id',t.id,'title',t.title,'status',restored_status);
end;$$;

revoke all on function public.ritmo_extend_active(jsonb),public.ritmo_postpone_tomorrow(jsonb),public.ritmo_undo_postpone(jsonb)from public,anon;
grant execute on function public.ritmo_extend_active(jsonb),public.ritmo_postpone_tomorrow(jsonb),public.ritmo_undo_postpone(jsonb)to authenticated;

-- Reuse postponed blocks when importing a plan; omitted unplaced work stays unplaced.
create or replace function public.ritmo_import_plan(plan_day date,items jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=public.ritmo_require_owner();item jsonb;normalized jsonb:='[]'::jsonb;n integer:=0;existing_id uuid;series uuid;
 keep_ids uuid[]:=array[]::uuid[];seen_series uuid[]:=array[]::uuid[];original public.ritmo_tasks;
begin
 if plan_day is null or plan_day<(now()at time zone 'Europe/Madrid')::date then raise exception 'Elige hoy o un día futuro para preparar la agenda.';end if;
 if items is null or jsonb_typeof(items)<>'array' or jsonb_array_length(items)not between 1 and 80 then raise exception 'El plan debe tener entre 1 y 80 tareas.';end if;
 if exists(select 1 from public.ritmo_tasks where user_id=uid and(starts_at at time zone 'Europe/Madrid')::date=plan_day and status not in ('pending','deferred','deleted'))then raise exception 'Este día ya tiene bloques empezados o revisados. Edítalos desde la agenda.';end if;
 -- Resolve pending references before changing slots. Any failure rolls back the whole plan.
 for item in select value from jsonb_array_elements(items)loop
  if jsonb_typeof(item)<>'object' or item->>'starts_at' is null or((item->>'starts_at')::timestamptz at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Todos los bloques deben pertenecer al día del plan.';end if;
  existing_id:=nullif(item->>'existing_task_id','')::uuid;series:=nullif(item->>'repeat_series_id','')::uuid;
  if series is not null then
   if series=any(seen_series)then raise exception 'La misma rutina aparece dos veces en el plan.';end if;
   seen_series:=array_append(seen_series,series);
   if existing_id is null then
    select id into existing_id from public.ritmo_tasks where user_id=uid and repeat_series_id=series and(starts_at at time zone 'Europe/Madrid')::date=plan_day and status in ('pending','deferred') order by created_at limit 1;
   end if;
  end if;
  if existing_id is not null then
   select * into original from public.ritmo_tasks where id=existing_id and user_id=uid and status in ('pending','deferred') and(starts_at at time zone 'Europe/Madrid')::date=plan_day;
   if not found then raise exception 'Esta referencia no es una tarea pendiente del día elegido.';end if;
   if existing_id=any(keep_ids)then raise exception 'La misma tarea aparece dos veces en el plan.';end if;
   if(series is not null and series<>original.repeat_series_id)or(nullif(item->>'routine_id','')::uuid is not null and(item->>'routine_id')::uuid<>original.routine_id)then raise exception 'Conserva las referencias originales de la tarea ya programada.';end if;
   keep_ids:=array_append(keep_ids,existing_id);item:=item||jsonb_build_object('existing_task_id',existing_id);
  end if;
  normalized:=normalized||jsonb_build_array(item);
 end loop;
 -- Omitted pending tasks remain recoverable from the ordinary trash UI.
 for original in select * from public.ritmo_tasks where user_id=uid and(starts_at at time zone 'Europe/Madrid')::date=plan_day and status='pending' and not(id=any(keep_ids))loop
  perform public.ritmo_delete_task(original.id);
 end loop;
 -- Release retained slots inside this transaction so swapping two blocks is valid.
 update public.ritmo_tasks set status='deferred' where user_id=uid and id=any(keep_ids);
 for item in select value from jsonb_array_elements(normalized)loop
  perform public.ritmo_save_task(nullif(item->>'existing_task_id','')::uuid,item);n:=n+1;
 end loop;
 insert into public.ritmo_events(user_id,event,details)values(uid,'plan_imported',jsonb_build_object('day',plan_day,'count',n));return n;
end;$$;

create or replace function public.ritmo_copy_routine(from_day date,to_day date) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;s timestamptz;e timestamptz;n integer:=0;
begin
 if from_day is null or to_day is null or to_day<=from_day or to_day<(now()at time zone 'Europe/Madrid')::date then raise exception 'Elige un día futuro posterior al día de origen.';end if;
 for t in select * from (
  select distinct on (repeat_series_id) * from public.ritmo_tasks where user_id=uid and status<>'deleted' and(goal_starts_at at time zone 'Europe/Madrid')::date<=from_day
  order by repeat_series_id,goal_starts_at desc,created_at desc,id
 )latest where recurrence<>'none' and status<>'skipped' and extract(isodow from to_day)::smallint=any(recurrence_days) order by goal_starts_at loop
  s:=(to_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.goal_ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
  if s>=now() and not exists(select 1 from public.ritmo_tasks where user_id=uid and status<>'deleted' and (((goal_starts_at at time zone 'Europe/Madrid')::date=to_day and (repeat_series_id=t.repeat_series_id or carry_series_id=t.repeat_series_id))or(status in ('pending','active')and starts_at<e and greatest(ends_at,case when status='active' then now() else ends_at end)>s)))then
   insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,source_task_id,repeat_series_id,routine_id,fixed_time,goal_fixed_time)values(uid,t.title,s,e,t.category,t.priority,t.notes,t.recurrence,t.recurrence_days,t.id,t.repeat_series_id,t.routine_id,t.goal_fixed_time,t.goal_fixed_time);n:=n+1;
  end if;
 end loop;return n;
end;$$;

notify pgrst,'reload schema';
commit;
