import {actualDuration,goalDuration} from './domain.js';

const median=values=>{const v=[...values].sort((a,b)=>a-b),n=v.length;return n?Math.round(n%2?v[(n-1)/2]:(v[n/2-1]+v[n/2])/2):0;};
export function rhythmInsights(tasks){
  const groups=new Map();
  for(const t of tasks){
    if(t.status!=='completed'||!t.actual_start||!t.actual_end)continue;
    const real=actualDuration(t);if(real<1)continue;
    const key=t.routine_id||`${t.category}:${t.title.trim().toLocaleLowerCase('es').replace(/\s+/g,' ')}`;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push({task:t,real,goal:goalDuration(t),at:t.actual_end});
  }
  return [...groups.entries()].map(([key,samples])=>{
    samples.sort((a,b)=>a.at.localeCompare(b.at));const recent=samples.slice(-7),last=samples.at(-1),count=samples.length,typical=median(recent.map(s=>s.real));
    const size=Math.min(3,Math.floor(count/2)),first=size?median(samples.slice(0,size).map(s=>s.real)):null,latest=size?median(samples.slice(-size).map(s=>s.real)):null;
    const improvement=count>=4?first-latest:null,delta=typical-last.goal;
    const advice=count<3?'Aún estamos aprendiendo tu ritmo. Registra al menos 3 repeticiones completas.':delta>3?`Reserva unos ${Math.ceil(typical/5)*5} minutos para la próxima vez. Tu ritmo reciente necesita más margen.`:delta< -3?`Sueles terminar antes del objetivo. Puedes probar un bloque de ${Math.ceil(typical/5)*5} minutos o conservar ese margen libre.`:'Tu objetivo encaja con tu ritmo reciente. Mantén ese margen y sigue observando.';
    return {key,title:last.task.title,taskId:last.task.id,count,goal:last.goal,typical,last:last.real,improvement,first,latest,suggestion:count>=3?Math.max(5,Math.min(720,Math.ceil(typical/5)*5)):null,advice,samples:recent};
  }).sort((a,b)=>b.count-a.count);
}
