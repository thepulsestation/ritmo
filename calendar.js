import {escapeHtml as esc,CATEGORIES,STATUS,dateKey,taskDay,timeLabel,goalDuration,duration,organizerItems} from './domain.js?v=10';
export const PIXELS_PER_MINUTE=6;
export const clockMinutes=iso=>{const [h,m]=timeLabel(iso).split(':').map(Number);return h*60+m;};
export const minuteClock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export function calendarDraft(tasks,day){
  return {day,items:organizerItems(tasks,day).map(i=>{const t=tasks.find(t=>t.id===i.id);return {...i,fixed_time:t.status==='pending'?!!t.fixed_time:i.fixed_time,placed:t.status==='pending',start:clockMinutes(t.starts_at),minutes:t.status==='pending'?duration(t):i.minutes,version:t.updated_at};})};
}
export function calendarBlocks(tasks,day,draft=null,now=new Date()){
  const items=new Map((draft?.items||[]).map(i=>[i.id,i]));
  return tasks.filter(t=>taskDay(t)===day&&t.status!=='deleted').flatMap(t=>{
    const item=items.get(t.id);if(item&&!item.placed)return [];
    if(!item&&['deferred','continued','postponed','skipped'].includes(t.status))return [];
    const real=!item&&t.actual_start&&t.actual_end;
    const start=item?item.start:clockMinutes(real?t.actual_start:t.starts_at);
    let end=item?start+item.minutes:clockMinutes(real?t.actual_end:t.ends_at);
    if(t.status==='active'&&dateKey(now)===day)end=Math.max(end,clockMinutes(now));
    return [{...t,status:item?'pending':t.status,start,end:Math.max(start+1,end),editable:!!item,real:!!real,fixed_time:item?item.fixed_time:t.fixed_time}];
  });
}
// Partition connected overlap groups into lanes, including chained overlaps.
export function calendarLanes(blocks){
  const sorted=blocks.map(b=>({...b})).sort((a,b)=>a.start-b.start||b.end-a.end),groups=[];let group=[],end=-1;
  for(const b of sorted){if(group.length&&b.start>=end){groups.push(group);group=[];end=-1;}group.push(b);end=Math.max(end,b.end);}if(group.length)groups.push(group);
  return groups.flatMap(g=>{const lanes=[];for(const b of g){let lane=lanes.findIndex(e=>e<=b.start);if(lane<0)lane=lanes.length;lanes[lane]=b.end;b.lane=lane;}return g.map(b=>({...b,lanes:lanes.length}));});
}
export function calendarConflicts(blocks){
  const open=blocks.filter(b=>!['completed','continued','postponed','skipped'].includes(b.status)),pairs=[];
  for(let i=0;i<open.length;i++)for(let j=i+1;j<open.length;j++)if(open[i].start<open[j].end&&open[j].start<open[i].end)pairs.push([open[i],open[j]]);
  return pairs;
}
export function snapGesture({mode,start,minutes,delta,target}){
  const change=Math.round(delta/5)*5;
  if(mode==='resize-start'){const s=Math.max(0,start+minutes-720,Math.min(start+minutes-5,start+change));return {start:s,minutes:start+minutes-s};}
  if(mode==='resize-end')return {start,minutes:Math.max(5,Math.min(720,1439-start,minutes+change))};
  return {start:Math.max(0,Math.min(1439-minutes,Math.round((target??start+change)/5)*5)),minutes};
}
export function calendarHTML(tasks,day,draft=null,scale=PIXELS_PER_MINUTE){
  const blocks=calendarLanes(calendarBlocks(tasks,day,draft)),recovery=draft?draft.items.filter(t=>!t.placed):organizerItems(tasks,day).filter(t=>t.recover),conflicts=draft?calendarConflicts(blocks):[],editing=!!draft;
  return `<section class="day-calendar ${editing?'is-editing':''}" aria-label="Calendario del día"><div class="calendar-toolbar"><div><h3>Tu día de un vistazo</h3><p>${editing?'Mantén pulsado y arrastra. Usa los extremos para cambiar la duración.':'Toca un bloque para abrirlo. Los espacios vacíos son tiempo libre.'}</p></div><button class="btn ${editing?'':'primary'}" data-action="${editing?'calendar-cancel':'calendar-edit'}">${editing?'Cancelar cambios':'Mover y ajustar'}</button></div>${recovery.length?`<div class="calendar-tray"><strong>Sin hueco · ${recovery.length}</strong><p>${editing?'Arrastra desde el asa hacia la hora que quieras, o toca para elegirla.':'Puedes recolocarlas desde Mover y ajustar.'}</p><div class="calendar-tray-items">${recovery.map(t=>`<div class="calendar-recovery" data-cal-id="${t.id}"><button data-action="${editing?'calendar-edit-block':'detail'}" data-id="${t.id}"><span>${esc(t.title)}</span><small>${t.minutes} min</small></button>${editing?`<span class="recovery-grip" data-cal-drag="place" data-id="${t.id}" role="button" tabindex="0" aria-label="Arrastrar ${esc(t.title)} al calendario">⠿</span>`:''}</div>`).join('')}</div></div>`:''}<div id="calendar-status" class="calendar-status ${conflicts.length?'has-conflicts':''}" role="status">${conflicts.length?`${conflicts.length} solapamiento${conflicts.length===1?'':'s'}. Mueve o acorta los bloques antes de guardar.`:editing?'Propuesta sin solapamientos. Los horarios fijos solo cambian si tú los mueves.':''}</div><div class="calendar-zoom segmented" role="group" aria-label="Tamaño de las franjas"><button data-action="calendar-zoom" data-mode="large" class="${scale===PIXELS_PER_MINUTE?'active':''}" aria-pressed="${scale===PIXELS_PER_MINUTE}">Franjas amplias</button><button data-action="calendar-zoom" data-mode="compact" class="${scale!==PIXELS_PER_MINUTE?'active':''}" aria-pressed="${scale!==PIXELS_PER_MINUTE}">Vista general</button></div><div class="calendar-scroll" id="calendar-scroll" aria-label="Horas del día"><div class="calendar-grid" id="calendar-grid" style="--calendar-scale:${scale};height:${1440*scale}px">${Array.from({length:24},(_,h)=>`<div class="calendar-hour" style="top:${h*60*scale}px"><span>${minuteClock(h*60)}</span></div>`).join('')}<div class="calendar-blocks">${blocks.map(b=>`<div class="calendar-block ${(b.end-b.start)<=10?'short-block':''} category-${b.category} ${b.editable?'editable':''} ${b.status==='completed'?'is-completed':''} ${conflicts.some(p=>p.some(x=>x.id===b.id))?'overlaps':''}" data-cal-id="${b.id}" ${editing&&b.editable?`data-cal-drag="move" data-id="${b.id}"`:''} style="top:${b.start*scale}px;height:${Math.max(24,(b.end-b.start)*scale-2)}px;left:calc(${b.lane/b.lanes*100}% + 3px);width:calc(${100/b.lanes}% - 6px)"><button class="calendar-block-body" data-action="${editing&&b.editable?'calendar-edit-block':'detail'}" data-id="${b.id}" aria-label="${esc(b.title)}, ${minuteClock(b.start)} a ${minuteClock(Math.min(1439,b.end))}, ${b.end-b.start} minutos, ${STATUS[b.status]}"><strong>${esc(b.title)}</strong><small>${minuteClock(b.start)}–${minuteClock(Math.min(1439,b.end))} (${b.end-b.start} min)${b.real?' · Real':b.fixed_time?' · Fijo':''}</small></button>${editing&&b.editable?`<span class="calendar-handle start" data-cal-drag="resize-start" data-id="${b.id}" aria-label="Ajustar inicio"></span><span class="calendar-handle end" data-cal-drag="resize-end" data-id="${b.id}" aria-label="Ajustar fin"></span>`:''}</div>`).join('')}</div><div id="calendar-now" class="calendar-now" ${day!==dateKey()?'hidden':''} style="top:${clockMinutes(new Date())*scale}px"><span>${timeLabel(new Date())}</span></div><div class="calendar-ghost" id="calendar-ghost" hidden></div></div></div>${editing?'<div class="calendar-save"><button class="btn primary" data-action="calendar-preview">Revisar y guardar mi día</button><p class="hint">Los cambios se guardan juntos. Puedes dejar tareas sin hueco y conservar tiempo libre.</p></div>':''}</section>`;
}
export function bindCalendarGestures({getDraft,onChange,onMessage,getScale=()=>PIXELS_PER_MINUTE}){
  let gesture=null,suppressUntil=0,frame=0;
  const cancel=()=>{if(!gesture)return;clearTimeout(gesture.timer);cancelAnimationFrame(frame);document.getElementById('calendar-ghost')?.setAttribute('hidden','');gesture.source.classList.remove('dragging');gesture=null;};
  const update=()=>{
    if(!gesture?.active)return;
    const scroll=document.getElementById('calendar-scroll'),grid=document.getElementById('calendar-grid');if(!scroll||!grid){cancel();return;}
    const rect=scroll.getBoundingClientRect(),inside=gesture.y>=rect.top&&gesture.y<=rect.bottom&&gesture.x>=rect.left&&gesture.x<=rect.right;
    if(inside&&gesture.y<rect.top+48)scroll.scrollTop-=10;else if(inside&&gesture.y>rect.bottom-48)scroll.scrollTop+=10;
    if(!inside&&gesture.mode==='place'){if(gesture.y>window.innerHeight-70)window.scrollBy(0,10);else if(gesture.y<60)window.scrollBy(0,-10);}
    const target=(gesture.y-grid.getBoundingClientRect().top)/getScale();
    gesture.next=snapGesture({mode:gesture.mode,start:gesture.start,minutes:gesture.minutes,delta:target-gesture.anchor,target:gesture.mode==='place'?target:undefined});
    gesture.inside=inside||gesture.mode!=='place';
    const ghost=document.getElementById('calendar-ghost');ghost.hidden=false;ghost.style.top=gesture.next.start*getScale()+'px';ghost.style.height=Math.max(28,gesture.next.minutes*getScale())+'px';ghost.textContent=`${minuteClock(gesture.next.start)}–${minuteClock(gesture.next.start+gesture.next.minutes)} · ${gesture.next.minutes} min`;
    frame=requestAnimationFrame(update);
  };
  document.addEventListener('pointerdown',e=>{
    const source=e.target.closest('[data-cal-drag]'),draft=getDraft();if(!source||!draft||e.button!==0||!e.isPrimary)return;
    const item=draft.items.find(i=>i.id===source.dataset.id);if(!item)return;
    const grid=document.getElementById('calendar-grid');gesture={source,id:item.id,pointer:e.pointerId,x:e.clientX,y:e.clientY,originX:e.clientX,originY:e.clientY,start:item.start,minutes:item.minutes,mode:source.dataset.calDrag,anchor:(e.clientY-grid.getBoundingClientRect().top)/getScale(),active:false};
    const activate=()=>{if(!gesture||gesture.active)return;gesture.active=true;source.setPointerCapture(gesture.pointer);source.classList.add('dragging');onMessage('Suelta para colocar el bloque.');update();};gesture.activate=activate;
    if(gesture.mode.startsWith('resize'))activate();else gesture.timer=setTimeout(activate,280);
  });
  document.addEventListener('pointermove',e=>{if(gesture&&gesture.pointer===e.pointerId){gesture.x=e.clientX;gesture.y=e.clientY;if(!gesture.active&&e.pointerType==='mouse'&&Math.hypot(e.clientX-gesture.originX,e.clientY-gesture.originY)>4){clearTimeout(gesture.timer);gesture.activate();}if(gesture.active)e.preventDefault();}},{passive:false});
  document.addEventListener('pointerup',e=>{
    if(!gesture||gesture.pointer!==e.pointerId)return;
    if(gesture.active){
      const grid=document.getElementById('calendar-grid'),scroll=document.getElementById('calendar-scroll');
      if(grid&&scroll){const rect=scroll.getBoundingClientRect(),target=(e.clientY-grid.getBoundingClientRect().top)/getScale();
        gesture.next=snapGesture({mode:gesture.mode,start:gesture.start,minutes:gesture.minutes,delta:target-gesture.anchor,target:gesture.mode==='place'?target:undefined});
        gesture.inside=gesture.mode!=='place'||e.clientY>=rect.top&&e.clientY<=rect.bottom&&e.clientX>=rect.left&&e.clientX<=rect.right;
      }
    }
    if(gesture.active&&gesture.next&&gesture.inside){const item=getDraft()?.items.find(i=>i.id===gesture.id);if(item){Object.assign(item,gesture.next,{placed:true});suppressUntil=Date.now()+500;cancel();onChange();return;}}
    if(gesture.active)suppressUntil=Date.now()+500;cancel();
  });
  document.addEventListener('pointercancel',cancel);
  document.addEventListener('click',e=>{if(Date.now()<suppressUntil&&e.target.closest('.day-calendar')){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')cancel();});
}
