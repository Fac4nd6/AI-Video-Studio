# AI Video Studio – Chrome Extension

## Arquitectura

- `popup.html`, `popup.css`, `popup.js`: interfaz para importar, revisar y editar escenas, y controlar la cola.
- `background.js`: service worker MV3; es el punto central de mensajes y coordina la cola.
- `queue.js`: procesamiento secuencial, reanudación, reintentos y recuperación ante reinicio.
- `storage.js`: persistencia local en `chrome.storage.local`.
- `content.js`: adaptador aislado para la página de Google Flow; recibe acciones y reporta eventos observables.
- `flow.js`: interfaz entre el service worker y el content script.

El popup no opera directamente sobre el DOM de Flow. La cola persiste una escena como `processing` antes de enviarla; si hay reinicio o se pierde evidencia del resultado, pasa a `waiting_user` y no vuelve a enviar la escena automáticamente. Tras verificar un resultado incierto, el usuario puede marcarla completada manualmente o reintentarla explícitamente. Detener detiene la cola y la observación, pero Flow puede seguir generando porque no se verificó un control seguro para cancelar su generación.

## Estado de integración con Google Flow

El content script está limitado por el manifiesto a `https://flow.google.com/*`, y además verifica HTTPS y el host exacto `flow.google.com`. El detector acepta tanto la raíz (`/`) como rutas de proyecto (`/project/ID`). El service worker busca pestañas que coincidan con ese patrón y verifica el content script con un mensaje `PING`/`PONG`. Si el script no responde, intenta inyectarlo solo en una página de Flow autorizada; si falla, la interfaz muestra el motivo que devolvió Chrome. “Conectado” solo significa que el content script respondió y confirmó la URL; no indica que la automatización esté lista.

Se verificaron los selectores del editor `div[aria-label="What do you want to create?"]` (contenteditable textbox) y del botón `button[aria-label="Start generation"]` (submit). **Preparar próximo prompt** usa una selección/rango del `contenteditable`, emite `beforeinput` antes de editar y `input` después, y registra si esos eventos sintéticos fueron cancelados. Comprueba el texto y espera que el botón realmente quede visible y habilitado. Nunca hace clic, no cambia el estado de la escena y no marca generación como completada.

La detección secuencial usa una evidencia provisional observada en la traza de Flow: una imagen nueva, cargada y distinta de las imágenes previas (`img[alt="Tile displaying a user's image"]`), junto con el retorno del editor vacío y el botón de generación deshabilitado. También comprueba señales accesibles de actividad y alerta. Esto no es un contrato oficial de Flow: si la combinación no aparece, cambia o queda ambigua, la escena pasa a `waiting_user`/`error` y no se envía la siguiente. El límite de espera solo produce ese estado incierto; nunca se usa como prueba de finalización.

Al pulsar **Iniciar**, se solicita confirmación por cada escena en error antes de marcarla completada manualmente y una confirmación para procesar todas las pendientes. Flow puede generar más de un medio y consumir créditos por trabajo. La cola envía un prompt a la vez; solo avanza si el detector experimental obtiene la combinación de evidencia observada. Si no puede confirmarla, se detiene para intervención manual. El popup escucha los cambios de `chrome.storage.local` para mostrar el prompt actual y el progreso de cada escena sin tener que cerrarlo y volverlo a abrir.

Antes de cada envío, el service worker verifica que Flow esté en la pestaña activa, inicia un `MutationObserver`, prepara el prompt y vuelve a comprobar el botón. Después usa Chrome Debugger Protocol para enviar un clic de ratón a su centro visible. El permiso `debugger` es potente y se usa solo para estos clics en la pestaña activa de `flow.google.com`. Si el clic queda incierto, la escena requiere verificación manual y no se reenvía automáticamente.

El observador guarda hasta 100 snapshots en `chrome.storage.session`, incluyendo controles accesibles e imágenes/videos visibles. No observa clases CSS ni lee el texto del prompt. **Diagnosticar (solo lectura)** tampoco activa controles. La señal de resultado proviene de una traza real del usuario, pero aún debe probarse con varias generaciones consecutivas; revisá los estados y confirmá manualmente cualquier escena que quede incierta.

Tras actualizar, recargá la extensión en `chrome://extensions` y aceptá el permiso `debugger` si Chrome lo solicita. La interfaz de Flow puede cambiar; si el editor, botón o imagen resultante cambia, la detección se detendrá en vez de asumir que terminó.

La extensión no evade CAPTCHA, límites, controles de acceso ni restricciones. La pestaña debe permanecer abierta. No se reenvía automáticamente una escena cuyo resultado sea incierto.

## Integración futura con la aplicación web local

La interfaz del popup y el service worker ya usan mensajes con tipos explícitos y datos JSON. Para una integración futura, opciones recomendadas:

1. **Native Messaging** para una aplicación local instalada: canal explícito y proceso local autorizado; requiere instalar y registrar un host nativo.
2. **Mensajería externa de extensión** (`runtime.onMessageExternal` / `connectExternal`) si la aplicación es una web local: requiere permitir únicamente el origen exacto en `externally_connectable`, validar `sender.origin`/`sender.url`, validar esquemas y tamaños de mensajes, y mantener la API mínima. No usar `*` ni habilitar orígenes externos antes de definir el puerto/origen final.

No se habilita hoy un servidor HTTP local, CORS general ni una API externa; no se solicitan permisos para ello. La extensión no almacena credenciales.

## Instalar y probar en Chrome

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador**.
3. Si la extensión ya estaba cargada, pulsá **Recargar** para aplicar el nuevo host autorizado; si no, elegí **Cargar extensión sin empaquetar** y seleccioná `extension/`.
4. Dejá abierta una pestaña con una dirección como `https://flow.google.com/` o `https://flow.google.com/project/ID_DEL_PROYECTO`. No es necesario que sea la pestaña activa.
5. Abrí el popup. Debe mostrar **Google Flow detectado · conectado** y el estado de la detección experimental. El popup buscará el content script y, si falta, intentará inyectarlo de forma limitada a esa página.
6. Si muestra **Google Flow abierto · sin comunicación**, leé el detalle. Si Chrome impide la inyección, verificá el permiso para `flow.google.com`, recargá la extensión y recargá la pestaña de Flow.
7. Pulsá **Diagnosticar (solo lectura)** para inspeccionar candidatos visibles y señales accesibles. El informe no contiene el valor del campo de prompt ni activa controles.
8. Pulsá **Preparar próximo prompt (sin enviar)** para comprobar el editor y que el botón se habilite. Esto no inicia generación.
9. **Iniciar** solo se habilita cuando la detección de resultado está lista. Para comprobar primero el envío, dejá una sola escena pendiente y pulsá **Iniciar**; confirmá el aviso de posible consumo de créditos. Para probar el avance secuencial, importá más de una escena: el popup debe actualizar el prompt actual al avanzar. Cada escena posterior se envía solo tras confirmar el resultado anterior. Si la detección no está lista, no se enviará ningún prompt.
10. Si la cola no confirma el resultado, se detendrá y mostrará la escena para intervención. Verificá el resultado en Flow antes de marcarla completada o reintentarla; no reintentes una escena cuyo estado sea incierto.

## Limitaciones de esta versión

- La importación, edición, persistencia y controles de cola están implementados.
- La cola secuencial está habilitada con un detector experimental derivado de una traza observada; debe validarse con varias generaciones consecutivas en Flow. No se realizó una generación real durante estos cambios.
- La separación por línea en blanco usa uno o más renglones vacíos; el separador explícito es una línea exacta `---PROMPT---`.
- No se ha habilitado todavía la comunicación con una aplicación web local.
