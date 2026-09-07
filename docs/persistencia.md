# Persistencia central de PROBIOLAB

## Diagnóstico de la arquitectura anterior

PROBIOLAB era una aplicación estática. Sus módulos compartían estructuras mediante `localStorage`; los archivos de cotizaciones usaban IndexedDB y no existían servidor, base central ni API. Esto permitía probar el flujo en un solo navegador, pero no compartir información entre equipos ni garantizar respaldos centralizados.

## Arquitectura implementada

La aplicación se sirve ahora desde un proceso Node.js que expone la interfaz y una API REST. PostgreSQL es la fuente central y utiliza transacciones, claves foráneas, JSONB, índices normalizados y un pool de conexiones.

La capa `persistence.js` conserva temporalmente el contrato de `localStorage` de las pantallas existentes:

1. Al abrir PROBIOLAB consulta `/api/bootstrap`.
2. Si la base está vacía, migra el estado existente del navegador mediante `/api/import-local`.
3. Si la base contiene información, hidrata el navegador con el estado central.
4. Cada escritura operativa se sincroniza con `/api/state/:key`.
5. La API reconstruye las tablas normalizadas dentro de la misma transacción.

La sesión seleccionada y el token de Banco de México permanecen locales y no se incorporan al snapshot compartido.

## Entidades materializadas

- Usuarios y perfiles.
- Productos y proveedores.
- Movimientos de inventario.
- Cotizaciones y partidas.
- Órdenes de compra de clientes y partidas.
- Requisiciones y partidas operativas.
- Órdenes y partidas de proveedores.
- Facturas de proveedor.
- Recepciones.
- Facturas de cliente.
- Remisiones.
- Cargas de precios.
- Registros de divisas.
- Documentos relacionados.
- Eventos de auditoría.

El JSON original se conserva en cada entidad para mantener compatibilidad y evitar pérdida de campos durante esta etapa.

## API disponible

- `GET /api/health`
- `GET /api/bootstrap`
- `POST /api/import-local`
- `PUT /api/state/:key`
- `GET /api/products`
- `GET /api/suppliers`
- `GET /api/movements`
- `GET /api/quotations`
- `GET /api/client-orders`
- `GET /api/requisitions`
- `GET /api/supplier-orders`
- `GET /api/receipts`
- `GET /api/shipments`
- `GET /api/documents`
- `GET /api/audit?limit=500`

## Migración

`server/schema.sql` es la migración PostgreSQL inicial y registra la versión 1 en `schema_migrations`. Las tablas se crean automáticamente al iniciar contra una base vacía.

La migración desde el navegador es idempotente por clave de estado: las claves se actualizan con una revisión consecutiva y la materialización se ejecuta en una transacción completa.

Para migrar el archivo SQLite generado durante la etapa anterior:

1. Configura `DATABASE_URL` en `.env`.
2. Conserva `data/bio.db` como respaldo.
3. Ejecuta `npm run migrate:sqlite`.
4. Verifica que `importedKeys` y `verifiedKeys` coincidan.
5. Inicia PROBIOLAB con `npm start` y revisa Auditoría.

## Decisiones técnicas

- PostgreSQL permite concurrencia real, respaldos centralizados y crecimiento multiusuario.
- Se utiliza el controlador `pg` con pool de conexiones.
- `JSONB` conserva temporalmente el contrato anterior sin perder campos, mientras las columnas operativas permanecen normalizadas.
- El servidor se limita por defecto a `127.0.0.1`; no queda expuesto a la red local.
- La compatibilidad con `localStorage` permite migrar cada módulo a CRUD REST sin detener el desarrollo de la interfaz.
- Los documentos financieros y operativos se conservan como registros y no se eliminan físicamente desde esta API.

## Riesgos y siguiente etapa

La sincronización de compatibilidad actual trabaja por conjuntos completos y usa la última revisión recibida. Antes de habilitar varios usuarios simultáneos deben migrarse las escrituras de cada pantalla a endpoints CRUD por entidad y agregar control de concurrencia optimista.

La autenticación y autorización del servidor corresponden al siguiente punto del plan. Actualmente los permisos siguen aplicándose en la interfaz; la API escucha únicamente en el equipo local.

Los binarios adjuntos almacenados en IndexedDB todavía deben trasladarse a almacenamiento documental administrado; sus metadatos y relaciones ya están modelados en `documents`.
