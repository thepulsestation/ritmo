import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {extensionEnd} from '../task-actions.js';
import {dueNotifications} from '../domain.js';

test('extra time uses the future deadline or now when overdue, without rewriting the task',()=>{
 const task={status:'active',ends_at:'2026-10-03T09:30:00Z'},before=JSON.stringify(task);
 assert.equal(extensionEnd(task,30,'2026-10-03T09:00:00Z'),'2026-10-03T10:00:00.000Z');
 assert.equal(extensionEnd(task,15,'2026-10-03T09:41:20Z'),'2026-10-03T09:57:00.000Z');
 assert.equal(JSON.stringify(task),before);assert.throws(()=>extensionEnd({...task,status:'pending'},15),/curso/);assert.throws(()=>extensionEnd(task,0),/minutos/);
});
test('extending the active deadline silences expired-deadline notices and enables the new warning',()=>{
 const task={id:'active',status:'active',starts_at:'2026-10-03T09:00:00Z',ends_at:'2026-10-03T09:30:00Z',goal_starts_at:'2026-10-03T09:00:00Z'};
 assert.equal(dueNotifications([task],new Date('2026-10-03T09:35:00Z')).some(n=>n.kind==='repeat'),true);
 task.ends_at=extensionEnd(task,20,'2026-10-03T09:36:00Z');
 assert.equal(dueNotifications([task],new Date('2026-10-03T09:36:00Z')).length,0);
 assert.equal(dueNotifications([task],new Date('2026-10-03T09:54:00Z')).some(n=>n.kind==='end-soon'),true);
});

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fixture({fail=false,offline=false,busy=false,calendar=false}={}){
 const requests=[],messages=[],nodes=[],task={id:'one',status:'pending',updated_at:'2026-10-03T08:00:00Z'};
 const context=createContext({state:{busy,tasks:[task]},calendarState:calendar?{}:null,navigator:{onLine:!offline},document:{querySelectorAll:()=>[],createElement:()=>({dataset:{},setAttribute(){}})},$:()=>({append:n=>nodes.push(n)}),toast:m=>messages.push(m),closeModal(){},load:async()=>{},errorMessage:e=>e.message,deleteTask:()=>assert.fail('Wrong action'),rpc:async(name,args)=>{requests.push({name,args});if(fail)throw Error('Sin conexión');return {id:'one',new_task_id:'two',target_day:'2026-10-04'};}});
 runInContext(app.slice(app.indexOf('async function mutation('),app.indexOf('function getTask(')),context);
 runInContext(app.slice(app.indexOf('let postponeReceipt='),app.indexOf('function deleteTaskModal(')),context);
 return {context,requests,messages,nodes,task};
}
test('quick postponement waits for confirmation, sends the current version and offers undo',async()=>{
 const f=fixture();await runInContext("quickTaskAction(state.tasks[0],'tomorrow')",f.context);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].name,'ritmo_postpone_tomorrow');assert.equal(f.requests[0].args.request.version,f.task.updated_at);
 assert.equal(f.task.status,'postponed');assert.equal(f.nodes[0].dataset.action,'undo-postpone');assert.match(f.messages[0],/2026-10-04.*sin hueco/);
});
test('failed, offline, busy or draft-calendar postponements leave tasks intact and never offer undo',async()=>{
 for(const options of [{fail:true},{offline:true},{busy:true},{calendar:true}]){
  const f=fixture(options);await runInContext("quickTaskAction(state.tasks[0],'tomorrow')",f.context);
  assert.equal(f.task.status,'pending');assert.equal(f.nodes.length,0);assert.equal(f.requests.length,options.fail?1:0);
 }
});
