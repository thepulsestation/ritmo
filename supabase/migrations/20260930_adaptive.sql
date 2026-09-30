-- Adaptive agenda. Original goals are never changed by an automatic adjustment.
begin;
alter table public.ritmo_tasks add column if not exists goal_starts_at timestamptz;
alter table public.ritmo_tasks add column if not exists goal_ends_at timestamptz;
alter table public.ritmo_tasks add column if not exists fixed_time boolean;
alter table public.ritmo_tasks add column if not exists reflow_until timestamptz;
update public.ritmo_tasks set goal_starts_at=starts_at where goal_starts_at is null;
update public.ritmo_tasks set goal_ends_at=ends_at where goal_ends_at is null;
update public.ritmo_tasks set fixed_time=category in ('work','meals') where fixed_time is null;
update public.ritmo_tasks set reflow_until=ends_at where status='active' and reflow_until is null;
alter table public.ritmo_tasks alter column goal_starts_at set not null;
alter table public.ritmo_tasks alter column goal_ends_at set not null;
alter table public.ritmo_tasks alter column fixed_time set not null;
alter table public.ritmo_tasks drop constraint if exists ritmo_tasks_status_check;
alter table public.ritmo_tasks add constraint ritmo_tasks_status_check check(status in ('pending','active','completed','continued','postponed','skipped','deferred'));
-- Fixed windows can have less than five minutes remaining after a late start.
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.ritmo_tasks'::regclass and contype='c' and pg_get_constraintdef(oid) like '%starts_at%' and pg_get_constraintdef(oid) like '%ends_at%' and pg_get_constraintdef(oid) like '%interval%' loop
   execute format('alter table public.ritmo_tasks drop constraint %I',c.conname);
 end loop;
end;$$;
alter table public.ritmo_tasks add constraint ritmo_adjusted_duration check(ends_at>starts_at and ends_at-starts_at<=interval '12 hours');

create or replace function public.ritmo_goal_defaults() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin new.goal_starts_at:=coalesce(new.goal_starts_at,new.starts_at);new.goal_ends_at:=coalesce(new.goal_ends_at,new.ends_at);new.fixed_time:=coalesce(new.fixed_time,new.category in ('work','meals'));return new;end;$$;
drop trigger if exists ritmo_goal_defaults on public.ritmo_tasks;
create trigger ritmo_goal_defaults before insert on public.ritmo_tasks for each row execute function public.ritmo_goal_defaults();

create or replace function public.ritmo_check_slot(uid uuid,s timestamptz,e timestamptz,exclude_id uuid default null) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if s is null or e is null or e-s<interval '5 minutes' or e-s>interval '12 hours' or(s at time zone 'Europe/Madrid')::date<>(e at time zone 'Europe/Madrid')::date then raise exception 'El bloque debe durar de 5 minutos a 12 horas y quedar dentro del mismo día.';end if;
 if exists(select 1 from public.ritmo_tasks where user_id=uid and(exclude_id is null or id<>exclude_id) and status in ('pending','active') and starts_at<e and ends_at>s)then raise exception 'Ese horario se solapa con otro bloque. Elige otro momento.';end if;
end;$$;
create or replace function public.ritmo_save_task(task_id uuid,item jsonb) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();s timestamptz:=(item->>'starts_at')::timestamptz;e timestamptz:=(item->>'ends_at')::timestamptz;result uuid;
begin
 if task_id is not null and not exists(select 1 from public.ritmo_tasks where id=task_id and user_id=uid and status='pending')then raise exception 'Solo puedes editar tareas pendientes. Cierra primero el bloque en curso.';end if;
 perform public.ritmo_check_slot(uid,s,e,task_id);
 if task_id is null then
  insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,fixed_time)values(uid,item->>'title',s,e,item->>'category',coalesce(item->>'priority','media'),coalesce(item->>'notes',''),coalesce(item->>'recurrence','none'),coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')))returning id into result;
 else
  update public.ritmo_tasks set title=item->>'title',goal_starts_at=case when starts_at<>s or ends_at<>e then s else goal_starts_at end,goal_ends_at=case when starts_at<>s or ends_at<>e then e else goal_ends_at end,starts_at=s,ends_at=e,category=item->>'category',priority=coalesce(item->>'priority','media'),notes=coalesce(item->>'notes',''),recurrence=coalesce(item->>'recurrence','none'),fixed_time=coalesce((item->>'fixed_time')::boolean,item->>'category' in ('work','meals')),updated_at=now()where id=task_id and user_id=uid returning id into result;
 end if;
 insert into public.ritmo_events(user_id,task_id,event)values(uid,result,case when task_id is null then 'created' else 'edited' end);return result;
end;$$;

-- The same calculation serves the preview, the transaction and the minute scheduler.
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
   s:=greatest(t.goal_starts_at,cursor_at);e:=t.goal_ends_at;
   if s>=e then next_status:='deferred';s:=t.starts_at;e:=t.ends_at;else cursor_at:=e;end if;
   delta:=interval '0';
  else
   s:=greatest(t.starts_at+delta,cursor_at);e:=s+(t.ends_at-t.starts_at);
   select min(goal_starts_at) into anchor from public.ritmo_tasks where user_id=uid and status='pending' and fixed_time and id is distinct from pivot and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day and starts_at>t.starts_at and goal_ends_at>cursor_at;
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
   if t.fixed_time then e:=t.goal_ends_at;else
    select min(goal_starts_at) into anchor from public.ritmo_tasks where user_id=uid and status='pending' and fixed_time and id<>tid and goal_starts_at>s and(goal_starts_at at time zone 'Europe/Madrid')::date=plan_day;
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
create or replace function public.ritmo_start_task(task_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$begin perform public.ritmo_adapt(jsonb_build_object('action','start','task_id',task_id,'apply',true));end;$$;
create or replace function public.ritmo_close_task(task_id uuid,outcome text,review_text text default '',score integer default null,new_start timestamptz default null,new_end timestamptz default null) returns void language plpgsql security definer set search_path=pg_catalog,public as $$begin perform public.ritmo_adapt(jsonb_build_object('action','close','task_id',task_id,'outcome',outcome,'review_text',review_text,'score',score,'new_start',new_start,'new_end',new_end,'apply',true));end;$$;

create or replace function public.ritmo_sync_overdue() returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare t public.ritmo_tasks;n integer:=0;clock_at timestamptz:=date_trunc('minute',now());
begin
 for t in select * from public.ritmo_tasks where status='active' and ends_at<clock_at order by user_id loop
  perform pg_advisory_xact_lock(hashtextextended('ritmo:'||t.user_id::text,0));
  select * into t from public.ritmo_tasks where id=t.id and status='active' for update;
  if found and clock_at>coalesce(t.reflow_until,t.ends_at)then
   perform public.ritmo_reflow(t.user_id,(t.goal_starts_at at time zone 'Europe/Madrid')::date,t.starts_at,t.id,clock_at-coalesce(t.reflow_until,t.ends_at),clock_at,true);
   update public.ritmo_tasks set reflow_until=clock_at where id=t.id;n:=n+1;
  end if;
 end loop;return n;
end;$$;

create or replace function public.ritmo_reschedule_task(task_id uuid,new_start timestamptz,new_end timestamptz) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;result uuid;
begin
 select * into t from public.ritmo_tasks where id=task_id and user_id=uid for update;if not found then raise exception 'Tarea no encontrada.';end if;
 if new_start is null or new_end is null or new_start<now()then raise exception 'Elige un horario futuro para el nuevo bloque.';end if;
 if exists(select 1 from public.ritmo_tasks where user_id=uid and source_task_id=task_id and status in ('pending','active','deferred'))then raise exception 'Ya hay una continuación pendiente de esta tarea. Revisa la agenda.';end if;
 if t.status='active' then perform public.ritmo_adapt(jsonb_build_object('action','close','task_id',task_id,'outcome','continued','review_text',t.review,'score',t.rating,'apply',true));end if;
 perform public.ritmo_check_slot(uid,new_start,new_end,task_id);
 insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time)values(uid,t.title,new_start,new_end,t.category,t.priority,left(concat_ws(E'\n',nullif(t.notes,''),nullif(t.review,'')),4000),t.recurrence,t.id,t.fixed_time)returning id into result;
 if t.status in ('pending','active','deferred','continued')then update public.ritmo_tasks set status='postponed',actual_end=case when actual_start is not null then coalesce(actual_end,now()) else null end,updated_at=now()where id=task_id;end if;
 insert into public.ritmo_events(user_id,task_id,event,details)values(uid,task_id,'rescheduled',jsonb_build_object('new_task_id',result,'starts_at',new_start));return result;
end;$$;

create or replace function public.ritmo_copy_routine(from_day date,to_day date) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare uid uuid:=public.ritmo_require_owner();t public.ritmo_tasks;s timestamptz;e timestamptz;n integer:=0;
begin
 if to_day<=from_day then raise exception 'Elige un día posterior.';end if;
 for t in select * from public.ritmo_tasks where user_id=uid and recurrence='daily' and status<>'skipped' and(goal_starts_at at time zone 'Europe/Madrid')::date=from_day order by goal_starts_at loop
  s:=(to_day+(t.goal_starts_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';e:=(to_day+(t.goal_ends_at at time zone 'Europe/Madrid')::time)at time zone 'Europe/Madrid';
  if not exists(select 1 from public.ritmo_tasks where user_id=uid and(((goal_starts_at at time zone 'Europe/Madrid')::date=to_day and source_task_id=t.id) or(status in ('pending','active') and starts_at<e and ends_at>s)))then
   insert into public.ritmo_tasks(user_id,title,starts_at,ends_at,category,priority,notes,recurrence,source_task_id,fixed_time)values(uid,t.title,s,e,t.category,t.priority,t.notes,'daily',t.id,t.fixed_time);n:=n+1;
  end if;
 end loop;return n;
end;$$;

revoke all on function public.ritmo_goal_defaults(),public.ritmo_reflow(uuid,date,timestamptz,uuid,interval,timestamptz,boolean),public.ritmo_sync_overdue() from public,anon,authenticated;
grant execute on function public.ritmo_sync_overdue() to service_role;
revoke all on function public.ritmo_adapt(jsonb) from public,anon;
grant execute on function public.ritmo_adapt(jsonb) to authenticated;
commit;
