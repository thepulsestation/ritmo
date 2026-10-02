import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {bindTaskSwipes} from '../task-swipe.js';

// Dispatch actual handlers against a minimal DOM, including capture/bubble order.
function fixture(touchEvents=false){
  let time=0;
  const handlers=new Map(),nodes=[],commits=[];
  const root={querySelectorAll:()=>nodes,addEventListener(type,fn,options={}){const list=handlers.get(type)||[];list.push({fn,capture:options.capture});handlers.set(type,list);}};
  function row(){
    const classes=new Set(),props=new Map(),attrs=new Map(),toggleAttrs=new Map();
    const actions={inert:true,setAttribute:(k,v)=>attrs.set(k,v)};
    const tomorrowAttrs=new Map(),tomorrow={inert:true,setAttribute:(k,v)=>tomorrowAttrs.set(k,v)};
    const toggle={setAttribute:(k,v)=>toggleAttrs.set(k,v),closest(selector){if(selector==='.task-swipe')return node;if(selector==='.task-row')return card;if(selector==='button,a'||selector==='button,a,input,select,textarea'||selector==='[data-action="swipe-toggle"]')return toggle;return null;}};
    const card={capture:null,setPointerCapture(id){this.capture=id;},closest(selector){if(selector==='.task-swipe')return node;if(selector==='.task-row')return card;return null;}};
    const node={isConnected:true,getBoundingClientRect:()=>({width:300}),classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v),toggle(v,on){if(on)classes.add(v);else classes.delete(v);}},style:{setProperty:(k,v)=>props.set(k,v),removeProperty:k=>props.delete(k)},querySelector:s=>s==='.task-swipe-actions'?actions:s==='.task-swipe-tomorrow'?tomorrow:toggle,card,toggle,actions,tomorrow,tomorrowAttrs,props,attrs,toggleAttrs};
    nodes.push(node);return node;
  }
  function fire(type,target,options={}){
    const event={target,isPrimary:true,button:0,pointerId:1,clientX:200,clientY:100,detail:1,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...options};
    for(const handler of [...(handlers.get(type)||[])].sort((a,b)=>Number(b.capture||false)-Number(a.capture||false))){handler.fn(event);if(event.stopped)break;}
    return event;
  }
  bindTaskSwipes({root,now:()=>time,touchEvents,onCommit:(row,direction)=>commits.push({row,direction})});
  return {root,row,fire,commits,advance:ms=>{time+=ms;},outside:{closest:()=>null}};
}
function swipe(f,row,start,end){f.fire('pointerdown',row.card,{clientX:start});f.fire('pointermove',row.card,{clientX:end});return f.fire('pointerup',row.card,{clientX:end});}

test('left swipe reveals an accessible action without deleting; release consumes its synthetic click',()=>{
  const f=fixture(),r=f.row();let clicks=0;f.root.addEventListener('click',()=>clicks++);
  swipe(f,r,200,80);
  assert.equal(r.classList.contains('is-open'),true);assert.equal(r.actions.inert,false);
  assert.equal(r.attrs.get('aria-hidden'),'false');assert.equal(r.toggleAttrs.get('aria-expanded'),'true');
  assert.equal(r.card.capture,1);assert.equal(r.props.size,0);assert.equal(clicks,0);
  assert.equal(f.fire('click',r.card).defaultPrevented,true);assert.equal(clicks,0);
  f.advance(451);f.fire('click',r.card);assert.equal(clicks,1);
});
test('short left swipe snaps shut and right swipe closes an open row',()=>{
  const f=fixture(),r=f.row();swipe(f,r,200,170);
  assert.equal(r.classList.contains('is-open'),false);assert.equal(r.actions.inert,true);
  swipe(f,r,200,80);swipe(f,r,100,210);
  assert.equal(r.classList.contains('is-open'),false);assert.equal(r.attrs.get('aria-hidden'),'true');
});
test('vertical movement leaves native scrolling untouched; right swipe reveals tomorrow',()=>{
  const f=fixture(),r=f.row();f.fire('pointerdown',r.card);
  const move=f.fire('pointermove',r.card,{clientX:202,clientY:145});
  assert.equal(move.defaultPrevented,false);assert.equal(r.card.capture,null);
  f.fire('pointerup',r.card,{clientX:80,clientY:150});
  assert.equal(r.classList.contains('is-open'),false);
  assert.equal(swipe(f,r,100,210).defaultPrevented,true);
  assert.equal(r.classList.contains('is-postpone'),true);assert.equal(r.tomorrow.inert,false);assert.equal(r.actions.inert,true);assert.equal(f.commits.length,0);
});
test('cancelled gestures restore the initial state and discard temporary offsets',()=>{
  const f=fixture(),r=f.row();
  f.fire('pointerdown',r.card);f.fire('pointermove',r.card,{clientX:80});f.fire('pointercancel',r.card);
  assert.equal(r.classList.contains('is-open'),false);assert.equal(r.classList.contains('is-dragging'),false);assert.equal(r.props.size,0);
  f.fire('click',r.toggle);f.fire('pointerdown',r.card);f.fire('pointermove',r.card,{clientX:270});f.fire('lostpointercapture',r.card);
  assert.equal(r.classList.contains('is-open'),true);assert.equal(r.actions.inert,false);
});
test('options, outside taps and Escape work; at most one row stays open',()=>{
  const f=fixture(),a=f.row(),b=f.row();
  f.fire('click',a.toggle,{detail:0});assert.equal(a.classList.contains('is-open'),true);
  f.fire('click',b.toggle,{detail:0});assert.equal(a.classList.contains('is-open'),false);assert.equal(b.classList.contains('is-open'),true);
  f.fire('keydown',b.toggle,{key:'Escape'});assert.equal(b.actions.inert,true);
  f.fire('click',a.toggle);f.fire('pointerdown',f.outside);assert.equal(a.actions.inert,true);
  f.fire('click',b.toggle);f.fire('click',f.outside);assert.equal(b.actions.inert,true);
});
test('keyboard actions remain usable during the pointer click suppression window',()=>{
  const f=fixture(),r=f.row();swipe(f,r,200,80);
  f.fire('click',r.toggle,{detail:0});assert.equal(r.classList.contains('is-open'),false);
});
test('secondary pointers are ignored and final release position is respected',()=>{
  const f=fixture(),r=f.row();f.fire('pointerdown',r.card,{isPrimary:false});f.fire('pointermove',r.card,{clientX:80});assert.equal(r.card.capture,null);
  f.fire('pointerdown',r.card);f.fire('pointermove',r.card,{clientX:185});f.fire('pointerup',r.card,{clientX:100});
  assert.equal(r.classList.contains('is-open'),true);
});
test('swiping over the options icon works while short taps still toggle once',()=>{
  const f=fixture(),r=f.row();
  f.fire('pointerdown',r.toggle);f.fire('pointerup',r.toggle);f.fire('click',r.toggle);
  assert.equal(r.classList.contains('is-open'),true);
  f.fire('pointerdown',r.toggle);f.fire('pointerup',r.toggle);f.fire('click',r.toggle);
  assert.equal(r.classList.contains('is-open'),false);
  f.fire('pointerdown',r.toggle);f.fire('pointermove',r.toggle,{clientX:80});f.fire('pointerup',r.card,{clientX:80});
  assert.equal(r.classList.contains('is-open'),true);assert.equal(f.fire('click',r.toggle).stopped,true);
});
test('capture lost by a nested title or a different pointer cannot cancel the swipe',()=>{
  const f=fixture(),r=f.row(),title={closest:s=>s==='.task-swipe'?r:s==='.task-row'?r.card:null};
  f.fire('pointerdown',title,{pointerType:'touch'});f.fire('pointermove',title,{clientX:80});
  f.fire('lostpointercapture',title);f.fire('pointercancel',title,{pointerId:2});f.fire('pointerup',title,{clientX:80});
  assert.equal(r.classList.contains('is-open'),true);assert.equal(r.card.capture,null);
});
function finger(f,type,target,x,y=100,extra={}){
  const touch={identifier:31,clientX:x,clientY:y};
  return f.fire(type,target,{touches:type==='touchend'?[]:[touch],changedTouches:[touch],...extra});
}
test('Safari touch stream survives parallel pointer cancellation and implicit capture changes',()=>{
  const f=fixture(true),r=f.row(),title={closest:s=>s==='.task-swipe'?r:s==='.task-row'?r.card:null};
  f.fire('pointerdown',title,{pointerType:'touch'});finger(f,'touchstart',title,200);
  f.fire('pointermove',title,{pointerType:'touch',clientX:80});
  const move=finger(f,'touchmove',title,80);assert.equal(move.defaultPrevented,true);
  f.fire('pointercancel',title,{pointerType:'touch'});f.fire('lostpointercapture',title);
  const end=finger(f,'touchend',title,75);assert.equal(end.defaultPrevented,true);
  f.fire('pointerup',title,{pointerType:'touch',clientX:75});
  assert.equal(r.classList.contains('is-open'),true);assert.equal(r.actions.inert,false);assert.equal(r.card.capture,null);
  f.fire('pointerdown',r.card,{pointerType:'mouse'});f.fire('pointerup',r.card,{pointerType:'mouse'});
  assert.equal(r.classList.contains('is-open'),true);
});
test('finger gestures over buttons reveal Delete; taps remain native and vertical scrolling stays free',()=>{
  const f=fixture(true),r=f.row();
  finger(f,'touchstart',r.toggle,200);finger(f,'touchend',r.toggle,200);f.fire('click',r.toggle);
  assert.equal(r.classList.contains('is-open'),true);
  finger(f,'touchstart',r.toggle,200);finger(f,'touchend',r.toggle,200);f.fire('click',r.toggle);
  assert.equal(r.classList.contains('is-open'),false);
  finger(f,'touchstart',r.toggle,200);finger(f,'touchmove',r.toggle,80);finger(f,'touchend',r.toggle,75);
  assert.equal(r.classList.contains('is-open'),true);
  f.fire('keydown',r.toggle,{key:'Escape'});finger(f,'touchstart',r.card,200);
  assert.equal(finger(f,'touchmove',r.card,205,140).defaultPrevented,false);
  assert.equal(finger(f,'touchend',r.card,80,150).defaultPrevented,false);
  assert.equal(r.classList.contains('is-open'),false);
});
test('a second finger or touch cancellation restores the starting state; right swipe closes',()=>{
  const f=fixture(true),r=f.row();finger(f,'touchstart',r.card,200);finger(f,'touchmove',r.card,80);
  finger(f,'touchstart',r.card,80,100,{touches:[{identifier:31},{identifier:32}]});
  assert.equal(r.classList.contains('is-dragging'),false);assert.equal(r.classList.contains('is-open'),false);
  finger(f,'touchstart',r.card,200);finger(f,'touchmove',r.card,80);f.fire('touchcancel',r.card);
  assert.equal(r.props.size,0);assert.equal(r.actions.inert,true);
  finger(f,'touchstart',r.card,200);finger(f,'touchmove',r.card,80);finger(f,'touchend',r.card,80);
  finger(f,'touchstart',r.card,100);finger(f,'touchmove',r.card,210);finger(f,'touchend',r.card,210);
  assert.equal(r.classList.contains('is-open'),false);
});
test('the Delete button accepts an intentional tap immediately after a completed swipe',()=>{
  const f=fixture(true),r=f.row();let clicks=0;f.root.addEventListener('click',()=>clicks++);
  finger(f,'touchstart',r.card,200);finger(f,'touchmove',r.card,80);finger(f,'touchend',r.card,80);
  const action={closest:s=>s==='.task-swipe'?r:null};
  f.fire('click',action);assert.equal(clicks,1);
  f.fire('click',r.card);assert.equal(clicks,1);
});
test('a new deliberate tap clears drag click suppression without waiting',()=>{
  const f=fixture(true),r=f.row();let clicks=0;f.root.addEventListener('click',()=>clicks++);
  finger(f,'touchstart',r.card,200);finger(f,'touchmove',r.card,80);finger(f,'touchend',r.card,80);
  assert.equal(f.fire('click',r.card).stopped,true);
  finger(f,'touchstart',r.card,80);finger(f,'touchend',r.card,80);f.fire('click',r.card);
  assert.equal(clicks,1);
});

test('full swipes commit the correct action once, only on release, and suppress the trailing tap',()=>{
  for(const [end,direction]of [[0,'delete'],[400,'tomorrow']]){
    const f=fixture(),r=f.row();f.fire('pointerdown',r.card);
    f.fire('pointermove',r.card,{clientX:end});assert.equal(f.commits.length,0);assert.equal(r.classList.contains('is-armed'),true);
    f.fire('pointerup',r.card,{clientX:end});f.fire('pointerup',r.card,{clientX:end});
    assert.deepEqual(f.commits,[{row:r,direction}]);assert.equal(r.classList.contains('is-open'),false);assert.equal(r.props.size,0);
    assert.equal(f.fire('click',r.card).stopped,true);
  }
});
test('retreating from the full-swipe threshold reveals the button without committing',()=>{
  const f=fixture(),r=f.row();f.fire('pointerdown',r.card);f.fire('pointermove',r.card,{clientX:0});
  f.fire('pointerup',r.card,{clientX:100});assert.equal(f.commits.length,0);assert.equal(r.classList.contains('is-open'),true);assert.equal(r.classList.contains('is-armed'),false);
  swipe(f,r,100,400);assert.equal(r.classList.contains('is-open'),false);assert.equal(f.commits.length,0);
});
test('cancelled full swipes never commit; the Safari stream commits independently of pointer cancellation',()=>{
  const f=fixture(true),r=f.row();finger(f,'touchstart',r.card,40);finger(f,'touchmove',r.card,290);f.fire('touchcancel',r.card);
  assert.equal(f.commits.length,0);assert.equal(r.classList.contains('is-open'),false);
  finger(f,'touchstart',r.card,40);finger(f,'touchmove',r.card,290);f.fire('pointercancel',r.card,{pointerType:'touch'});
  finger(f,'touchend',r.card,290);assert.deepEqual(f.commits,[{row:r,direction:'tomorrow'}]);
});

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function deletionFixture({fail=false,offline=false}={}){
  const requests=[],messages=[],nodes=[],tasks=[{id:'one',title:'Primera'},{id:'two',title:'Segunda'}];
  const context=createContext({state:{busy:false,tasks},navigator:{onLine:!offline},document:{querySelectorAll:()=>[],createElement:()=>({dataset:{},setAttribute(){}})},$:id=>id==='toast'?{append:n=>nodes.push(n)}:{},toast:m=>messages.push(m),closeModal(){},load:async()=>{},errorMessage:e=>e.message,rpc:async(name,args)=>{requests.push({name,args});if(fail)throw Error('Sin conexión');return tasks[0];},modal:()=>assert.fail('Quick deletion should keep the list visible')});
  runInContext(app.slice(app.indexOf('async function mutation('),app.indexOf('function getTask(')),context);
  runInContext(app.slice(app.indexOf('function deleteUndo('),app.indexOf('async function trashModal(')),context);
  return {context,requests,messages,nodes};
}
test('quick deletion waits for server confirmation and offers Undo for that exact block',async()=>{
  const f=deletionFixture();await runInContext('deleteTask(state.tasks[0],{quick:true})',f.context);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].name,'ritmo_delete_task');assert.equal(f.requests[0].args.task_id,'one');
  assert.deepEqual(Array.from(f.context.state.tasks,t=>t.id),['two']);assert.equal(f.nodes.length,1);
  assert.equal(f.nodes[0].dataset.action,'restore-task');assert.equal(f.nodes[0].dataset.id,'one');assert.equal(f.context.state.busy,false);
});
test('failed and offline deletions preserve the task and never claim success or offer Undo',async()=>{
  for(const options of [{fail:true},{offline:true}]){
    const f=deletionFixture(options);await runInContext('deleteTask(state.tasks[0],{quick:true})',f.context);
    assert.deepEqual(Array.from(f.context.state.tasks,t=>t.id),['one','two']);assert.equal(f.nodes.length,0);assert.equal(f.context.state.busy,false);
    assert.equal(f.requests.length,options.offline?0:1);assert.equal(f.messages.some(m=>m==='Tarea eliminada.'),false);
  }
});
