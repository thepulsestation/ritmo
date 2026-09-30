begin;
-- Preserve owned habit/series identities when a plan travels through an external chat.
create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;
 days smallint[]:=public.ritmo_days_from_item(item);rule text:=case when cardinality(days)=7 then 'daily' when cardinality(days)>0 then 'weekly' else 'none' end;
 habit uuid:=nullif(item->>'routine_id','')::uuid;series uuid:=nullif(item->>'repeat_series_id','')::uuid;source_id uuid:=nullif(item->>'source_task_id','')::uuid;
 original public.ritmo_tasks;reference public.ritmo_tasks;
begin
 if habit is not null and not exists(select 1 from public.ritmo_tasks where user_id=uid and routine_id=habit)then raise exception 'La referencia de esta tarea no pertenece a tu historial.';end if;
 if series is not null then
  select * into reference from public.ritmo_tasks where user_id=uid and repeat_series_id=series order by created_at desc limit 1;
  if not found or(habit is not null and habit<>reference.routine_id)then raise exception 'La referencia de repetición no pertenece a esta tarea.';end if;
  habit:=reference.routine_id;
 end if;
 if source_id is not null then
  select * into reference from public.ritmo_tasks where user_id=uid and id=source_id and status<>'deleted';
  if not found or(habit is not null and habit<>reference.routine_id)then raise exception 'La tarea de origen no pertenece a tu historial.';end if;
  habit:=reference.routine_id;
 end if;
 if task_id is not null then
  select * into original from public.ritmo_tasks where id=task_id and user_id=uid and status in ('pending','deferred') for update;
  if not found then raise exception 'Solo puedes editar tareas pendientes o por recolocar. Cierra primero el bloque en curso.';end if;
  if(habit is not null and habit<>original.routine_id)or(series is not null and series<>original.repeat_series_id)or(source_id is not null and source_id is distinct from original.source_task_id)then raise exception 'Conserva las referencias originales de la tarea ya programada.';end if;
 end if;
 perform public.ritmo_check_slot(uid,s,e,task_id);
 if task_id is null then
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,recurrence_days,routine_id,repeat_series_id,source_task_id,fixed_time)
   values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),rule,days,habit,series,source_id,coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')))returning id into result;
 else
  update public.ritmo_tasks set title=item->>'title',status='pending',
   goal_starts_at=case when starts_at<>s or ends_at<>e then s else goal_starts_at end,goal_ends_at=case when starts_at<>s or ends_at<>e then e else goal_ends_at end,
   starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=rule,recurrence_days=days,
   fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),goal_fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),
   fixed_starts_at=s,fixed_ends_at=e,updated_at=now()where id=task_id and user_id=uid returning id into result;
 end if;
 insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;

create or replace function public.ritmo_import_plan(plan_day date,items jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=public.ritmo_require_owner();item jsonb;normalized jsonb:='[]'::jsonb;n integer:=0;existing_id uuid;series uuid;
 keep_ids uuid[]:=array[]::uuid[];seen_series uuid[]:=array[]::uuid[];original public.ritmo_tasks;
begin
 if plan_day is null or plan_day<(now()at time zone 'Europe/Madrid')::date then raise exception 'Elige hoy o un día futuro para preparar la agenda.';end if;
 if items is null or jsonb_typeof(items)<>'array' or jsonb_array_length(items)not between 1 and 80 then raise exception 'El plan debe tener entre 1 y 80 tareas.';end if;
 if exists(select 1 from public.ritmo_tasks where user_id=uid and(starts_at at time zone 'Europe/Madrid')::date=plan_day and status not in ('pending','deleted'))then raise exception 'Este día ya tiene bloques empezados o revisados. Edítalos desde la agenda.';end if;
 -- Resolve pending references before changing slots. Any failure rolls back the whole plan.
 for item in select value from jsonb_array_elements(items)loop
  if jsonb_typeof(item)<>'object' or item->>'starts_at' is null or((item->>'starts_at')::timestamptz at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Todos los bloques deben pertenecer al día del plan.';end if;
  existing_id:=nullif(item->>'existing_task_id','')::uuid;series:=nullif(item->>'repeat_series_id','')::uuid;
  if series is not null then
   if series=any(seen_series)then raise exception 'La misma rutina aparece dos veces en el plan.';end if;
   seen_series:=array_append(seen_series,series);
   if existing_id is null then
    select id into existing_id from public.ritmo_tasks where user_id=uid and repeat_series_id=series and(starts_at at time zone 'Europe/Madrid')::date=plan_day and status='pending' order by created_at limit 1;
   end if;
  end if;
  if existing_id is not null then
   select * into original from public.ritmo_tasks where id=existing_id and user_id=uid and status='pending' and(starts_at at time zone 'Europe/Madrid')::date=plan_day;
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
notify pgrst,'reload schema';
commit;
