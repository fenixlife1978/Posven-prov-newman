# Migración POSVEN PRO → Turso

## Objetivo
Migrar únicamente el proyecto nuevo `posven-pro` a Turso sin tocar el sistema antiguo `posven.vercel.app`.

## Autenticación
Firebase Authentication queda fuera de la migración.

Se crea autenticación propia:
- administrador semilla obligatorio: `admin`
- contraseña semilla: `admin123`
- rol: `administrador`
- contraseña almacenada únicamente como hash
- el administrador puede crear los demás usuarios
- el usuario administrador actual del negocio se registrará nuevamente en Turso con la contraseña actual que conserva el propietario

## Fuentes Firestore/RTDB auditadas
Persistencia operativa detectada:
- productos
- movimientos
- ventas
- cxc
- cxp
- clientes
- proveedores
- devoluciones
- anulaciones
- terminales
- libroDiario
- reportesZ
- caja
- compras
- operaciones (idempotencia)
- auditoriaSistema
- users (perfil, no contraseñas)
- config/general
- catalogos/*
- documentos legacy pos_system_data/state y data/state, si existen
- espejo RTDB pos_system_data/productos

El espejo RTDB no se considerará una fuente independiente hasta comprobar si contiene datos únicos; se conserva durante la fase de respaldo/auditoría.

## Regla de preservación
Cada documento migrado conserva:
1. su ID original;
2. el JSON completo en `data_json`;
3. campos indexados sólo cuando son necesarios para consultas/operaciones.

Esto evita perder campos anidados o campos futuros durante la primera migración.

## Reinicio de fábrica
El reinicio de fábrica debe:
1. limpiar los datos operativos configurables según la política del sistema;
2. revocar sesiones existentes;
3. conservar o recrear el administrador semilla;
4. garantizar nuevamente `admin / admin123 / administrador`;
5. dejar el sistema listo para volver a configurarse.

No se debe depender de Firebase para recuperar el acceso después de un reinicio.

## Secuencia segura
1. Respaldar Firebase completo.
2. Validar el JSON y sus conteos.
3. Importar a SQLite/Turso.
4. Crear/validar administrador semilla.
5. Crear usuario administrador real del propietario.
6. Implementar sesiones propias.
7. Sustituir lecturas/escrituras de Firebase en POSVEN PRO.
8. Probar caja, ventas, inventario, CxC/CxP, pagos, X/Z, recuperación e idempotencia.
9. Sólo después retirar Firebase de POSVEN PRO.
10. Mantener `posven.vercel.app` intacto hasta cerrar la validación.
