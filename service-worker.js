// Service Worker de OpenCheck Score — maneja notificaciones push.
// (Sacamos el fetch handler que tenía antes: interceptaba TODAS las
// llamadas de red de la app, incluidas las del BCRA, y sospechamos que
// eso estaba causando que las consultas reales cayeran a modo demo. No
// es indispensable para que la PWA sea instalable.)

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const opciones = {
    body: data.body || '¿Se cobró el cheque que consultaste?',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { id: data.id, token: data.token, url: data.url || '/' },
    actions: [
      { action: 'si', title: 'Sí' },
      { action: 'no', title: 'No' }
    ],
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'OpenCheck Score', opciones)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { id, token, url } = event.notification.data || {};

  let resultado = null;
  if (event.action === 'si') resultado = 'pagado';
  if (event.action === 'no') resultado = 'rechazado';

  if (resultado && id && token){
    // Clic en un botón de acción: confirmamos directo, sin abrir la app.
    event.waitUntil(
      fetch(`/.netlify/functions/confirmar-pago?id=${id}&token=${token}&resultado=${resultado}&fuente=usuario_push`)
    );
  } else {
    // Clic en el cuerpo de la notificación (sin botón, ej. en navegadores
    // que no soportan action buttons): abrimos la app, que va a mostrar
    // el mismo cartel de confirmación como respaldo.
    event.waitUntil(clients.openWindow(url || '/'));
  }
});
