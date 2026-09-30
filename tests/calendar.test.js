import {test} from 'node:test';import assert from 'node:assert/strict';
import {calendarLanes,calendarConflicts,calendarDraft,calendarBlocks,snapGesture,bindCalendarGestures}from '../calendar.js';
import {rhythmInsights}from '../insights.js';
const block=(id,start,end)=>({id,start,end,status:'pending'});
test('chained overlaps share lanes while touching endpoints keep one lane',()=>{
 const out=calendarLanes([block('a',60,180),block('b',120,240),block('c',210,270),block('d',270,300)]);
 assert.deepEqual(out.map(b=>[b.id,b.lane,b.lanes]),[['a',0,2],['b',1,2],['c',0,2],['d',0,1]]);
 assert.equal(calendarConflicts(out).length,2);
});
test('reviewed real intervals can overlap visually without invalidating the future draft',()=>{assert.equal(calendarConflicts([{...block('a',60,100),status:'completed'},block('b',80,120)]).length,0);});
test('moving and resizing snaps to 5 minutes and stays within day and duration limits',()=>{
 assert.deepEqual(snapGesture({mode:'move',start:600,minutes:30,delta:13}),{start:615,minutes:30});
 assert.deepEqual(snapGesture({mode:'resize-start',start:600,minutes:30,delta:100}),{start:625,minutes:5});
 assert.deepEqual(snapGesture({mode:'resize-end',start:600,minutes:30,delta:-100}),{start:600,minutes:5});
 const late=snapGesture({mode:'place',start:0,minutes:60,delta:0,target:1438});assert.equal(late.start+late.minutes,1439);
 assert.equal(snapGesture({mode:'resize-start',start:800,minutes:30,delta:-800}).minutes,720);
});
test('an active overrun occupies its elapsed time and cannot be covered by a draft',()=>{
 const a={id:'a',title:'En curso',status:'active',starts_at:'2099-09-30T09:00:00+02:00',ends_at:'2099-09-30T10:00:00+02:00'};
 const blocks=calendarBlocks([a],'2099-09-30',null,new Date('2099-09-30T10:30:00+02:00'));
 assert.equal(blocks[0].end,630);assert.equal(calendarConflicts([...blocks,block('b',615,645)]).length,1);
});
test('draft recovery preserves original goals and reviewed blocks are read-only',()=>{
 const a={id:'a',title:'Correo',category:'work',status:'deferred',starts_at:'2099-09-30T12:44:00+02:00',ends_at:'2099-09-30T12:45:00+02:00',goal_starts_at:'2099-09-30T12:30:00+02:00',goal_ends_at:'2099-09-30T12:45:00+02:00',updated_at:'2099-01-01T00:00:00Z'};
 const d=calendarDraft([a],'2099-09-30');assert.equal(d.items[0].minutes,15);assert.equal(d.items[0].placed,false);assert.equal(calendarBlocks([a],'2099-09-30',d).length,0);Object.assign(d.items[0],{placed:true,start:900});assert.equal(calendarBlocks([a],'2099-09-30',d)[0].start,900);assert.equal(a.starts_at,'2099-09-30T12:44:00+02:00');
});
const occurrence=(n,minutes,extra={})=>({id:'t'+n,routine_id:'same',title:'Levantarse',status:'completed',category:'personal',goal_starts_at:'2026-09-30T07:00:00+02:00',goal_ends_at:'2026-09-30T07:10:00+02:00',actual_start:new Date(Date.UTC(2026,8,n,5)).toISOString(),actual_end:new Date(Date.UTC(2026,8,n,5,minutes)).toISOString(),...extra});
test('stable routine groups renamed repeats; recommendation resists an outlier and detects improvement',()=>{
 const h=rhythmInsights([occurrence(1,30),occurrence(2,30),occurrence(3,120),occurrence(4,15),occurrence(5,15),occurrence(6,15,{title:'Salir sin móvil'})])[0];
 assert.equal(h.count,6);assert.equal(h.typical,23);assert.equal(h.suggestion,25);assert.equal(h.improvement,15);assert.equal(h.title,'Salir sin móvil');
});
test('partial continuations and untracked completions cannot create a full-task duration recommendation',()=>{
 const h=rhythmInsights([occurrence(1,30),occurrence(2,4,{status:'continued'}),occurrence(3,20,{actual_start:null})])[0];assert.equal(h.count,1);assert.equal(h.suggestion,null);assert.equal(h.improvement,null);
});
test('short taps keep the click target; releasing a drag uses the final pointer position before the next animation frame',()=>{
 const names=['document','window','requestAnimationFrame','cancelAnimationFrame'],saved=names.map(k=>[k,globalThis[k]]),listeners={};let captured=0,changes=0;
 const source={dataset:{id:'a',calDrag:'move'},classList:{add(){},remove(){}},setPointerCapture(){captured++;}};
 const item={id:'a',start:600,minutes:30,placed:true},draft={items:[item]},ghost={setAttribute(){},style:{}};
 const grid={getBoundingClientRect:()=>({top:0})},scroll={getBoundingClientRect:()=>({top:0,bottom:2200,left:0,right:400}),scrollTop:0};
 try{
  globalThis.document={addEventListener:(name,fn)=>listeners[name]=fn,getElementById:id=>({'calendar-grid':grid,'calendar-scroll':scroll,'calendar-ghost':ghost})[id]};
  globalThis.window={innerHeight:2400,scrollBy(){}};globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  bindCalendarGestures({getDraft:()=>draft,onChange:()=>changes++,onMessage:()=>{}});
  const e=(y,type='mouse')=>({pointerId:1,clientX:100,clientY:y,button:0,isPrimary:true,pointerType:type,target:{closest:()=>source},preventDefault(){}});
  listeners.pointerdown(e(960));listeners.pointerup(e(960));assert.equal(captured,0);assert.equal(changes,0);
  listeners.pointerdown(e(960));listeners.pointermove(e(970));listeners.pointerup(e(984));assert.equal(captured,1);assert.equal(changes,1);assert.equal(item.start,615);assert.equal(item.minutes,30);
 }finally{for(const [k,v]of saved)if(v===undefined)delete globalThis[k];else globalThis[k]=v;}
});
