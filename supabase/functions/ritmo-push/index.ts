import {createClient} from 'npm:@supabase/supabase-js@2.117.2';
import webpush from 'npm:web-push@3.6.7';
// Embedded domain module at deployment by scripts/prepare.mjs.
import {dueNotifications} from './domain.js';
const projectUrl=Deno.env.get('SUPABASE_URL')!;
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const secret=Deno.env.get('RITMO_CRON_SECRET')!;
const vapidPublic=Deno.env.get('RITMO_VAPID_PUBLIC')!;
const vapidPrivate=Deno.env.get('RITMO_VAPID_PRIVATE')!;
const allowedOrigin='https://thepulsestation.github.io';
const headers={'Access-Control-Allow-Origin':allowedOrigin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-cron-secret','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json'};
const admin=createClient(projectUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
function response(status:number,data:unknown){return new Response(JSON.stringify(data),{status,headers});}
// Bound destinations prevent a hostile subscription from turning this service into an SSRF proxy.
function validSubscription(s:any){
  try{const u=new URL(s.endpoint);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com'].includes(u.hostname)||u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.endsWith('.push.apple.com');}catch{return false;}
}
async function send(subscription:any,payload:any){
  if(!validSubscription(subscription))throw new Error('Unsupported push endpoint');
  await webpush.sendNotification(subscription,JSON.stringify(payload),{TTL:90,urgency:'high',timeout:10000,vapidDetails:{subject:'https://thepulsestation.github.io/ritmo/',publicKey:vapidPublic,privateKey:vapidPrivate}});
}
function payload(t:any,kind:string,slot:number){const messages:any={before:{title:'En 2 minutos: '+t.title,body:'Ve cerrando lo anterior. Tu próximo bloque está a punto de empezar.'},'end-soon':{title:'En 2 minutos, cambia de tarea',body:'Ve cerrando «'+t.title+'». Valora el bloque y elige tu siguiente paso.'},start:{title:'Es hora de '+t.title,body:'Abre Ritmo para cerrar el bloque anterior y empezar este.'},end:{title:'Cierra tu bloque: '+t.title,body:'¿Lo has terminado, continúas después o lo pasas a otro día?'},repeat:{title:t.status==='active'?'Te estás pasando: '+t.title:'Tu siguiente paso: '+t.title,body:t.status==='active'?'Para y cambia de tarea. Abre Ritmo para terminar o continuar después; tu agenda se reajusta.':'Este bloque sigue pendiente. Entra en Ritmo para empezar o reprogramarlo.'}};return {...messages[kind],tag:`ritmo-${t.id}-${kind}-${slot}`};}
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('',{headers});
  if(req.method!=='POST')return response(405,{error:'Method not allowed'});
  if(!secret||!vapidPublic||!vapidPrivate)return response(503,{error:'Push is not configured'});
  try{
    const isCron=req.headers.get('x-cron-secret')===secret;
    if(!isCron){
      const jwt=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'');if(!jwt)return response(401,{error:'Authentication required'});
      const {data:{user},error}=await admin.auth.getUser(jwt);if(error||!user)return response(401,{error:'Invalid session'});
      const {data:owner}=await admin.from('ritmo_owners').select('user_id').eq('user_id',user.id).maybeSingle();if(!owner)return response(403,{error:'No access'});
      const body=await req.json();if(body.action!=='test')return response(400,{error:'Invalid action'});
      const {data:sub}=await admin.from('ritmo_push_subscriptions').select('*').eq('user_id',user.id).eq('endpoint',body.endpoint).maybeSingle();if(!sub)return response(404,{error:'Activate this device first'});
      // A per-device test can be sent no more than once per minute.
      const {error:claim}=await admin.from('ritmo_notification_deliveries').insert({subscription_id:sub.id,task_id:null,kind:'test',slot:Math.floor(Date.now()/60000)});
      if(claim)return response(429,{error:'Try again in one minute'});
      await send(sub.subscription,{title:'Ritmo está contigo',body:'Los avisos llegan a este dispositivo. Ya puedes cerrar la app.',tag:'ritmo-test'});return response(200,{ok:true});
    }
    const {error:adjustError}=await admin.rpc('ritmo_sync_overdue');if(adjustError)throw adjustError;
    const now=new Date();
    const {error:healthError}=await admin.from('ritmo_health').upsert({id:1,checked_at:now.toISOString()});if(healthError)throw healthError;
    const {data:owners,error:oe}=await admin.from('ritmo_owners').select('*').eq('notifications_enabled',true);if(oe)throw oe;
    let sent=0,failed=0;
    for(const owner of owners||[]){
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
      const {data:tasks,error:te}=await admin.from('ritmo_tasks').select('*').eq('user_id',owner.user_id).in('status',['pending','active']).gte('starts_at',new Date(now.getTime()-26*3600000).toISOString()).lte('starts_at',new Date(now.getTime()+180000).toISOString());if(te)throw te;
      const {data:subs,error:se}=await admin.from('ritmo_push_subscriptions').select('*').eq('user_id',owner.user_id);if(se)throw se;
      const dues=dueNotifications(tasks||[],now);
      for(const due of dues){
        for(const sub of subs||[]){
          const {error:claimError}=await admin.from('ritmo_notification_deliveries').insert({task_id:due.task.id,subscription_id:sub.id,kind:due.kind,slot:due.slot});
          if(claimError){if(claimError.code==='23505')continue;throw claimError;}
          // Recheck status immediately before dispatch, to respect a concurrent decision.
          const {data:latest}=await admin.from('ritmo_tasks').select('status,starts_at,ends_at').eq('id',due.task.id).maybeSingle();
          if(!latest||latest.status!==due.task.status||latest.starts_at!==due.task.starts_at||latest.ends_at!==due.task.ends_at)continue;
          try{await send(sub.subscription,payload(due.task,due.kind,due.slot));sent++;await admin.from('ritmo_notification_deliveries').update({delivered_at:new Date().toISOString()}).eq('task_id',due.task.id).eq('subscription_id',sub.id).eq('kind',due.kind).eq('slot',due.slot);}
          catch(error:any){failed++;if([404,410].includes(error.statusCode)){await admin.from('ritmo_push_subscriptions').delete().eq('id',sub.id);}else{await admin.from('ritmo_notification_deliveries').update({error:String(error.message).slice(0,300)}).eq('task_id',due.task.id).eq('subscription_id',sub.id).eq('kind',due.kind).eq('slot',due.slot);}}
        }
      }
    }
    return response(200,{ok:true,sent,failed});
  }catch(error:any){console.error('Ritmo dispatch failed',error?.message);return response(500,{error:'Dispatch failed'});}
});
