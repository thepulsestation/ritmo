import {test}from 'node:test';import assert from 'node:assert/strict';
import {repeatDays,repeatLabel,recurrenceFor,parsePlan}from '../domain.js';
import {calendarHTML,calendarDraft,PIXELS_PER_MINUTE}from '../calendar.js';
test('weekday selection is canonical and legacy daily routines retain all seven days',()=>{
 assert.deepEqual(repeatDays({recurrence:'daily'}),[1,2,3,4,5,6,7]);
 assert.deepEqual(repeatDays({recurrence_days:[5,1,5,3]}),[1,3,5]);
 assert.equal(recurrenceFor([1,3,5]),'weekly');assert.equal(recurrenceFor([]),'none');
 assert.equal(repeatLabel({recurrence_days:[1,2,3,4,5]}),'Lunes a viernes');
 assert.equal(repeatLabel({recurrence:'daily'}),'Cada día');
});
test('a chat plan accepts specific weekdays and rejects malformed rules',()=>{
 const row={start:'08:00',end:'08:20',title:'Paseo',category:'personal',recurrence:'weekly',recurrence_days:[5,1,3]};
 const parsed=parsePlan(JSON.stringify([row]),'2099-09-30')[0];assert.equal(parsed.recurrence,'weekly');assert.deepEqual(parsed.recurrence_days,[1,3,5]);
 for(const days of [[0],[8],[null],[1.5],'lunes'])assert.throws(()=>parsePlan(JSON.stringify([{...row,recurrence_days:days}]),'2099-09-30'));
 assert.throws(()=>repeatDays({recurrence:'weekly'}));
});
test('short calendar blocks show their duration and editing keeps the chosen scale',()=>{
 const day='2099-09-30',task={id:'a',title:'Salir sin redes',category:'personal',status:'pending',starts_at:day+'T07:00:00+02:00',ends_at:day+'T07:10:00+02:00',updated_at:'2099-01-01T00:00:00Z'};
 const broad=calendarHTML([task],day),compact=calendarHTML([task],day,calendarDraft([task],day),2.4);
 assert.ok(PIXELS_PER_MINUTE>=6);assert.match(broad,/07:00–07:10 \(10 min\)/);assert.match(broad,/short-block/);assert.match(broad,/height:58px/);
 assert.match(compact,/--calendar-scale:2.4/);assert.match(compact,/data-cal-drag="resize-end"/);assert.match(compact,/07:00–07:10 \(10 min\)/);
});
