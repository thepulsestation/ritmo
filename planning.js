import {dateKey,taskDay,timeLabel,goalDuration,actualDuration,summaryText,repeatDays,repeatLabel,recurrenceFor} from './domain.js?v=11';
import {rhythmInsights} from './insights.js?v=11';

const visible=t=>t.status!=='deleted';
const json=data=>JSON.stringify(data,null,2);
const identity=t=>({...(t.routine_id?{routine_id:t.routine_id}:{}),...(t.repeat_series_id?{repeat_series_id:t.repeat_series_id}:{})});
function planBlock(t,{goal=false,existing=false}={}){
  const days=repeatDays(t);
  return {...identity(t),...(existing&&t.status==='pending'?{existing_task_id:t.id}:{}),
    start:timeLabel(goal?t.goal_starts_at||t.starts_at:t.starts_at),end:timeLabel(goal?t.goal_ends_at||t.ends_at:t.ends_at),
    title:t.title,category:t.category,priority:t.priority||'media',notes:t.notes||'',
    recurrence:recurrenceFor(days),recurrence_days:days,fixed_time:!!(goal?t.goal_fixed_time??t.fixed_time:t.fixed_time)};
}

export function planInstructions(day){
  const example={tasks:[{start:'07:00',end:'07:20',title:'Levantarse y salir sin redes',category:'personal',priority:'alta',notes:'Preparar las zapatillas la noche anterior',recurrence:'weekly',recurrence_days:[1,2,3,4,5],fixed_time:false},{start:'08:30',end:'09:30',title:'Trabajo: revisar correos',category:'work',priority:'alta',notes:'Estar disponible durante el horario de trabajo',recurrence:'weekly',recurrence_days:[1,2,3,4,5],fixed_time:true}]};
  return `INSTRUCCIONES PARA PREPARAR MI AGENDA DE RITMO\nDía del plan: ${day}. Zona horaria: Europe/Madrid.\n
Voy a añadir mis compromisos y tareas nuevas. Antes de preparar el plan, usa mi balance, mis repeticiones y la agenda de ese día que te adjunto. Si falta información, pregúntame. La lectura de mi calendario de Google no está conectada; te contaré sus citas cuando las haya.
Mantén las horas fijas del trabajo y de la comida salvo que yo te pida cambiarlas. Estoy disponible para el trabajo de 08:30 a 17:30, con pausa de 13:30 a 14:30, en días laborables. Los bloques de empresa dentro de ese horario dependen de que no haya trabajo; indica esa condición en notes. Quiero reservar una hora para inglés cuando sea posible. Deja pausas y espacios libres; no es necesario llenar el día.
Propón tiempos realistas a partir de mi historial. La duración habitual usa hasta siete repeticiones completas recientes; con menos de tres registros no la trates como una tendencia. Conserva la diferencia entre lo que me propuse y lo que hice. Puedes sugerir otro objetivo para mañana, sin reescribir el de ayer.
Incluye una sola vez cada tarea ya programada y cada rutina que corresponda a los días elegidos. Prioriza también lo pendiente o que necesita continuación; confirma qué quiero retomar. Las plantillas de rutina todavía no son tareas guardadas en la fecha de destino.
Para una repetición de una tarea conocida, copia exactamente routine_id y repeat_series_id desde mi contexto; así se conserva el historial aunque cambie el título o el objetivo. Para una tarea nueva omite esas referencias: no inventes identificadores. Si reutilizas un bloque pendiente YA programado en el día del plan, copia también su existing_task_id. Nunca copies como existing_task_id una tarea de otro día. Si programo otra repetición independiente en el mismo día, conserva routine_id y omite repeat_series_id para crear otro horario de rutina. Para retomar un pendiente anterior, conserva su source_task_id. Si es una continuación parcial, usa recurrence_days: [], conserva routine_id y omite repeat_series_id; su tiempo no debe confundirse con una repetición completa.
Devuelve el plan completo en un único bloque JSON con esta estructura: {"tasks":[...]}. start y end: HH:mm, dentro del día, fin posterior al inicio. Cada bloque dura entre 5 minutos y 12 horas. Categorías: personal, work, business, english, meals, rest. Prioridades: alta, media, baja. notes es texto. fixed_time es true o false. recurrence_days son números del 1 al 7 (lunes=1, domingo=7); [] es puntual, siete días es daily, otros días es weekly. No permitas solapamientos. No cambies bloques empezados o evaluados: si los hay, avísame para editar ese día desde la agenda.
Al guardar, los bloques pendientes de ese día que no estén en el plan pasarán a la papelera; señala cualquier omisión deliberada. No presupongas que ya he guardado el plan: Ritmo me mostrará una vista previa.
Ejemplo de formato (ilustrativo, no representa mis tareas guardadas):\n\`\`\`json\n${json(example)}\n\`\`\``;
}

export function routineCandidates(tasks,fromDay,toDay){
  const latest=new Map();
  // Match the server: find the latest non-deleted occurrence before the source day.
  for(const t of tasks.filter(visible).filter(t=>taskDay(t)<=fromDay).sort((a,b)=>(b.goal_starts_at||b.starts_at).localeCompare(a.goal_starts_at||a.starts_at)||(b.created_at||'').localeCompare(a.created_at||'')||a.id.localeCompare(b.id))){
    const key=t.repeat_series_id||t.id;if(!latest.has(key))latest.set(key,t);
  }
  const weekday=new Date(toDay+'T12:00:00Z').getUTCDay()||7;
  return [...latest.values()].filter(t=>t.status!=='skipped'&&repeatDays(t).includes(weekday)).sort((a,b)=>timeLabel(a.goal_starts_at||a.starts_at).localeCompare(timeLabel(b.goal_starts_at||b.starts_at)));
}

export function agendaContext(tasks,fromDay,toDay){
  const agenda=tasks.filter(visible).filter(t=>dateKey(new Date(t.starts_at))===toDay);
  const series=new Set(agenda.map(t=>t.repeat_series_id||t.id));
  return `RUTINA Y AGENDA PARA ${toDay}\nEstos datos son de Ritmo. Las citas externas las añadiré yo. La rutina es una plantilla; copiar este texto no crea tareas.\n${json({
    plan_day:toDay,timezone:'Europe/Madrid',source_day:fromDay,
    agenda_guardada:agenda.sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).map(t=>({...planBlock(t,{existing:true}),status:t.status,editable:t.status==='pending'})),
    rutina_por_programar:routineCandidates(tasks,fromDay,toDay).filter(t=>!series.has(t.repeat_series_id||t.id)).map(t=>planBlock(t,{goal:true}))
  })}`;
}

export function chatSummary(tasks,day){
  const history=tasks.filter(visible).filter(t=>taskDay(t)<=day);
  const selected=history.filter(t=>taskDay(t)===day).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const linked=new Set(tasks.filter(visible).map(t=>t.source_task_id).filter(Boolean));
  const observations=selected.map(t=>({...identity(t),title:t.title,status:t.status,recurrence_days:repeatDays(t),repetition:repeatLabel(t)||'Puntual',goal_minutes:goalDuration(t),actual_minutes:actualDuration(t),actual_complete:!!t.actual_end,review:t.review||'',rating:t.rating||null}));
  const habits=rhythmInsights(history).map(h=>({routine_id:h.key,title:h.title,complete_records:h.count,goal_minutes:h.goal,recent_median_minutes:h.typical,suggested_minutes:h.suggestion,first_minutes:h.first,latest_minutes:h.latest,improvement_minutes:h.improvement,advice:h.advice,last_records:h.samples.map(s=>({day:taskDay(s.task),goal_minutes:s.goal,actual_minutes:s.real}))}));
  const recover=history.filter(t=>['pending','active','continued','postponed','deferred'].includes(t.status)&&!linked.has(t.id));
  return `BALANCE DEL DÍA ${day}\n${summaryText(selected,day)}\n\nRepeticiones e historial (los campos *_minutes son valores numéricos para comparar objetivos):\n${json({source_day:day,records:observations,habits})}\n\nPendientes para decidir qué recuperar (de este día y anteriores; no son una rutina nueva):\n${recover.length?json(recover.map(t=>({...planBlock(t,{goal:true}),source_task_id:t.id,source_day:taskDay(t),status:t.status,actual_minutes:actualDuration(t),review:t.review||'',partial_continuation:t.status==='continued'}))):'No hay pendientes sin continuación programada.'}`;
}

export function allForChat(tasks,fromDay,toDay){
  return [planInstructions(toDay),chatSummary(tasks,fromDay),agendaContext(tasks,fromDay,toDay),'MIS NUEVAS TAREAS Y COMPROMISOS\n[Añadiré aquí qué necesito hacer, citas, prioridades y cambios respecto a mi rutina.]'].join('\n\n---\n\n');
}
