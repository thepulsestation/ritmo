begin;
alter table public.ritmo_tasks add column if not exists goal_fixed_time boolean;
update public.ritmo_tasks set goal_fixed_time=fixed_time where goal_fixed_time is null;
alter table public.ritmo_tasks alter column goal_fixed_time set not null;
alter table public.ritmo_tasks add column if not exists fixed_starts_at timestamptz;
alter table public.ritmo_tasks add column if not exists fixed_ends_at timestamptz;
update public.ritmo_tasks set fixed_starts_at=goal_starts_at where fixed_starts_at is null;
update public.ritmo_tasks set fixed_ends_at=goal_ends_at where fixed_ends_at is null;
alter table public.ritmo_tasks alter column fixed_starts_at set not null;
alter table public.ritmo_tasks alter column fixed_ends_at set not null;
create or replace function public.ritmo_goal_defaults() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin new.goal_starts_at:=coalesce(new.goal_starts_at,new.starts_at);new.goal_ends_at:=coalesce(new.goal_ends_at,new.ends_at);new.fixed_time:=coalesce(new.fixed_time,new.category in ('work','meals'));new.goal_fixed_time:=coalesce(new.goal_fixed_time,new.fixed_time);new.fixed_starts_at:=coalesce(new.fixed_starts_at,new.starts_at);new.fixed_ends_at:=coalesce(new.fixed_ends_at,new.ends_at);return new;end;$$;

-- Effective fixed windows retain today's manual changes; goals still seed tomorrow.
create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;
begin
 if task_id is not null and not exists(select 1 from public.ritmo_tasks where id=task_id and user_id=uid and status='pending')then raise exception 'Solo puedes editar tareas pendientes. Cierra primero el bloque en curso.';end if;
 perform public.ritmo_check_slot(uid,s,e,task_id);
 if task_id is null then
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,fixed_time)values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),coalesce(item->>'recurrence','none'),coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')))returning id into result;
 else
  update public.ritmo_tasks set title=item->>'title',goal_starts_at=case when starts_at<>s or ends_at<>e then s else goal_starts_at end,goal_ends_at=case when starts_at<>s or ends_at<>e then e else goal_ends_at end,starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=coalesce(item->>'recurrence','none'),fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),goal_fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),fixed_starts_at=s,fixed_ends_at=e,updated_at=now()where id=task_id and user_id=uid returning id into result;
 end if;
 insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;

create or replace function public.ritmo_reflow(uid uuid,plan_day date,cutoff timestamptz,pivot uuid,delta interval,cursor_at timestamptz,apply_changes boolean) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare t public.ritmo_tasks;s timestamptz;e timestamptz;anchor timestamptz;next_status text;changes jsonb:='[]';day_end timestamptz:=(plan_day+1)::timestamp at time zone 'Europe/Madrid';
begin
 for t in select * from public.ritmo_tasks where user_id=uid and status='pending' and id is distinct from pivot and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day and starts_at<cutoff order by starts_at,id loop
  changes:=changes||jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',t.starts_at,'ends_at',t.ends_at,'status','deferred','fixed_time',t.fixed_time));
  if apply_changes then update public.ritmo_tasks set status='deferred',updated_at=now()where id=t.id;insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'schedule_adjusted',jsonb_build_object('status','deferred','reason','earlier_unstarted'));end if;
 end loop;
 for t in select * from public.ritmo_tasks where user_id=uid and status='pending' and id is distinct from pivot and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day and starts_at>=cutoff order by starts_at,id loop
  next_status:='pending';
  if t.fixed_time then
   s:=greatest(t.fixed_starts_at,cursor_at);e:=t.fixed_ends_at;
   if s>=e then next_status:='deferred';s:=t.starts_at;e:=t.ends_at;else cursor_at:=e;end if;
   delta:=interval '0';
  else
   s:=greatest(t.starts_at+delta,cursor_at);e:=s+(t.ends_at-t.starts_at);
   select min(fixed_starts_at) into anchor from public.ritmo_tasks where user_id=uid and status='pending' and fixed_time and id is distinct from pivot and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day and starts_at>t.starts_at and fixed_ends_at>cursor_at;
   if e>=day_end or(anchor is not null and e>anchor)then next_status:='deferred';s:=t.starts_at;e:=t.ends_at;else cursor_at:=e;end if;
  end if;
  if s<>t.starts_at or e<>t.ends_at or next_status<>t.status then
   changes:=changes||jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'status',next_status,'fixed_time',t.fixed_time));
   if apply_changes then
    update public.ritmo_tasks set starts_at=s,ends_at=e,status=next_status,updated_at=now() where id=t.id;
    insert into public.ritmo_events(user_id,task_id,event,details)values(uid,t.id,'schedule_adjusted',jsonb_build_object('old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'status',next_status));
   end if;
  end if;
 end loop;return changes;
end;$$;

create or replace function public.ritmo_adapt(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();action text:=request->>'action';tid uuid:=(request->>'task_id')::uuid;t public.ritmo_tasks;plan_day date;clock_at timestamptz:=date_trunc('minute',now());s timestamptz;e timestamptz;anchor timestamptz;delta interval;changes jsonb:='[]';apply_changes boolean:=coalesce((request->>'apply')::boolean,false);outcome text:=coalesce(request->>'outcome','completed');mode text:=coalesce(request->>'finish_mode','keep');score integer:=(request->>'score')::integer;offset_mins integer:=coalesce((request->>'offset_minutes')::integer,0);
begin
 if action in ('start','close')then
  select * into t from public.ritmo_tasks where id=tid and user_id=uid for update;if not found then raise exception 'Tarea no encontrada.';end if;
  plan_day:=(t.goal_starts_at at time zone 'Europe/Madrid')::date;
  if action='start' then
   if t.status<>'pending' then raise exception 'Este bloque ya ha cambiado. Actualiza la agenda.';end if;
   if exists(select 1 from public.ritmo_tasks where user_id=uid and status='active')then raise exception 'Cierra primero el bloque que sigue en curso.';end if;
   if plan_day<>(now() at time zone 'Europe/Madrid')::date then raise exception 'Puedes empezar los bloques del día de hoy. Recoloca esta tarea si pertenece a otro día.';end if;
   s:=clock_at;e:=s+(t.ends_at-t.starts_at);
   if t.fixed_time then e:=t.fixed_ends_at;else
    select min(fixed_starts_at) into anchor from public.ritmo_tasks where user_id=uid and status='pending' and fixed_time and id<>tid and fixed_starts_at>s and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day;
    if anchor is not null then e:=least(e,anchor);end if;
   end if;
   e:=least(e,((plan_day+1)::timestamp at time zone 'Europe/Madrid')-interval '1 second');
   if e<=s then raise exception 'La ventana fija de esta tarea ya terminó. Elige otro momento para hacerla.';end if;
   changes:=jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'status','active','fixed_time',t.fixed_time));
   if apply_changes then
    update public.ritmo_tasks set status='active',starts_at=s,ends_at=e,reflow_until=e,actual_start=now(),updated_at=now()where id=tid;
    insert into public.ritmo_events(user_id,task_id,event,details)values(uid,tid,'started',jsonb_build_object('goal_start',t.goal_starts_at,'actual_start',now(),'deadline',e));
   end if;
   changes:=changes||public.ritmo_reflow(uid,plan_day,t.starts_at,tid,e-t.ends_at,e,apply_changes);
  else
   if t.status not in ('active','pending','deferred') then raise exception 'Este bloque ya se ha revisado. Actualiza tu agenda.';end if;
   if outcome not in ('completed','continued','postponed','skipped') or mode not in ('keep','advance') or(score is not null and score not between 1 and 5)then raise exception 'Revisa el resultado y la valoración.';end if;
   if t.status='active' then
    delta:=case when now()>=t.ends_at then clock_at-coalesce(t.reflow_until,t.ends_at) when mode='advance' then clock_at-t.ends_at else interval '0' end;
    changes:=public.ritmo_reflow(uid,plan_day,t.starts_at,tid,delta,clock_at,apply_changes);
   end if;
   if apply_changes then
    update public.ritmo_tasks set status=outcome,actual_end=case when actual_start is not null then now() else null end,review=coalesce(request->>'review_text',''),rating=score,updated_at=now()where id=tid;
    if outcome='postponed' then perform public.ritmo_reschedule_task(tid,(request->>'new_start')::timestamptz,(request->>'new_end')::timestamptz);end if;
    insert into public.ritmo_events(user_id,task_id,event,details)values(uid,tid,outcome,jsonb_build_object('review',request->>'review_text','rating',score,'finish_mode',mode));
   end if;
  end if;
 elsif action='shift' then
  plan_day:=(request->>'plan_day')::date;
  if plan_day is null or offset_mins not between 0 and 720 then raise exception 'Elige un retraso de 0 a 720 minutos.';end if;
  if exists(select 1 from public.ritmo_tasks where user_id=uid and status='active')then raise exception 'Cierra primero el bloque en curso; el resto se reajusta mientras lo haces.';end if;
  select * into t from public.ritmo_tasks where user_id=uid and status='pending' and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day order by starts_at,id limit 1;
  if not found then raise exception 'No hay tareas pendientes que reajustar este día.';end if;
  delta:=make_interval(mins=>offset_mins);
  if coalesce((request->>'from_now')::boolean,false)then
   if plan_day<>(now() at time zone 'Europe/Madrid')::date then raise exception 'Reajustar desde ahora solo se aplica a hoy.';end if;
   delta:=greatest(interval '0',clock_at-t.starts_at);
  end if;
  changes:=public.ritmo_reflow(uid,plan_day,t.starts_at,null,delta,t.starts_at+delta,apply_changes);
 else raise exception 'Ajuste no válido.';end if;
 return jsonb_build_object('changes',changes,'applied',apply_changes,'fixed_windows','Trabajo y comida conservan sus horas. Los bloques sin hueco quedan pendientes de recolocar.');
end;$$;

-- Pure first-fit packing: reserve fixed windows, then place each flexible block in order.
create or replace function public.ritmo_pack(items jsonb,window_start timestamptz,window_end timestamptz) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare item jsonb;slot jsonb;slots jsonb:='[]';result jsonb:='[]';s timestamptz;e timestamptz;candidate timestamptz;budget interval;
begin
 for item in select value from jsonb_array_elements(items)where(value->>'include')::boolean and(value->>'fixed_time')::boolean order by(value->>'starts_at')::timestamptz loop
  s:=greatest((item->>'starts_at')::timestamptz,window_start);e:=(item->>'starts_at')::timestamptz+make_interval(mins=>(item->>'minutes')::integer);
  if s>=e or e>window_end then result:=result||jsonb_build_array(item||jsonb_build_object('status','deferred','reason','outside_window'));else
   if exists(select 1 from jsonb_array_elements(slots)x where(x->>'starts_at')::timestamptz<e and(x->>'ends_at')::timestamptz>s)then raise exception 'Dos bloques con hora fija se solapan. Cambia su hora o quita la marca de hora fija.';end if;
   item:=item||jsonb_build_object('starts_at',s,'ends_at',e,'status','pending');slots:=slots||jsonb_build_array(item);result:=result||jsonb_build_array(item);
  end if;
 end loop;
 for item in select value from jsonb_array_elements(items)where not(value->>'include')::boolean loop result:=result||jsonb_build_array(item||jsonb_build_object('status','deferred','reason','not_today'));end loop;
 for item in select value from jsonb_array_elements(items)where(value->>'include')::boolean and not(value->>'fixed_time')::boolean loop
  budget:=make_interval(mins=>(item->>'minutes')::integer);candidate:=window_start;
  for slot in select value from jsonb_array_elements(slots)order by(value->>'starts_at')::timestamptz loop
   if candidate+budget<=(slot->>'starts_at')::timestamptz then exit;end if;
   if candidate<(slot->>'ends_at')::timestamptz then candidate:=(slot->>'ends_at')::timestamptz;end if;
  end loop;
  if candidate+budget>window_end then result:=result||jsonb_build_array(item||jsonb_build_object('status','deferred','reason','no_space'));else
   item:=item||jsonb_build_object('starts_at',candidate,'ends_at',candidate+budget,'status','pending');slots:=slots||jsonb_build_array(item);result:=result||jsonb_build_array(item);
  end if;
 end loop;
 return coalesce((select jsonb_agg(value order by case when value->>'status'='pending' then 0 else 1 end,(value->>'starts_at')::timestamptz)from jsonb_array_elements(result)),'[]'::jsonb);
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
  select * into t from public.ritmo_tasks x where id=(item->>'id')::uuid and user_id=uid and(status in ('pending','deferred') or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid)) and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day for update;
  if not found then raise exception 'La agenda ha cambiado. Vuelve a abrir Reorganizar mi día para usar su estado actual.';end if;
  budget:=(item->>'minutes')::integer;fixed:=coalesce((item->>'fixed_time')::boolean,false);include_today:=coalesce((item->>'include')::boolean,true);s:=coalesce((item->>'starts_at')::timestamptz,t.starts_at);e:=s+make_interval(mins=>budget);
  if budget is null or budget not between 5 and 720 or(s at time zone 'Europe/Madrid')::date<>plan_day or(fixed and(e at time zone 'Europe/Madrid')::date<>plan_day)then raise exception 'Revisa las horas: cada duración debe estar entre 5 y 720 minutos y quedar dentro del día.';end if;
  prepared:=prepared||jsonb_build_array(jsonb_build_object('id',t.id,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'fixed_starts_at',s,'fixed_ends_at',e,'minutes',budget,'fixed_time',fixed,'include',include_today,'was_deferred',t.status<>'pending','continuation',t.status='continued'));n:=n+1;
 end loop;
 if n<>(select count(*)from public.ritmo_tasks x where user_id=uid and(status in ('pending','deferred') or status='continued' and not exists(select 1 from public.ritmo_tasks child where child.source_task_id=x.id and child.user_id=uid)) and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day)then raise exception 'Hay nuevos bloques en tu agenda. Vuelve a abrir Reorganizar mi día para incluirlos.';end if;
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

-- A continuation always offers a concrete future slot, so normal push notices resume.
create or replace function public.ritmo_continue(request jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;other public.ritmo_tasks;tid uuid:=(request->>'task_id')::uuid;budget integer:=(request->>'minutes')::integer;plan_day date:=(request->>'plan_day')::date;automatic boolean:=coalesce((request->>'automatic')::boolean,true);apply_changes boolean:=coalesce((request->>'apply')::boolean,false);s timestamptz;e timestamptz;day_end timestamptz;changes jsonb:='[]';close_preview jsonb;item jsonb;slot jsonb;slots jsonb:='[]';result uuid;clock_at timestamptz:=date_trunc('minute',now())+interval '3 minutes';score integer:=(request->>'score')::integer;
begin
 select * into t from public.ritmo_tasks where id=tid and user_id=uid for update;if not found or t.status not in ('pending','active','deferred','continued')then raise exception 'Este bloque ya cambió. Revisa tu agenda.';end if;
 if plan_day is null or plan_day<(now() at time zone 'Europe/Madrid')::date or budget is null or budget not between 5 and 720 or(score is not null and score not between 1 and 5)then raise exception 'Elige un día futuro, una duración de 5 a 720 minutos y una valoración válida.';end if;
 if exists(select 1 from public.ritmo_tasks where source_task_id=tid and user_id=uid and status in ('pending','active','deferred'))then raise exception 'Esta tarea ya tiene una continuación pendiente. Puedes reorganizar ese bloque.';end if;
 if t.status<>'continued' then
  close_preview:=public.ritmo_adapt(jsonb_build_object('action','close','task_id',tid,'outcome','continued','review_text',coalesce(request->>'review_text',''),'score',score,'finish_mode',coalesce(request->>'finish_mode','keep'),'apply',false));changes:=close_preview->'changes';
 end if;
 for other in select * from public.ritmo_tasks where user_id=uid and id<>tid and status in ('pending','active') and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day loop
  select value into item from jsonb_array_elements(changes)where value->>'id'=other.id::text;
  if item is not null and item->>'status'='deferred' then continue;end if;
  slots:=slots||jsonb_build_array(jsonb_build_object('starts_at',coalesce((item->>'starts_at')::timestamptz,other.starts_at),'ends_at',coalesce((item->>'ends_at')::timestamptz,other.ends_at)));
 end loop;
 day_end:=(plan_day+1)::timestamp at time zone 'Europe/Madrid';
 if automatic then
  s:=case when plan_day=(now() at time zone 'Europe/Madrid')::date then clock_at else(plan_day+time '07:00')at time zone 'Europe/Madrid' end;
  for slot in select value from jsonb_array_elements(slots)order by(value->>'starts_at')::timestamptz loop
   if s+make_interval(mins=>budget)<=(slot->>'starts_at')::timestamptz then exit;end if;
   if s<(slot->>'ends_at')::timestamptz then s:=(slot->>'ends_at')::timestamptz;end if;
  end loop;
 else s:=(request->>'starts_at')::timestamptz;end if;
 e:=s+make_interval(mins=>budget);
 if s is null or s<now() or(s at time zone 'Europe/Madrid')::date<>plan_day or e>=day_end then raise exception 'No queda un hueco de esa duración. Elige otro día, una hora distinta o un bloque más corto.';end if;
 if exists(select 1 from jsonb_array_elements(slots)x where(x->>'starts_at')::timestamptz<e and(x->>'ends_at')::timestamptz>s)then raise exception 'Ese horario está ocupado. Usa Buscar hueco o elige otra hora.';end if;
 if apply_changes then
  if t.status<>'continued'then perform public.ritmo_adapt(jsonb_build_object('action','close','task_id',tid,'outcome','continued','review_text',coalesce(request->>'review_text',''),'score',score,'finish_mode',coalesce(request->>'finish_mode','keep'),'apply',true));end if;
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time,goal_fixed_time)values(uid,t.title,s,e,t.category,t.priority,left(concat_ws(E'\n',nullif(t.notes,''),nullif(request->>'review_text','')) ,4000),'none',tid,false,false)returning id into result;
  insert into public.ritmo_events(user_id,task_id,event,details)values(uid,tid,'continuation_scheduled',jsonb_build_object('new_task_id',result,'starts_at',s,'ends_at',e));
 end if;
 changes:=changes||jsonb_build_array(jsonb_build_object('id',result,'title',t.title,'old_start',t.starts_at,'old_end',t.ends_at,'starts_at',s,'ends_at',e,'status','pending','fixed_time',false,'continuation',true));
 return jsonb_build_object('changes',changes,'starts_at',s,'ends_at',e,'plan_day',plan_day,'applied',apply_changes,'fixed_windows','La continuación tendrá su propio horario y sus avisos.');
end;$$;

create or replace function public.ritmo_copy_routine(from_day date,to_day date) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;s timestamptz;e timestamptz;n integer:=0;
begin
 if to_day<=from_day then raise exception 'Elige un día posterior.';end if;
 for t in select * from public.ritmo_tasks where user_id=uid and recurrence='daily' and status<>'skipped' and(goal_starts_at at time zone 'Europe/Madrid')::date=from_day order by goal_starts_at loop
  s:=(to_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.goal_ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
  if not exists(select 1 from public.ritmo_tasks where user_id=uid and(((goal_starts_at at time zone 'Europe/Madrid')::date=to_day and source_task_id=t.id) or(status in ('pending','active') and starts_at<e and ends_at>s)))then
   insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time,goal_fixed_time)values(uid,t.title,s,e,t.category,t.priority,t.notes,'daily',t.id,t.goal_fixed_time,t.goal_fixed_time);n:=n+1;
  end if;
 end loop;return n;
end;$$;
revoke all on function public.ritmo_pack(jsonb,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.ritmo_reorganize(jsonb),public.ritmo_continue(jsonb) from public,anon;
grant execute on function public.ritmo_reorganize(jsonb),public.ritmo_continue(jsonb) to authenticated;
commit;
