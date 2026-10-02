// Additional time starts at the current deadline, or now if it has expired.
export function extensionEnd(task,minutes,now=new Date()){
  if(task?.status!=='active')throw Error('Este bloque ya no está en curso.');
  if(!Number.isInteger(minutes)||minutes<1||minutes>720)throw Error('Elige entre 1 y 720 minutos adicionales.');
  const base=Math.max(new Date(task.ends_at).getTime(),new Date(now).getTime());
  const end=new Date(Math.ceil(base/60000)*60000+minutes*60000);
  if(!Number.isFinite(end.getTime()))throw Error('La hora de esta tarea no es válida.');
  return end.toISOString();
}
