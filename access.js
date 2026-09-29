export function passwordError(password,confirmation){
  if(password.trim().length<12)return 'Usa una contraseña de al menos 12 caracteres.';
  if(password.length>128)return 'La contraseña debe tener como máximo 128 caracteres.';
  if(password!==confirmation)return 'Las dos contraseñas no coinciden.';
  return null;
}

export function magicLinkToken(raw,projectUrl){
  let link;try{link=new URL(raw.trim());}catch{throw new Error('Copia el enlace completo del botón Sign in de tu correo.');}
  if(link.origin!==new URL(projectUrl).origin||link.pathname!=='/auth/v1/verify'||link.searchParams.get('type')!=='magiclink')throw new Error('Este enlace no pertenece a Ritmo. Usa el enlace del correo de acceso.');
  const token=link.searchParams.get('token')||link.searchParams.get('token_hash');
  if(!token)throw new Error('El enlace está incompleto. Cópialo de nuevo desde el correo.');
  return token;
}

export function notificationSupport(environment,registration){
  if(environment.isIOS&&!environment.standalone)return {supported:false,message:'En iPhone, abre Ritmo desde su icono en la pantalla de inicio para activar y probar los avisos. En una pestaña de Safari no están disponibles.'};
  if(!environment.serviceWorker||!environment.notification||!environment.pushManager)return {supported:false,message:environment.isIOS?'Los avisos necesitan iOS 16.4 o posterior y abrir Ritmo desde su icono. Actualiza el iPhone si es necesario.':'Este navegador no admite los avisos de Ritmo. Prueba un navegador actualizado.'};
  if(registration&&(!registration.pushManager||typeof registration.pushManager.getSubscription!=='function'||typeof registration.pushManager.subscribe!=='function'))return {supported:false,message:'Los avisos no están disponibles en esta ventana. Abre la app instalada y vuelve a intentarlo.'};
  return {supported:true,message:'Activa los avisos en el dispositivo en el que quieres recibirlos.'};
}
