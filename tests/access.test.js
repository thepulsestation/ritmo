import {test} from 'node:test';import assert from 'node:assert/strict';
import {passwordError,magicLinkToken,notificationSupport} from '../access.js';
import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
const supported={isIOS:false,standalone:false,serviceWorker:true,notification:true,pushManager:true};
test('iPhone Safari must install before activation or notification tests',()=>{
  const result=notificationSupport({...supported,isIOS:true,pushManager:false});
  assert.equal(result.supported,false);assert.match(result.message,/icono/);assert.match(result.message,/Safari/);
});
test('installed iPhone supports push and older iOS gives an actionable message',()=>{
  assert.equal(notificationSupport({...supported,isIOS:true,standalone:true}).supported,true);
  const result=notificationSupport({...supported,isIOS:true,standalone:true,pushManager:false});
  assert.equal(result.supported,false);assert.match(result.message,/16\.4/);
});
test('missing registration push manager is handled before getSubscription',()=>{
  for(const registration of [{},{pushManager:{}},{pushManager:{getSubscription(){}}}])assert.equal(notificationSupport(supported,registration).supported,false);
  assert.equal(notificationSupport(supported,{pushManager:{getSubscription(){},subscribe(){}}}).supported,true);
});
test('unsupported browser cannot reach the notification flow',()=>{
  for(const key of ['serviceWorker','notification','pushManager'])assert.equal(notificationSupport({...supported,[key]:false}).supported,false);
});
test('password setup rejects weak or mismatched confirmation',()=>{
  assert.match(passwordError('short','short'),/12/);
  assert.match(passwordError('            ','            '),/12/);
  assert.match(passwordError('example-long-passphrase','different'),/coinciden/);
  assert.equal(passwordError('example-long-passphrase','example-long-passphrase'),null);
});
test('pasted access links accept only the configured project and magic link route',()=>{
  const project='https://example.supabase.co',url=project+'/auth/v1/verify?type=magiclink&token=test-token';
  assert.equal(magicLinkToken(url,project),'test-token');
  for(const link of [url.replace('example.supabase.co','evil.example'),url.replace('magiclink','recovery'),url.replace('/verify','/other'),project+'/auth/v1/verify?type=magiclink'])assert.throws(()=>magicLinkToken(link,project));
});
test('actual activation and test handlers never touch pushManager in iPhone Safari',async()=>{
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function pushEnvironment(){'),source.indexOf('async function install(){'));
  let workerReads=0,requests=0;const messages=[];
  const serviceWorker={};Object.defineProperty(serviceWorker,'ready',{get(){workerReads++;throw Error('Safari has no push manager');}});
  const context=createContext({navigator:{userAgent:'iPhone',standalone:false,serviceWorker},window:{matchMedia:()=>({matches:false})},notificationSupport,errorMessage:error=>error.message,toast:message=>messages.push(message),config:{vapidPublicKey:'test'},db:{functions:{invoke(){requests++;}}},Notification:{requestPermission(){requests++;}}});
  runInContext(code,context);await runInContext('enablePush()',context);await runInContext('testPush()',context);
  assert.equal(workerReads,0);assert.equal(requests,0);assert.equal(messages.length,2);
  for(const message of messages)assert.match(message,/pantalla de inicio/);
});
test('actual test handler handles a missing registered push manager without TypeError',async()=>{
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function pushEnvironment(){'),source.indexOf('async function install(){'));
  const messages=[];let requests=0;
  const context=createContext({navigator:{userAgent:'iPhone',standalone:true,serviceWorker:{ready:Promise.resolve({})}},window:{Notification:{},PushManager:function(){},matchMedia:()=>({matches:true})},notificationSupport,errorMessage:error=>error.message,toast:message=>messages.push(message),Notification:{permission:'granted'},setTimeout,clearTimeout,db:{functions:{invoke(){requests++;}}}});
  runInContext(code,context);await runInContext('testPush()',context);
  assert.equal(requests,0);assert.equal(messages.length,1);assert.match(messages[0],/app instalada/);assert.doesNotMatch(messages[0],/undefined|TypeError/);
});
