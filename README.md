# Portal escolar con cuentas y control de acceso

Portal para docentes, administración, secretaría y personal de apoyo. Las personas se registran
desde cualquier dispositivo y el administrador aprueba, bloquea o cambia el cargo desde **Usuarios y accesos**.

## Probarlo en tu computadora
Requiere Node.js 18 o superior.

    npm install
    npm start

Abre http://localhost:3000. **La primera persona que se registre queda como administrador.**
Después, cada cuenta nueva queda pendiente hasta que el administrador la apruebe.

## Cómo funciona la seguridad
- Las contraseñas se guardan con scrypt (con sal), nunca en texto plano.
- La sesión va en una cookie HttpOnly (8 horas); en producción es además Secure.
- Límite de 20 intentos de entrada o registro cada 15 minutos por dirección.
- El servidor comprueba el cargo en cada petición: solo administración gestiona usuarios;
  solo administración y secretaría modifican estudiantes; los datos del centro solo los cambia administración.
- Las cuentas desactivadas o con cargo cambiado pierden la sesión al instante.
- Protección CSRF con cabecera propia y cookies SameSite.

## Publicarlo para que todos lo usen
1. Sube la carpeta a un servicio que ejecute Node.js (Render, Railway, Fly.io o un VPS).
2. Variables de entorno: `NODE_ENV=production`, y `DATA_DIR` apuntando a un disco persistente
   (ahí vive la base de datos `portal.db`). Sin disco persistente, los datos se pierden en cada despliegue.
3. Usa siempre HTTPS (los servicios anteriores lo incluyen).
4. Haz copias de seguridad periódicas de `portal.db`.

## Pendiente / mejoras recomendadas
- La casilla "Verificar que soy una persona" es solo visual. Para protección real contra robots,
  conectar Cloudflare Turnstile (hacen falta las claves de tu cuenta de Cloudflare).
- "¿Olvidaste tu contraseña?" apunta al soporte: el administrador puede poner una contraseña temporal
  desde Usuarios y accesos. Un envío automático por correo requiere un servicio de email.
- Los estudiantes, secciones y datos del centro se guardan completos como un solo bloque. Para muchos
  cientos de estudiantes conviene pasar a tablas propias.
- Tesorería, horarios y asistencia de los docentes todavía son de demostración.
