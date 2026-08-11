# OpenCheck Score — App Android (Capacitor)

Este proyecto envuelve la app web que ya tenemos (`www/index.html`) en un
shell nativo de Android, usando Capacitor. La lógica de la app (scoring,
Supabase, OCR) es la misma — Capacitor solo la empaqueta como app nativa.

## Lo que necesitás instalado en tu máquina

1. **Node.js** (v18 o superior) — https://nodejs.org
2. **Android Studio** — https://developer.android.com/studio (incluye el
   Android SDK, que es lo que realmente compila la app)
3. Una cuenta de **Google Play Console** (USD 25, pago único) — solo hace
   falta cuando llegue el momento de publicar, no para probar en tu
   celular.

## Paso a paso

### 1. Instalar las dependencias

Abrí una terminal en esta carpeta (`opencheck-mobile`) y corré:

```
npm install
```

### 2. Agregar la plataforma Android

```
npx cap add android
```

Esto crea una carpeta `android/` con un proyecto nativo completo — no
hace falta tocar nada ahí manualmente todavía.

### 3. Sincronizar el contenido web

Cada vez que cambiemos algo en `www/index.html`, hay que correr esto para
que el proyecto Android lo tome:

```
npx cap sync android
```

### 4. Abrir en Android Studio

```
npx cap open android
```

Esto abre Android Studio con el proyecto ya armado. Desde ahí:
- Conectá tu celular Android por USB (con "Depuración USB" activada en
  Opciones de desarrollador), o usá un emulador.
- Tocá el botón de Play (▶) para compilar e instalar la app.

### 5. Probar

La app debería abrir mostrando exactamente la misma pantalla de registro
que ves en el navegador. Todo lo que ya funciona en la web (login,
consultas, historial) debería funcionar igual acá, porque es el mismo
código.

## Qué probablemente no funcione todavía (a propósito)

- **Notificaciones push**: el sistema que armamos usa Web Push (VAPID),
  que no funciona igual dentro de un WebView nativo. Para que las push
  anden en la app Android, hay que migrar a Firebase Cloud Messaging
  (FCM) — es la etapa siguiente, necesita que armes un proyecto de
  Firebase primero.
- **Cámara para OCR**: el código actual usa `getUserMedia` (cámara web).
  Debería funcionar dentro del WebView de Android agregando el permiso de
  cámara en `android/app/src/main/AndroidManifest.xml`:
  ```xml
  <uses-permission android:name="android.permission.CAMERA" />
  ```
  Si da problemas, la alternativa es cambiar a `@capacitor/camera` (ya
  está en las dependencias, instalado pero no conectado todavía), que da
  acceso a la cámara nativa del sistema en vez de la del navegador.

## Sobre el ícono de la app y el nombre del paquete

- El nombre del paquete quedó como `com.opencheckscore.app` en
  `capacitor.config.json` — es el identificador único de la app en Google
  Play, **no se puede cambiar después de publicar la primera vez**.
  Confirmá que te sirve antes de publicar.
- Vas a necesitar un ícono de la app (al menos 512x512px) y una imagen de
  splash screen — todavía no los armamos.

## Próximos pasos sugeridos

1. Confirmar que la app compila y corre bien en un celular real.
2. Armar ícono + splash screen.
3. Migrar las notificaciones push a Firebase Cloud Messaging.
4. Decidir si la cámara pasa a `@capacitor/camera` nativo.
5. Completar la ficha de Google Play (capturas, descripción, formulario
   de privacidad de datos).
