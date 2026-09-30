begin;
alter table public.ritmo_tasks add column if not exists routine_id uuid;
update public.ritmo_tasks set routine_id=md5(user_id::text||':'||category||':'||regexp_replace(lower(trim(title)),'\s+',' ','g'))::uuid where routine_id is null;
create or replace function public.ritmo_routine_identity() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 new.routine_id:=coalesce(new.routine_id,(select routine_id from public.ritmo_tasks where id=new.source_task_id and user_id=new.user_id),(select routine_id from public.ritmo_tasks where user_id=new.user_id and category=new.category and lower(trim(title))=lower(trim(new.title)) order by created_at limit 1),gen_random_uuid());
 return new;
end;$$;
drop trigger if exists ritmo_routine_identity on public.ritmo_tasks;
create trigger ritmo_routine_identity before insert on public.ritmo_tasks for each row execute function public.ritmo_routine_identity();
alter table public.ritmo_tasks alter column routine_id set not null;

-- Manual visual planning is atomic. Draft overlaps are allowed in the UI only.
create or replace function public.ritmo_calendar(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();plan_day date:=(request->>'plan_day')::date;items jsonb:=request->'items';item jsonb;other jsonb;prepared jsonb:='[]';changes jsonb:='[]';t public.ritmo_tasks;locked public.ritmo_tasks;s timestamptz;e timestamptz;budget integer;placed boolean;is_changed boolean;apply_changes boolean:=coalesce((request->>'apply')::boolean,false);n integer:=0;child_id uuid;
begin
 if plan_day is null or plan_day<(now()at time zone 'Europe/Madrid')::date or jsonb_typeof(items) is distinct from 'array' then raise exception 'Elige hoy o un día futuro con tareas por organizar.';end if;
 if jsonb_array_length(items)not between 1 and 100 then raise exception 'Elige entre 1 y 100 tareas por organizar.';end if;
 if exists(select 1 from jsonb_array_elements(items)x group by x->>'id' having count(*)>1)then raise exception 'Hay un bloque duplicado.';end if;
 for item in select value from jsonb_array_elements(items)loop
  select * into t from public.ritmo_tasks x where id=(item->>'id')::uuid and user_id=uid and(status in ('pending','deferred')or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid and child.status<>'deleted'))and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day for update;
  if not found then raise exception 'Un bloque cambió. Cancela la propuesta y actualiza la agenda.';end if;
  if(item->>'version')::timestamptz is distinct from t.updated_at then raise exception 'La agenda cambió mientras la organizabas. Cancela la propuesta y vuelve a abrirla.';end if;
  budget:=(item->>'minutes')::integer;placed:=coalesce((item->>'placed')::boolean,false);
  if budget is null or budget not between 1 and 720 then raise exception 'Cada bloque debe durar entre 5 y 720 minutos.';end if;
  s:=case when placed then(item->>'starts_at')::timestamptz else t.starts_at end;e:=s+make_interval(mins=>budget);
  is_changed:=t.status<>'pending' or not placed or s<>t.starts_at or e<>t.ends_at;
  if budget<5 and is_changed then raise exception 'Los bloques nuevos o ajustados deben durar al menos 5 minutos.';end if;
  if placed then
   if s is null or(s at time zone 'Europe/Madrid')::date<>plan_day or(e at time zone 'Europe/Madrid')::date<>plan_day then raise exception 'Cada bloque debe empezar y terminar dentro del día elegido.';end if;
   if is_changed and s<now()then raise exception 'Ese horario ya pasó. Coloca el bloque a partir de ahora o en otro día.';end if;
   for other in select value from jsonb_array_elements(prepared)where value->>'status'='pending' loop
    if(other->>'starts_at')::timestamptz<e and(other->>'ends_at')::timestamptz>s then raise exception '«%» se solapa con «%». Mueve o acorta uno de los bloques.',t.title,other->>'title';end if;
   end loop;
   for locked in select * from public.ritmo_tasks where user_id=uid and status='active' loop
    if locked.starts_at<e and greatest(locked.ends_at,now())>s then raise exception '«%» ocupa el bloque que sigue en curso.',t.title;end if;
   end loop;
  end if;
  prepared:=prepared||jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'minutes',budget,'status',case when placed then 'pending'else 'deferred'end,'fixed_time',coalesce((item->>'fixed_time')::boolean,t.fixed_time),'continuation',t.status='continued','changed',is_changed));n:=n+1;
 end loop;
 if n<>(select count(*)from public.ritmo_tasks x where user_id=uid and(status in ('pending','deferred')or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid and child.status<>'deleted'))and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day)then raise exception 'Hay nuevos bloques. Cancela la propuesta y vuelve a abrirla.';end if;
 for item in select value from jsonb_array_elements(prepared)loop
  if apply_changes then
   select * into t from public.ritmo_tasks where id=(item->>'id')::uuid and user_id=uid;
   if t.status='continued'then
    if item->>'status'='pending'then
     insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time)values(uid,t.title,(item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,t.category,t.priority,t.notes,'none',t.id,(item->>'fixed_time')::boolean)returning id into child_id;
     insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'continuation_scheduled',jsonb_build_object('new_task_id',child_id));
    end if;
   else
    update public.ritmo_tasks set starts_at=case when item->>'status'='pending'then(item->>'starts_at')::timestamptz else starts_at end,ends_at=case when item->>'status'='pending'then(item->>'ends_at')::timestamptz else ends_at end,status=item->>'status',fixed_time=(item->>'fixed_time')::boolean,fixed_starts_at=case when item->>'status'='pending'then(item->>'starts_at')::timestamptz else fixed_starts_at end,fixed_ends_at=case when item->>'status'='pending'then(item->>'ends_at')::timestamptz else fixed_ends_at end,updated_at=now()where id=t.id;
   end if;
   insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'calendar_adjusted',item);
  end if;
  changes:=changes||jsonb_build_array(item);
 end loop;
 return jsonb_build_object('changes',changes,'applied',apply_changes,'fixed_windows','Solo se mueven los bloques de tu propuesta. Los huecos libres se conservan.');
end;$$;

-- A repeat is a separate block, preserving the previous occurrence and its timing.
create or replace function public.ritmo_repeat_task(task_id uuid,new_start timestamptz,new_end timestamptz,repeat_daily boolean default false)returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;result uuid;
begin
 select * into t from public.ritmo_tasks where id=task_id and user_id=uid and status<>'deleted';if not found then raise exception 'Tarea no encontrada.';end if;
 if new_start<now()then raise exception 'Elige una hora futura para la repetición.';end if;
 perform public.ritmo_check_slot(uid,new_start,new_end);
 insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,routine_id,fixed_time,goal_fixed_time)values(uid,t.title,new_start,new_end,t.category,t.priority,t.notes,case when repeat_daily then 'daily'else 'none'end,t.id,t.routine_id,t.goal_fixed_time,t.goal_fixed_time)returning id into result;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'repeated',jsonb_build_object('new_task_id',result,'starts_at',new_start,'ends_at',new_end));return result;
end;$$;
revoke all on function public.ritmo_calendar(jsonb),public.ritmo_repeat_task(uuid,timestamptz,timestamptz,boolean)from public,anon;
grant execute on function public.ritmo_calendar(jsonb),public.ritmo_repeat_task(uuid,timestamptz,timestamptz,boolean)to authenticated;
create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;
begin
 if task_id is not null and not exists(select 1 from public.ritmo_tasks where id=task_id and user_id=uid and status in ('pending','deferred'))then raise exception 'Solo puedes editar tareas pendientes o por recolocar. Cierra primero el bloque en curso.';end if;
 perform public.ritmo_check_slot(uid,s,e,task_id);
 if task_id is null then
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,fixed_time)values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),coalesce(item->>'recurrence','none'),coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')))returning id into result;
 else
  update public.ritmo_tasks set title=item->>'title',status='pending',goal_starts_at=case when starts_at<>s or ends_at<>e then s else goal_starts_at end,goal_ends_at=case when starts_at<>s or ends_at<>e then e else goal_ends_at end,starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=coalesce(item->>'recurrence','none'),fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),goal_fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),fixed_starts_at=s,fixed_ends_at=e,updated_at=now()where id=task_id and user_id=uid returning id into result;
 end if;
 insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;
commit;
