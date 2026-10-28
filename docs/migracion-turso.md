# PosVEN Pro — Turso como única base de datos

## Arquitectura objetivo

- Turso/libSQL es la única base de datos operativa y la fuente de verdad.
- El navegador nunca recibe `TURSO_DATABASE_URL` ni `TURSO_AUTH_TOKEN`; ambos secretos se leen exclusivamente en el servidor.
- La interfaz consulta las rutas de servidor `/api/auth/*` y `/api/turso/*`.
- `localStorage` y la cola offline sirven como caché/cola de reintentos; no son una base de datos autoritativa.
- La antigua compatibilidad de lecturas en tiempo real redirige a los mismos registros Turso; no mantiene Firebase Realtime Database como espejo independiente.

## Variables de Vercel

Variables necesarias en el entorno **Production** y en cualquier entorno de prueba que se utilice:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

No crear variables `NEXT_PUBLIC_TURSO_*`: las credenciales no deben incorporarse al bundle del navegador. Los endpoints devuelven datos de negocio, nunca el token.

## Autenticación

- Las sesiones se almacenan en Turso y se transportan mediante la cookie HTTP-only `posven_session`.
- Las contraseñas se almacenan mediante hash scrypt con salt aleatorio; no se guarda la contraseña en texto plano.
- En una base nueva, el primer arranque crea el administrador semilla `admin` con contraseña inicial `admin123`. Cambiarla desde un flujo seguro de administración antes de uso operativo.
- El usuario semilla no puede eliminarse ni degradarse desde la API.
- La lista de usuarios está restringida al rol administrador.

## Tablas inicializadas por la aplicación

- `app_config`: configuración general.
- `catalogos`: listas de catálogos.
- `pos_records`: registros operativos por colección e identificador, conservando el objeto JSON completo.
- `users` y `sessions`: cuentas y sesiones propias.
- `operaciones`: identificadores idempotentes de operaciones.
- `auditoria_sistema`: eventos de auditoría.

El esquema `src/lib/turso/schema.sql` conserva el modelo detallado y las tablas relacionales auxiliares para ampliar consultas sin perder el JSON original.

## Migración de datos existentes

Retirar Firebase del código no importa automáticamente los datos históricos que estén en un proyecto Firebase. Antes de poner esta rama en producción, exportar y validar el respaldo existente y después importarlo a Turso. Comparar conteos, identificadores, totales de inventario, saldos de CxC/CxP, cajas abiertas, ventas y cortes Z. No borrar la base histórica hasta terminar esa reconciliación.

## Validaciones antes de producción

1. Compilación de Next.js con las rutas API habilitadas.
2. Login, cierre de sesión, expiración y revocación de sesión.
3. Alta/edición/bloqueo de usuarios y protección del administrador semilla.
4. Lectura/escritura y sincronización de inventario, ventas, caja, CxC/CxP, devoluciones, anulaciones, compras, libro diario y reportes Z.
5. Pruebas de atomicidad e idempotencia para operaciones financieras y actualización de existencias.
6. Pruebas de interrupción de internet, cola offline y sincronización posterior sin duplicados.
7. Importación de respaldo y conciliación de conteos/saldos.
8. Confirmación del despliegue correcto en Vercel antes de promover esta rama.

## Nota sobre escritorio

La aplicación web ahora requiere rutas de servidor para usar Turso de forma segura. El instalador Electron basado en exportación HTML estática no puede usar directamente estas rutas; su empaquetado debe conectarse al despliegue web autenticado o a un backend seguro. No publicar un instalador estático que no pueda llegar a la API.
