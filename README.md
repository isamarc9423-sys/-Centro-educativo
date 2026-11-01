# Portal del Personal (con servidor y MySQL)

El administrador se registra como cualquier otra persona: la **primera cuenta registrada** queda como administradora (activa). Las demás quedan *Pendientes* hasta que la apruebe en **Usuarios y accesos**.

## 1. Crear la base de datos MySQL (8.0 o MariaDB 10.5+)
Con tu hosting (cPanel, Railway, Aiven, etc.) o con MySQL propio. Ejemplo:

    CREATE DATABASE portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER 'portal'@'%' IDENTIFIED BY 'una-clave-segura';
    GRANT ALL ON portal.* TO 'portal'@'%';

Las tablas se crean solas al arrancar el servidor (users, settings, kv, reports).

## 2. Variables de entorno
- `JWT_SECRET` (opcional): frase larga y secreta (24+ caracteres). Si no la defines, el servidor crea una clave segura y la guarda en la base de datos.
- Conexión: o bien `DATABASE_URL=mysql://portal:clave@servidor:3306/portal`, o bien `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- `DB_SSL=true` si tu proveedor de MySQL exige conexión cifrada.
- Proveedores con certificado propio (por ejemplo Aiven): pega el certificado CA en `DB_CA`; si no puedes, usa `DB_SSL=relaxed` (cifra pero no verifica el certificado).
- `NODE_ENV=production` al publicarlo.

## 3. Probar en tu computadora
1. Node.js 18 o más reciente: `npm install`
2. Define las variables (Windows: `set` en vez de `export`) y ejecuta `npm start`.
3. Abre http://localhost:3000, pulsa **Solicitar acceso** y registra al administrador.
4. En **Datos del centro** escribe nombre, código, dirección, correo y teléfono, sube el logo y fija las fechas de P1 a P4.

## 4. Publicarlo (Render, Railway u otro hosting con Node.js)
1. Sube la carpeta a GitHub y crea un servicio web: Build `npm install`, Start `npm start`.
2. Agrega las variables de arriba. Con MySQL **no hace falta disco persistente**: los datos viven en la base de datos.
3. **Registra al administrador de inmediato** al publicar: la primera cuenta que se registre será la administradora.
4. Usa HTTPS y activa las copias de seguridad de tu MySQL.

## Qué se guarda
Cuentas, perfiles, información y logo del centro, fechas de P1 a P4, estudiantes (con acta, padre y madre), calificaciones y asistencia por sección, comunicados y reportes de errores.

## Actas y récords
En **Datos del centro** completa los *Datos oficiales* (provincia, municipio, distrito, regional, tanda, sector, zona, año escolar, y los nombres del director/a, secretario/a y del Distrito). En **Acta de calificaciones** y **Récord de notas** el sistema llena los documentos con esos datos y con lo registrado de cada estudiante, y se imprimen desde el navegador (Imprimir → Guardar como PDF). En ambos documentos puedes subir el logo del MINERD, cambiar o agregar asignaturas (incluidas las de cada área técnica) y escribir los nombres de las firmas, desde «Editar documento».

## Boletín oficial
En **Calificaciones** los docentes registran por competencias (4 competencias × P1 a P4); el sistema calcula el promedio de cada período (PC1 a PC4) y la calificación final. El **Boletín oficial** (solo administración) se genera por sección con esos datos, con código QR del estudiante, logo del MINERD, docente y firmas editables.

## Código QR
Cada QR abre una página con las calificaciones de ese estudiante (`/b/<clave>`). La clave es aleatoria (32 caracteres) y se crea la primera vez que se genera el QR de un estudiante; no cambia aunque se edite su ficha. Cualquier persona que tenga el QR puede ver las notas de ese estudiante, y la página no muestra datos personales (solo nombre, ID, grado, sección, área y notas). Si el servicio está dormido (plan gratis de Render), el primer escaneo puede tardar hasta un minuto.

## Descargas
Acta de calificaciones, récord de notas, boletín oficial, boletín por estudiante, códigos QR y el listado de estudiantes se pueden **descargar en PDF o en Word** con los botones que aparecen junto a «Imprimir». El PDF necesita conexión a internet (usa una librería externa); si no está disponible, usa Imprimir → Guardar como PDF.

## Pantalla principal
La pantalla de inicio muestra cuatro cuadros tipo post-it: **Misión, Visión, Valores y Lema**. Solo el administrador los escribe (directamente sobre el cuadro, se guardan solos); los demás los ven.

## Permisos (los exige el servidor)
- **Administración:** todo. Administra usuarios y permisos, estudiantes, notas, asistencia, actas, boletines, datos del centro, asignaturas, firmas, logo y períodos.
- **Docentes:** por defecto solo pueden **pasar lista y registrar notas en las secciones que el administrador les asigne**, ver los comunicados, reportar errores y editar su propio perfil. Un docente sin secciones asignadas no ve estudiantes hasta que se las asignen.
- **Consultas que el administrador puede activar a cada docente** (Usuarios y accesos → Permisos), siempre de **solo lectura**:
  - ver la lista completa de estudiantes y sus fichas;
  - ver boletines, códigos QR, boletín oficial, acta de calificaciones y récord de notas.
- **Lo que un docente nunca puede hacer:** registrar, editar o eliminar estudiantes; cambiar datos del centro, asignaturas, firmas, logo, períodos o comunicados; aprobar cuentas o cambiar permisos. Para corregir algo, usa **Reportar un error** y el administrador lo corrige.
- **Apoyo:** ver comunicados y reportar errores.
- Contraseñas cifradas (bcrypt), sesión en cookie protegida, límite de 10 intentos cada 15 minutos. Los permisos se verifican en el servidor en cada solicitud, no solo en la pantalla.

## Límites conocidos
- La verificación anti-robot es una suma firmada por el servidor; frena bots simples.
- Si dos personas guardan la misma sección a la vez, gana el último guardado.
- No envía correos; la clave olvidada se restablece con un código que da el administrador.
- Quien tenga el código QR de un estudiante puede ver sus notas (sin datos personales).
- Un docente con la consulta «lista completa de estudiantes» ve sus datos personales (acta, padre y madre); actívala solo a quien la necesite.
- Al actualizar desde una versión anterior, los docentes quedan sin secciones asignadas hasta que el administrador se las asigne.
