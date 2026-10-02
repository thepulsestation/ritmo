import {dateKey,taskDay,timeLabel,goalDuration,actualDuration,summaryText,repeatDays,repeatLabel,recurrenceFor,unplacedTasks} from './domain.js?v=15';
import {rhythmInsights} from './insights.js?v=15';

const visible=t=>t.status!=='deleted';
const json=data=>JSON.stringify(data,null,2);
const identity=t=>({...(t.routine_id?{routine_id:t.routine_id}:{}),...(t.repeat_series_id?{repeat_series_id:t.repeat_series_id}:{})});
function planBlock(t,{goal=false,existing=false}={}){
  const days=repeatDays(t);
  return {...identity(t),...(existing&&['pending','deferred'].includes(t.status)?{existing_task_id:t.id}:{}),...(existing&&t.source_task_id?{source_task_id:t.source_task_id}:{}),
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
Revisa el apartado «Tareas que quedaron sin hueco». Pregúntame cuáles quiero recuperar, dejar pendientes o descartar; no presupongas que se completaron ni que debo hacerlas todas mañana. Propón prioridades y duraciones que quepan junto a mis horarios fijos. Al recuperar una de ellas, conserva su source_task_id y no la dupliques como rutina. Las tareas ya pasadas a otro día no necesitan otra continuación.
Para una repetición de una tarea conocida, copia exactamente routine_id y repeat_series_id desde mi contexto; así se conserva el historial aunque cambie el título o el objetivo. Para una tarea nueva omite esas referencias: no inventes identificadores. Si reutilizas un bloque pendiente YA programado en el día del plan, copia también su existing_task_id. Nunca copies como existing_task_id una tarea de otro día. Si programo otra repetición independiente en el mismo día, conserva routine_id y omite repeat_series_id para crear otro horario de rutina. Para retomar un pendiente anterior, conserva su source_task_id. Si es una continuación parcial, usa recurrence_days: [], conserva routine_id y omite repeat_series_id; su tiempo no debe confundirse con una repetición completa.
Devuelve el plan completo en un único bloque JSON con esta estructura: {"tasks":[...]}. start y end: HH:mm, dentro del día, fin posterior al inicio. Cada bloque dura entre 5 minutos y 12 horas. Categorías: personal, work, business, english, meals, rest. Prioridades: alta, media, baja. notes es texto. fixed_time es true o false. recurrence_days son números del 1 al 7 (lunes=1, domingo=7); [] es puntual, siete días es daily, otros días es weekly. No permitas solapamientos. No cambies bloques empezados o evaluados: si los hay, avísame para editar ese día desde la agenda.
Las tareas aplazadas conservan su tarea de origen y su número de aplazamientos. Si ya están en la agenda del día del plan, incluso sin hueco, conserva su existing_task_id para recolocarlas: no crees otra copia. Sus horas sugeridas no reservan un hueco. Confirma si quiero mantener, reducir o repartir su duración. Distingue las eliminadas, que no quiero retomar, de las aplazadas, que siguen pendientes; no recuperes automáticamente una eliminada.
Al guardar, los bloques pendientes con horario de ese día que no estén en el plan pasarán a la papelera; señala cualquier omisión deliberada. Las tareas sin hueco que omitas se conservan sin horario. No presupongas que ya he guardado el plan: Ritmo me mostrará una vista previa.
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
  const series=new Set(agenda.flatMap(t=>[t.repeat_series_id||t.id,...(t.carry_series_id?[t.carry_series_id]:[])]));
  return `RUTINA Y AGENDA PARA ${toDay}\nEstos datos son de Ritmo. Las citas externas las añadiré yo. La rutina es una plantilla; copiar este texto no crea tareas.\n${json({
    plan_day:toDay,timezone:'Europe/Madrid',source_day:fromDay,
    agenda_guardada:agenda.sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).map(t=>({...planBlock(t,{existing:true}),status:t.status,editable:['pending','deferred'].includes(t.status),...(t.status==='deferred'?{scheduling_state:'sin_hueco',times_are_suggestions:true}:{}),...(t.carry_series_id?{postponed_occurrence:true}: {})})),
    rutina_por_programar:routineCandidates(tasks,fromDay,toDay).filter(t=>!series.has(t.repeat_series_id||t.id)).map(t=>planBlock(t,{goal:true}))
  })}`;
}

export function taskDecisions(tasks,day){
  const byId=new Map(tasks.map(t=>[t.id,t]));
  const children=tasks.filter(visible).filter(t=>t.source_task_id);
  function count(t){let n=0,seen=new Set();while(t&&!seen.has(t.id)){seen.add(t.id);if(t.status==='postponed'||t.deleted_from_status==='postponed')n++;t=byId.get(t.source_task_id);}return n;}
  const selected=tasks.filter(t=>taskDay(t)===day);
  return {
    postponed:selected.filter(t=>t.status==='postponed').map(t=>{const child=children.filter(c=>c.source_task_id===t.id).sort((a,b)=>(b.created_at||b.starts_at).localeCompare(a.created_at||a.starts_at))[0];return {task_id:t.id,title:t.title,source_day:day,decision:'aplazada',intention:'retomarla',postponement_count:count(t),target_task_id:child?.id||null,target_day:child?taskDay(child):null,target_status:child?.status||null,needs_scheduling:child?.status==='deferred'};}),
    deleted:selected.filter(t=>t.status==='deleted').map(t=>({task_id:t.id,title:t.title,source_day:day,decision:'eliminada',intention:'no_retomarla',previous_status:t.deleted_from_status||null,deleted_at:t.deleted_at||null,recover_automatically:false}))
  };
}

export function chatSummary(tasks,day){
  const history=tasks.filter(visible).filter(t=>taskDay(t)<=day);
  const selected=history.filter(t=>taskDay(t)===day).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const linked=new Set(tasks.filter(visible).map(t=>t.source_task_id).filter(Boolean));
  const observations=selected.map(t=>({...identity(t),title:t.title,status:t.status,recurrence_days:repeatDays(t),repetition:repeatLabel(t)||'Puntual',goal_minutes:goalDuration(t),scheduled_minutes:Math.round((new Date(t.ends_at)-new Date(t.starts_at))/60000),actual_minutes:actualDuration(t),actual_complete:!!t.actual_end,review:t.review||'',rating:t.rating||null}));
  const habits=rhythmInsights(history).map(h=>({routine_id:h.key,title:h.title,complete_records:h.count,goal_minutes:h.goal,recent_median_minutes:h.typical,suggested_minutes:h.suggestion,first_minutes:h.first,latest_minutes:h.latest,improvement_minutes:h.improvement,advice:h.advice,last_records:h.samples.map(s=>({day:taskDay(s.task),goal_minutes:s.goal,actual_minutes:s.real}))}));
  const withoutTime=unplacedTasks(tasks).filter(t=>taskDay(t)<=day),unplacedIds=new Set(withoutTime.map(t=>t.id));
  const recover=history.filter(t=>['pending','active','continued','postponed','deferred'].includes(t.status)&&!linked.has(t.id)&&!unplacedIds.has(t.id));
  const recoveryBlock=t=>({...planBlock(t,{goal:true}),source_task_id:t.id,source_day:taskDay(t),status:t.status,actual_minutes:actualDuration(t),review:t.review||'',partial_continuation:t.status==='continued'});
  const decisions=taskDecisions(tasks,day);
  return `BALANCE DEL DÍA ${day}\n${summaryText(selected,day)}\n\nRepeticiones e historial (los campos *_minutes son valores numéricos para comparar objetivos):\n${json({source_day:day,records:observations,habits})}\n\nTareas que quedaron sin hueco (de este día y anteriores):\nSon tareas sin completar o con una parte pendiente, sin horario ni avisos. Puede haber faltado tiempo o haberlas dejado sin horario. Confirma conmigo cuáles quiero recuperar, aplazar, dejar pendientes o descartar. Sus horas son el objetivo original, no un horario reservado.\n${withoutTime.length?json(withoutTime.map(t=>({...recoveryBlock(t),scheduling_state:'sin_hueco'}))):'No quedan tareas sin hueco pendientes de decidir.'}\n\nOtros pendientes para decidir qué recuperar (de este día y anteriores; no son una rutina nueva):\n${recover.length?json(recover.map(recoveryBlock)):'No hay pendientes sin continuación programada.'}\n\nDecisiones: aplazadas y eliminadas\nAplazada significa que quiero retomarla; no está completada. Su bloque de destino puede seguir sin hueco: usa su existing_task_id en la agenda de destino. Eliminada significa que he decidido quitar este bloque; no lo recuperes automáticamente. Deshacer revierte la decisión y no cuenta como aplazamiento ni eliminación.\n${json(decisions)}`;
}

export function allForChat(tasks,fromDay,toDay){
  return [planInstructions(toDay),chatSummary(tasks,fromDay),agendaContext(tasks,fromDay,toDay),'MIS NUEVAS TAREAS Y COMPROMISOS\n[Añadiré aquí qué necesito hacer, citas, prioridades y cambios respecto a mi rutina.]'].join('\n\n---\n\n');
}
