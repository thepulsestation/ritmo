# Ritmo

Agenda personal instalable, publicada en GitHub Pages y respaldada por Supabase. No contiene un servicio de IA ni de voz; permite copiar el estado al chat e importar un plan JSON o texto con vista previa.

## Uso

1. Solicitar el enlace de acceso con el correo personal autorizado. En la app instalada del iPhone, mantener pulsado «Sign in» en el correo, copiar el enlace y pegarlo en Ritmo. También se puede abrir directamente en Safari. La sesión se conserva.
2. Empezar un bloque y cerrarlo como completado, continuación, reprogramado o descartado. Añadir notas y valoración opcional.
3. En **Preparar mañana**, copiar el resumen para el chat. Pegar el plan recibido, revisar y guardar.
4. Las tareas diarias se copian con **Copiar rutina**. Los horarios que ya están ocupados se conservan.
5. Instalar desde el móvil y activar notificaciones. El botón de prueba confirma la recepción en ese dispositivo.

## Desarrollo

Aplicación estática sin compilación: `node scripts/serve.mjs`. Pruebas: `node --test tests/domain.test.js`. Preparar la función: `node scripts/prepare.mjs`.

`config.js` contiene únicamente la URL de Supabase, su clave pública y la clave pública VAPID. Las claves de servicio, el secreto del planificador y la clave privada VAPID se guardan únicamente en Supabase. Las tablas de Ritmo usan RLS y una lista explícita de usuarios autorizados. Las escrituras se validan mediante RPC transaccionales y dejan un registro de eventos.

## Recordatorios

Supabase Cron llama a `ritmo-push` cada minuto. El endpoint comprueba un secreto de Cron para el trabajo programado, y un JWT de usuario autorizado para las pruebas. Los avisos usan Web Push estándar: dos minutos antes, al inicio, al final de un bloque activo y cada cinco minutos si el bloque no se ha reconocido. Las tareas revisadas no generan avisos. Los avisos atrasados no se acumulan y las tareas de días anteriores no siguen sonando. El sistema registra los envíos y elimina suscripciones caducadas.

Los horarios usan `Europe/Madrid`, incluido el cambio estacional de hora. La frecuencia del trabajo programado da una precisión de aproximadamente un minuto, y el sistema operativo o el modo de concentración pueden retrasar la entrega. En iPhone se debe instalar en la pantalla de inicio para permitir Web Push.

El service worker guarda solo archivos de la interfaz. No guarda respuestas de Supabase ni una copia local de la agenda. La sesión permanece en el navegador mediante el cliente oficial Supabase JS 2.117.2; los cambios necesitan conexión. El correo gratuito de Supabase tiene una cuota reducida y solo envía a miembros de la organización. La cuenta personal autorizada es miembro. Si el enlace caduca, solicitar uno nuevo; el último enlace recibido sustituye al anterior.

No hay auto-importación de planes ni agentes autónomos dentro de la aplicación. El flujo diario se realiza entre la persona y su chat.
