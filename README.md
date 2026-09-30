# Ritmo

Agenda personal instalable, publicada en GitHub Pages y respaldada por Supabase. No contiene un servicio de IA ni de voz; permite copiar el estado al chat e importar un plan JSON o texto con vista previa.

## Uso

1. Iniciar sesión con el correo autorizado y la contraseña. Para crearla por primera vez, desde una sesión abierta con enlace entrar en **Ajustes → Crear o cambiar contraseña**. Elegirla personalmente; no se incluye en el código ni en el chat. Como alternativa, **Con enlace** permite solicitar un correo o pegar un enlace vigente sin volver a solicitarlo. La sesión se conserva en cada navegador o app instalada.
2. Empezar un bloque y cerrarlo como completado, continuación, reprogramado o descartado. Añadir notas y valoración opcional. Al empezar tarde, el resto se reajusta. Al terminar antes, elegir entre adelantar las tareas siguientes o conservar el tiempo libre. Siempre se muestra una vista previa.
3. En **Preparar mañana**, copiar el resumen para el chat. Pegar el plan recibido, revisar y guardar.
4. Las tareas diarias se copian con **Copiar rutina**, usando sus horas objetivo, para que el retraso de hoy no se copie a mañana. Los horarios que ya están ocupados se conservan.
5. Instalar desde el móvil y activar notificaciones. El botón de prueba confirma la recepción en ese dispositivo.

## Desarrollo

Aplicación estática sin compilación: `node scripts/serve.mjs`. Pruebas: `npm test`. Preparar la función: `node scripts/prepare.mjs`. Para una instalación nueva usar `supabase/schema.sql`; para actualizar una instalación anterior aplicar solo `supabase/migrations/20260930_adaptive.sql`.

## Agenda adaptable

**Me he retrasado · Reajustar el día** permite llevar el primer bloque pendiente a la hora actual o añadir minutos de retraso. Trabajo y comida son horarios fijos por defecto, y cada tarea permite cambiar esa preferencia. Los retrasos se absorben al llegar a un bloque fijo; las tareas flexibles que ya no caben quedan como **Pendiente de recolocar**, sin borrarse. Un bloque fijo iniciado tarde conserva su hora de fin. Un bloque flexible se acorta si su duración invadiría el próximo horario fijo; el objetivo original permanece visible en la vista previa y el balance.

El planificador reajusta las tareas pendientes cada minuto cuando se alarga el bloque activo, aunque los avisos estén pausados o la app esté cerrada. Conserva su hora de fin como referencia para los avisos de cambio; una marca de avance evita aplicar dos veces el mismo retraso. Cada escritura de agenda usa el bloqueo transaccional del propietario. Los bloques cerrados se muestran con su intervalo real cuando existe, dejando visible el objetivo. El balance compara objetivo, horario ajustado y tiempo real. Las duraciones habituales usan la mediana de registros completados o continuados; menos de tres se etiquetan como primeros registros. El resumen para el chat incluye estos datos.

`config.js` contiene únicamente la URL de Supabase, su clave pública y la clave pública VAPID. Las claves de servicio, el secreto del planificador y la clave privada VAPID se guardan únicamente en Supabase. Las tablas de Ritmo usan RLS y una lista explícita de usuarios autorizados. Las escrituras se validan mediante RPC transaccionales y dejan un registro de eventos.

## Recordatorios

Supabase Cron llama a `ritmo-push` cada minuto. El endpoint comprueba un secreto de Cron para el trabajo programado, y un JWT de usuario autorizado para las pruebas. Los avisos usan Web Push estándar: dos minutos antes de empezar, al inicio, dos minutos antes de cerrar un bloque activo, al final y cada cinco minutos si falta empezar o cerrar. Un bloque activo impide avisos de inicio de otra tarea flexible. Los avisos de inicio y previos usan la hora ajustada para evitar duplicados. Las tareas revisadas o pendientes de recolocar no generan avisos. Los avisos atrasados no se acumulan. El sistema registra los envíos y elimina suscripciones caducadas.

Los horarios usan `Europe/Madrid`, incluido el cambio estacional de hora. La frecuencia del trabajo programado da una precisión de aproximadamente un minuto, y el sistema operativo o el modo de concentración pueden retrasar la entrega. En iPhone, Web Push necesita iOS 16.4 o posterior y abrir la app instalada desde la pantalla de inicio. En Safari los botones de activación y prueba quedan deshabilitados con instrucciones; ambos flujos comprueban también la disponibilidad de `pushManager` antes de usarlo.

El service worker guarda solo archivos de la interfaz. No guarda respuestas de Supabase ni una copia local de la agenda. La sesión permanece en el navegador mediante el cliente oficial Supabase JS 2.117.2; los cambios necesitan conexión. El correo gratuito de Supabase tiene una cuota reducida y solo envía a miembros de la organización. La cuenta personal autorizada es miembro. Si el enlace caduca, solicitar uno nuevo; el último enlace recibido sustituye al anterior.

No hay auto-importación de planes ni agentes autónomos dentro de la aplicación. El flujo diario se realiza entre la persona y su chat.
