import {test} from 'node:test';import assert from 'node:assert/strict';
import {formatDuration,parsePlan,summaryText,unplacedTasks} from '../domain.js';
import {planInstructions,routineCandidates,agendaContext,chatSummary,allForChat} from '../planning.js';
const habit='00000000-0000-0000-0000-000000000001',series='00000000-0000-0000-0000-000000000002',id='00000000-0000-0000-0000-000000000003';
const task=(day,extra={})=>({id,routine_id:habit,repeat_series_id:series,title:'Salir sin redes',category:'personal',priority:'alta',status:'pending',starts_at:day+'T09:00:00+02:00',ends_at:day+'T09:20:00+02:00',goal_starts_at:day+'T07:00:00+02:00',goal_ends_at:day+'T07:10:00+02:00',recurrence:'weekly',recurrence_days:[1,2,3,4,5],notes:'Zapatos preparados',...extra});
const context=text=>JSON.parse(text.slice(text.indexOf('{')));
test('durations show exact hours and remaining minutes at the hour boundary',()=>{
 for(const [n,label]of [[0,'0 min'],[59,'59 min'],[60,'1 h'],[61,'1 h 1 min'],[120,'2 h'],[234,'3 h 54 min'],[720,'12 h']])assert.equal(formatDuration(n),label);
 assert.equal(formatDuration(null),'—');
});
test('instructions provide a parsable example and distinguish source history from target date',()=>{
 const text=planInstructions('2026-10-02'),example=text.match(/```json\n([\s\S]+)\n```/)[1];
 assert.equal(parsePlan(example,'2026-10-02').length,2);assert.match(text,/Día del plan: 2026-10-02/);assert.match(text,/existing_task_id/);assert.match(text,/no está conectada/);
 assert.doesNotMatch(summaryText([task('2026-09-30')],'2026-09-30'),/Prepara mi plan/);
});
test('routine export uses goal times, follows weekdays and survives days off',()=>{
 const t=task('2026-10-02'),before=JSON.stringify(t);
 assert.equal(routineCandidates([t],'2026-10-04','2026-10-05').length,1);
 assert.equal(routineCandidates([t],'2026-10-02','2026-10-03').length,0);
 const out=context(agendaContext([t],'2026-10-04','2026-10-05'));
 assert.equal(out.rutina_por_programar[0].start,'07:00');assert.equal(out.rutina_por_programar[0].end,'07:10');assert.equal(out.rutina_por_programar[0].routine_id,habit);assert.equal(out.rutina_por_programar[0].repeat_series_id,series);assert.equal(JSON.stringify(t),before);
});
test('latest occurrence turns a routine off; future and deleted changes do not rewrite past context',()=>{
 const rows=[task('2026-09-30'),task('2026-10-01',{id:'b',recurrence:'none',recurrence_days:[]}),task('2026-10-02',{id:'c',status:'deleted'}),task('2026-10-06',{id:'d',recurrence:'daily',recurrence_days:[1,2,3,4,5,6,7]})];
 assert.equal(routineCandidates(rows,'2026-10-05','2026-10-06').length,0);
 assert.equal(routineCandidates(rows,'2026-09-30','2026-10-01').length,1);
});
test('already scheduled target blocks retain identities and are not duplicated as routine templates',()=>{
 const original=task('2026-09-30'),scheduled=task('2026-10-02',{id:'00000000-0000-0000-0000-000000000004'});
 const out=context(agendaContext([original,scheduled],'2026-09-30','2026-10-02'));
 assert.equal(out.rutina_por_programar.length,0);assert.equal(out.agenda_guardada[0].existing_task_id,scheduled.id);
 const parsed=parsePlan(JSON.stringify({tasks:out.agenda_guardada}),'2026-10-02')[0];
 assert.equal(parsed.existing_task_id,scheduled.id);assert.equal(parsed.routine_id,habit);assert.equal(parsed.repeat_series_id,series);
 assert.throws(()=>parsePlan(JSON.stringify({tasks:[{...out.agenda_guardada[0],routine_id:'inventado'}]}),'2026-10-02'),/referencia/);
});
test('summary keeps renamed repetitions together, real times and only history available on the source day',()=>{
 const rows=[task('2026-09-29',{status:'completed',actual_start:'2026-09-29T07:00:00+02:00',actual_end:'2026-09-29T07:30:00+02:00'}),task('2026-09-30',{title:'Preparar salida',status:'completed',actual_start:'2026-09-30T07:00:00+02:00',actual_end:'2026-09-30T07:15:00+02:00'}),task('2026-10-01',{title:'Futuro que no debe entrar',status:'completed',actual_start:'2026-10-01T07:00:00+02:00',actual_end:'2026-10-01T07:05:00+02:00'})];
 const text=chatSummary(rows,'2026-09-30');assert.match(text,/"complete_records": 2/);assert.match(text,/"recent_median_minutes": 23/);assert.match(text,/"actual_minutes": 15/);assert.match(text,/"suggested_minutes": null/);assert.doesNotMatch(text,/Futuro que no debe entrar/);assert.match(text,new RegExp(habit));
 const all=allForChat(rows,'2026-09-30','2026-10-02');assert.match(all,/BALANCE DEL DÍA 2026-09-30/);assert.match(all,/RUTINA Y AGENDA PARA 2026-10-02/);assert.match(all,/MIS NUEVAS TAREAS/);
});
test('pending work carries its source reference while parents with a scheduled continuation are excluded',()=>{
 const parent=task('2026-09-30',{status:'continued'}),child=task('2026-10-01',{id:'00000000-0000-0000-0000-000000000004',source_task_id:id,recurrence:'none',recurrence_days:[]});
 const text=chatSummary([parent],'2026-09-30');assert.match(text,/"source_task_id"/);assert.match(text,/"partial_continuation": true/);
 assert.match(chatSummary([parent,child],'2026-09-30'),/No hay pendientes sin continuación programada/);
 const row={start:'07:00',end:'07:15',title:'Continuar',source_task_id:id,routine_id:habit};assert.equal(parsePlan(JSON.stringify([row]),'2026-10-01')[0].source_task_id,id);
});
test('unplaced filter keeps deferred and unscheduled partial tasks, excluding other days and linked parents',()=>{
 const rows=[task('2026-09-30',{id:'deferred',status:'deferred'}),task('2026-09-30',{id:'partial',status:'continued'}),task('2026-09-30',{id:'linked',status:'continued'}),task('2026-10-01',{id:'child',source_task_id:'linked'}),task('2026-09-30',{id:'done',status:'completed'}),task('2026-09-30',{id:'deleted',status:'deleted'}),task('2026-10-01',{id:'future',status:'deferred'}),task('2026-09-30',{id:'pending'})];
 assert.deepEqual(unplacedTasks(rows,'2026-09-30').map(t=>t.id),['deferred','partial']);
 assert.deepEqual(unplacedTasks(rows).map(t=>t.id),['deferred','partial','future']);
});
test('summary highlights unplaced work with source references once, without recovering rescheduled or deleted tasks',()=>{
 const deferred=task('2026-09-30',{status:'deferred',title:'Automatización sin hueco'}),partial=task('2026-09-29',{id:'partial',status:'continued',title:'Prueba a medias'});
 const rows=[deferred,partial,task('2026-09-30',{id:'removed',status:'deleted',title:'Eliminada no recuperar'}),task('2026-10-01',{id:'future',status:'deferred',title:'Futuro sin hueco'})];
 const text=chatSummary(rows,'2026-09-30'),section=text.split('Tareas que quedaron sin hueco')[1].split('Otros pendientes')[0];
 const data=JSON.parse(section.slice(section.indexOf('[')));
 assert.equal(data.length,2);assert.equal(data[0].source_task_id,id);assert.equal(data[0].scheduling_state,'sin_hueco');assert.equal(data[0].routine_id,habit);assert.equal(data[0].start,'07:00');assert.equal(data[1].source_day,'2026-09-29');assert.equal(data[1].partial_continuation,true);
 assert.equal((text.match(new RegExp('"source_task_id": "'+id+'"','g'))||[]).length,1);assert.doesNotMatch(text,/Eliminada no recuperar|Futuro sin hueco/);
 const rescheduled=task('2026-10-01',{id:'child',source_task_id:id});
 assert.doesNotMatch(chatSummary([{...deferred,status:'postponed'},rescheduled],'2026-09-30'),/"scheduling_state": "sin_hueco"/);
 assert.match(planInstructions('2026-10-01'),/recuperar, dejar pendientes o descartar/);
});
