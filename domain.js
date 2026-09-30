export const CLOSED = ['completed', 'continued', 'postponed', 'skipped'];
export const CATEGORIES = { personal: 'Personal', work: 'Trabajo', business: 'Empresa', english: 'Inglés', meals: 'Comida', rest: 'Descanso' };
export const STATUS = { pending:'Pendiente', active:'En curso', completed:'Completada', continued:'Continuar después', postponed:'Pasada a otro día', skipped:'Descartada', deferred:'Pendiente de recolocar' };
export const WEEKDAYS=['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
export function repeatDays(t){
  if(t.recurrence_days!==undefined){if(!Array.isArray(t.recurrence_days)||t.recurrence_days.some(d=>!Number.isInteger(d)||d<1||d>7))throw new Error('Elige días de la semana válidos.');return [...new Set(t.recurrence_days)].sort((a,b)=>a-b);}
  if(t.recurrence==='weekly')throw new Error('Elige los días de la repetición semanal.');
  return t.recurrence==='daily'?[1,2,3,4,5,6,7]:[];
}
export const recurrenceFor=days=>days.length===7?'daily':days.length?'weekly':'none';
export function repeatLabel(t){const d=repeatDays(t);return d.length===7?'Cada día':d.length===5&&d.join(',')==='1,2,3,4,5'?'Lunes a viernes':d.map(n=>WEEKDAYS[n-1].slice(0,3).toLocaleLowerCase('es')).join(', ');}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const p = Object.fromEntries(parts.map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(key, days=1) { const d=new Date(key+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
export function madridTime(day, time) {
  const utc = new Date(`${day}T${time}:00Z`);
  // Inspect both sides of a DST transition; prefer the later occurrence of an ambiguous hour.
  const offsets=new Set([-12,0,12].map(hours=>{
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',timeZoneName:'shortOffset'}).formatToParts(new Date(utc.getTime()+hours*3600000));
    const m=parts.find(p=>p.type==='timeZoneName').value.match(/GMT([+-])(\d+)(?::(\d+))?/);
    return m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3]||0)):0;
  }));
  const candidates=[...offsets].map(minutes=>new Date(utc.getTime()-minutes*60000)).filter(d=>dateKey(d)===day&&timeLabel(d)===time).sort((a,b)=>b-a);
  if(!candidates.length)throw new Error('Esa hora no existe en Madrid por el cambio de hora. Elige otro horario.');
  return candidates[0].toISOString();
}
export function timeLabel(iso) { return new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(new Date(iso)); }
export function dayLabel(key) { return new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',weekday:'long',day:'numeric',month:'long'}).format(new Date(key+'T12:00:00Z')); }
export function duration(task) { return Math.round((new Date(task.ends_at)-new Date(task.starts_at))/60000); }
export function goalDuration(t) { return duration({starts_at:t.goal_starts_at||t.starts_at,ends_at:t.goal_ends_at||t.ends_at}); }
export function actualDuration(t,now=new Date()) { return t.actual_start?Math.max(0,Math.round((new Date(t.actual_end||now)-new Date(t.actual_start))/60000)):null; }
export function taskDay(t) { return dateKey(new Date(t.goal_starts_at||t.starts_at)); }
export function organizerItems(tasks,day,now=new Date()) {
  const linked=new Set(tasks.map(t=>t.source_task_id).filter(Boolean));
  const priority={alta:0,media:1,baja:2};
  return tasks.filter(t=>taskDay(t)===day&&(['pending','deferred'].includes(t.status)||t.status==='continued'&&!linked.has(t.id))).sort((a,b)=>(a.status==='pending')-(b.status==='pending')||(priority[a.priority]??1)-(priority[b.priority]??1)||(a.goal_starts_at||a.starts_at).localeCompare(b.goal_starts_at||b.starts_at)).map(t=>({id:t.id,title:t.title,priority:t.priority||'media',include:true,minutes:Math.max(5,t.status==='continued'?Math.min(30,goalDuration(t)):t.status==='deferred'?goalDuration(t):duration(t)),fixed_time:t.status==='continued'?false:(!!t.fixed_time||/cerrar.*d[ií]a|cierre.*d[ií]a/i.test(t.title))&&new Date(t.fixed_ends_at||t.goal_ends_at||t.ends_at)>now,starts_at:t.status==='deferred'?(t.goal_starts_at||t.starts_at):t.starts_at,recover:t.status!=='pending'}));
}
export function organizerNoCooking(items,tasks,now=new Date()) {
  const meal=items.find(i=>{const t=tasks.find(t=>t.id===i.id);return t?.category==='meals'&&/cocin|prepar.*com|comer/i.test(t.title);});
  if(!meal)return null;
  const soon=new Date(Math.ceil(new Date(now).getTime()/60000)*60000+120000);
  return {...meal,include:true,minutes:Math.min(30,meal.minutes),starts_at:dateKey(new Date(meal.starts_at))===dateKey(now)&&new Date(meal.starts_at)<soon?soon.toISOString():meal.starts_at};
}
export function habits(tasks) {
  const groups=new Map();
  for(const t of tasks){if(!t.actual_start||!t.actual_end||!['completed','continued'].includes(t.status))continue;const key=t.category+':'+t.title.trim().toLocaleLowerCase('es').replace(/\s+/g,' ');if(!groups.has(key))groups.set(key,{title:t.title,values:[],goals:[]});const g=groups.get(key);g.values.push(actualDuration(t));g.goals.push(goalDuration(t));}
  return [...groups.values()].map(g=>{const v=g.values.sort((a,b)=>a-b),n=v.length;return {title:g.title,count:n,typical:Math.round(n%2?v[(n-1)/2]:(v[n/2-1]+v[n/2])/2),goal:Math.round(g.goals.reduce((a,b)=>a+b,0)/n)};}).sort((a,b)=>b.count-a.count);
}
export function currentTask(tasks, now = new Date()) {
  return tasks.find(t=>t.status==='active') || tasks.find(t=>t.status==='pending'&&new Date(t.starts_at)<=now&&new Date(t.ends_at)>now) || tasks.find(t=>t.status==='pending'&&new Date(t.starts_at)>now) || tasks.find(t=>t.status==='pending') || null;
}
export function parsePlan(raw, day) {
  let text=raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  let items;
  if(text.startsWith('[')||text.startsWith('{')) {
    let json;try {json=JSON.parse(text);}catch {throw new Error('El JSON no es válido. Copia el bloque completo, incluidos los corchetes.');}
    items=Array.isArray(json)?json:json.tasks;
  } else {
    items=text.split('\n').filter(l=>l.trim()).map((line,i)=>{
      const m=line.match(/^\s*(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})\s*\|\s*([^|]+)(?:\|\s*([^|]+))?(?:\|\s*([^|]+))?(?:\|\s*(.*))?$/);
      if(!m)throw new Error(`La línea ${i+1} debe tener: 07:00-07:30 | Título | personal | alta | Nota`);
      return {start:m[1],end:m[2],title:m[3].trim(),category:(m[4]||'personal').trim(),priority:(m[5]||'media').trim(),notes:(m[6]||'').trim()};
    });
  }
  if(!Array.isArray(items)||!items.length||items.length>80)throw new Error('El plan debe tener entre 1 y 80 tareas.');
  const result=items.map((t,i)=>{
    for(const k of ['start','end']) if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t[k]))throw new Error(`Hora ${k} no válida en la tarea ${i+1}.`);
    if(!t.title?.trim()||t.title.length>200)throw new Error(`Revisa el título de la tarea ${i+1}.`);
    if(!CATEGORIES[t.category||'personal'])throw new Error(`Categoría no válida en la tarea ${i+1}.`);
    const priority=t.priority||'media'; if(!['alta','media','baja'].includes(priority))throw new Error(`Prioridad no válida en la tarea ${i+1}.`);
    if(t.end<=t.start)throw new Error(`La tarea ${i+1} debe terminar después de empezar, dentro del mismo día.`);
    const days=repeatDays(t);
    const item={title:t.title.trim(),starts_at:madridTime(day,t.start),ends_at:madridTime(day,t.end),category:t.category||'personal',priority,notes:String(t.notes||'').slice(0,4000),recurrence:recurrenceFor(days),recurrence_days:days,fixed_time:typeof t.fixed_time==='boolean'?t.fixed_time:['work','meals'].includes(t.category),status:'pending'};
    if(duration(item)<5||duration(item)>720)throw new Error(`La tarea ${i+1} debe durar entre 5 minutos y 12 horas.`);
    return item;
  }).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  result.forEach((t,i)=>{if(i&&t.starts_at<result[i-1].ends_at)throw new Error(`«${t.title}» se solapa con «${result[i-1].title}».`);});
  return result;
}
export function summaryText(tasks, day) {
  const lines=tasks.map(t=>`- ${t.title} [${STATUS[t.status]}] · ${CATEGORIES[t.category]} · prioridad ${t.priority}\n  Objetivo: ${timeLabel(t.goal_starts_at||t.starts_at)}–${timeLabel(t.goal_ends_at||t.ends_at)} (${goalDuration(t)} min). Agenda ajustada: ${timeLabel(t.starts_at)}–${timeLabel(t.ends_at)}.${t.actual_start?' Real: '+timeLabel(t.actual_start)+'–'+(t.actual_end?timeLabel(t.actual_end):'en curso')+' ('+actualDuration(t)+' min).':' Sin tiempo real registrado.'}${t.fixed_time?' Horario fijo.':''}${repeatLabel(t)?' · repetir: '+repeatLabel(t):''}${t.rating?' · valoración '+t.rating+'/5':''}${t.notes?'\n  Nota: '+t.notes:''}${t.review?'\n  Resultado: '+t.review:''}`);
  return `Mi resumen de ${dayLabel(day)} (${day}), zona Europe/Madrid:\n${lines.join('\n')}\n\nPrepara mi plan para ${addDays(day)}. Primero preguntaré/añadiré mis nuevas tareas aquí. Prioriza pendientes, continuaciones y tareas pasadas a otro día sin duplicarlas con las ya programadas. Mantén mi disponibilidad laboral de 08:30 a 17:30, comida de 13:30 a 14:30 y una hora de inglés. Los bloques de empresa en horario laboral son condicionales a no tener trabajo. No rellenes todo el día: deja pausas. Devuelve un bloque JSON {"tasks":[{"start":"07:00","end":"07:30","title":"...","category":"personal","priority":"alta","notes":"...","recurrence":"none"}]} sin solapamientos. Categorías válidas: personal, work, business, english, meals, rest. Prioridades: alta, media, baja. Para repetir en días concretos usa recurrence_days: [1,2,3,4,5] (lunes=1, domingo=7); una lista vacía indica una tarea puntual. recurrence: daily, weekly o none. La aplicación me mostrará una vista previa antes de guardar.`;
}
// Scheduler shared by browser-independent tests and the Supabase function.
export function dueNotifications(tasks, now) {
  const ts=new Date(now).getTime(), day=dateKey(new Date(now));
  const open=tasks.filter(t=>['pending','active'].includes(t.status)&&(taskDay(t)===day||t.status==='active'));
  const active=open.find(t=>t.status==='active');
  const due=[];
  for(const t of open) {
    const start=new Date(t.starts_at).getTime(), delta=ts-start;
    const slot=Math.floor(start/60000);
    if(t.status==='pending'&&(!active||t.fixed_time)&&delta>=-120000&&delta< -60000)due.push({task:t,kind:'before',slot});
    if(t.status==='pending'&&!active&&delta>=0&&delta<60000)due.push({task:t,kind:'start',slot});
  }
  const pending=open.filter(t=>t.status==='pending'&&new Date(t.starts_at)<=new Date(now)).sort((a,b)=>b.starts_at.localeCompare(a.starts_at))[0];
  const t=active||pending;
  if(t) {
    const base=new Date(t.status==='active'?t.ends_at:t.starts_at).getTime();
    const elapsed=ts-base, slot=Math.floor(elapsed/300000);
    if(t.status==='active'&&elapsed>=-120000&&elapsed< -60000)due.push({task:t,kind:'end-soon',slot:Math.floor(base/60000)});
    if(slot>=1&&elapsed%300000<60000)due.push({task:t,kind:'repeat',slot});
    if(t.status==='active'&&elapsed>=0&&elapsed<60000)due.push({task:t,kind:'end',slot:0});
  }
  return due;
}
