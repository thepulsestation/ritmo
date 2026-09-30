import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {bindTaskSwipes} from '../task-swipe.js';

// Dispatch actual handlers against a minimal DOM, including capture/bubble order.
function fixture(){
  let time=0;
  const handlers=new Map(),nodes=[];
  const root={querySelectorAll:()=>nodes,addEventListener(type,fn,options={}){const list=handlers.get(type)||[];list.push({fn,capture:options.capture});handlers.set(type,list);}};
  function row(){
    const classes=new Set(),props=new Map(),attrs=new Map(),toggleAttrs=new Map();
    const actions={inert:true,setAttribute:(k,v)=>attrs.set(k,v)};
    const toggle={setAttribute:(k,v)=>toggleAttrs.set(k,v),closest(selector){if(selector==='.task-swipe')return node;if(selector==='button,a,input,select,textarea'||selector==='[data-action="swipe-toggle"]')return toggle;return null;}};
    const card={capture:null,setPointerCapture(id){this.capture=id;},closest(selector){if(selector==='.task-swipe')return node;if(selector==='.task-row')return card;return null;}};
    const node={isConnected:true,classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v),toggle(v,on){if(on)classes.add(v);else classes.delete(v);}},style:{setProperty:(k,v)=>props.set(k,v),removeProperty:k=>props.delete(k)},querySelector:s=>s==='.task-swipe-actions'?actions:toggle,card,toggle,actions,props,attrs,toggleAttrs};
    nodes.push(node);return node;
  }
  function fire(type,target,options={}){
    const event={target,isPrimary:true,button:0,pointerId:1,clientX:200,clientY:100,detail:1,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...options};
    for(const handler of [...(handlers.get(type)||[])].sort((a,b)=>Number(b.capture||false)-Number(a.capture||false))){handler.fn(event);if(event.stopped)break;}
    return event;
  }
  bindTaskSwipes({root,now:()=>time});
  return {root,row,fire,advance:ms=>{time+=ms;},outside:{closest:()=>null}};
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
test('vertical movement and right swipe on a closed row leave native scrolling untouched',()=>{
  const f=fixture(),r=f.row();f.fire('pointerdown',r.card);
  const move=f.fire('pointermove',r.card,{clientX:202,clientY:145});
  assert.equal(move.defaultPrevented,false);assert.equal(r.card.capture,null);
  f.fire('pointerup',r.card,{clientX:80,clientY:150});
  assert.equal(r.classList.contains('is-open'),false);
  assert.equal(swipe(f,r,100,210).defaultPrevented,false);
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
test('secondary pointers and controls cannot start dragging, final release position is respected',()=>{
  const f=fixture(),r=f.row();f.fire('pointerdown',r.card,{isPrimary:false});f.fire('pointermove',r.card,{clientX:80});assert.equal(r.card.capture,null);
  f.fire('pointerdown',r.toggle);f.fire('pointermove',r.toggle,{clientX:80});assert.equal(r.card.capture,null);
  f.fire('pointerdown',r.card);f.fire('pointermove',r.card,{clientX:185});f.fire('pointerup',r.card,{clientX:100});
  assert.equal(r.classList.contains('is-open'),true);
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
