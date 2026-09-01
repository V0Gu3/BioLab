# Flujo operativo de pedidos en Bio

## 1. Arquitectura encontrada

Bio es una aplicación web de una sola página construida con HTML, CSS y JavaScript sin framework. La interfaz conserva un modo local en `localStorage` e IndexedDB, y el proyecto ya incluye una API REST y persistencia PostgreSQL preparada para ejecución local. SheetJS procesa archivos Excel y jsPDF genera comprobantes. La autorización actual se aplica en interfaz; la autenticación de servidor sigue siendo una etapa pendiente antes de producción.

Se reutilizaron:

- Catálogos actuales de productos y proveedores.
- Cotizaciones y órdenes comerciales derivadas.
- Movimientos de inventario y patrón de bitácora.
- Búsqueda predictiva y filtros en tiempo real.
- Modales de confirmación con fondo integrado.
- Lectura de libros con varias hojas.
- Generación de PDF.

## 2. Modelo implementado

La clave versionada `nexo-order-operations-v1` separa estas colecciones:

- `requisitions`: requisiciones de cliente o abastecimiento interno de stock.
- `orderLines`: partidas con cantidades solicitadas, compradas, recibidas, entregadas, facturadas y canceladas.
- `supplierOrders` y `supplierOrderLines`: órdenes de compra a proveedor y relación con una o varias requisiciones.
- `supplierInvoices`: facturas de proveedor, moneda, tasa histórica, fecha de tasa y total MXN.
- `receipts`: recepciones parciales o totales.
- `inventoryReservations`: reservas por pedido.
- `inventoryMovements`: entradas de stock con documento de origen y conciliación de producto.
- `customerInvoices`: facturas normales o cargos a manejo de cuenta.
- `shipments`: remisiones y entregas.
- `auditLog`: usuario, fecha, operación, valor anterior, valor nuevo, referencia y permiso especial.
- `imports`: huella del archivo, huellas por fila y resumen de cada importación.

La persistencia usa una clave temporal de transacción y recuperación para evitar dejar una importación aplicada parcialmente.

## 3. Flujo funcional

El flujo operativo visible queda limitado a esta cadena:

1. Emitir la cotización con productos y precios congelados.
2. Preparar el pedido de venta y activarlo únicamente después de registrar evidencia de aceptación: OC del cliente, cotización firmada, correo o anticipo.
3. Consolidar necesidades compatibles en propuestas de compra por proveedor, moneda, almacén, fecha requerida y condiciones de pago. La tabla `supplierOrderLines` conserva pedido, partida y cantidad asignada.
4. Autorizar la propuesta. La OC a proveedor emitida queda bloqueada con versión, responsable y fotografía auditable; cualquier cambio posterior deberá originar una nueva versión.
5. Registrar la recepción física contra OC y remisión del proveedor, aunque la factura todavía no exista. Lote, serie, caducidad, rechazo, calidad, evidencia y almacén quedan separados.
6. Conciliar OC a proveedor, recepción y factura cuando estén disponibles.
7. Registrar la salida contra pedido y entrega.
8. Generar la remisión, parcial o total, ligada a la salida.

Las cotizaciones convertidas se sincronizan automáticamente con el seguimiento operativo sin volver a capturar cliente ni partidas. El expediente muestra cotización, OC del cliente, OC a proveedor, entradas, salidas y remisiones en una sola cadena auditable.

Las OC a proveedor tienen un módulo propio dentro de Pedidos. Al activarse pedidos compatibles, sus partidas se agrupan usando la relación del catálogo de productos. Cada grupo produce una propuesta `OCP-AAMMDD-0001`; al autorizarla se convierte en OC bloqueada y las cantidades pasan a pendientes de recepción. Los artículos sin proveedor quedan en una alerta y no generan documentos incompletos.

La conciliación de tres vías devuelve cantidades e importes solicitados, recibidos y facturados, saldos pendientes y un estado `pending`, `matched` o `review`. Una recepción con remisión y sin factura queda como `pending_invoice`, no se bloquea ni se confunde con la factura posterior.

Las cantidades superiores a las autorizadas se bloquean. Un administrador puede registrar un excedente explícito; la excepción queda en la bitácora.

## 4. Análisis legado de `PEDIDOS PROBIOLAB 2026.xlsx`

La importación no forma parte del menú ni del flujo operativo. El simulador se conserva únicamente como herramienta interna de análisis para una migración futura controlada; no se ejecutó una carga definitiva. La hoja `SURTIR` usa las primeras 23 columnas operativas; X, Y y Z quedan fuera.

Transformaciones relevantes:

- `STOCK` crea una requisición interna sin cliente ficticio.
- `DEPOSITO` se convierte en modalidad de compra y genera advertencia si falta el proveedor real.
- `CANCELADO` se convierte en estado formal con motivo legado pendiente de validar.
- Textos `CARGO`, `CARGAR`, `DESCARGO` o `MC` se separan en tipo de facturación, referencia y observación.
- Fechas textuales o numéricas inválidas generan advertencia.
- Folios y catálogos se conservan como texto.
- La hoja `CALCULO USD X MX` se usa únicamente cuando su OC coincide; nunca se inventa una tasa.
- Cada fila conserva contenido original, hoja, número de fila, huella del archivo y huella de fila.
- Filas repetidas dentro del mismo archivo o en una importación posterior se marcan duplicadas.

Resultado de la simulación real, sin guardar en Bio:

- 867 filas analizadas.
- 512 listas.
- 350 con advertencias.
- 3 rechazadas.
- 2 duplicadas exactas.
- 296 requisiciones resultantes.
- 862 partidas aceptables.
- 392 órdenes de proveedor.
- 366 facturas de proveedor.
- 126 facturas USD sin tasa coincidente; permanecen pendientes de completar.

## 5. Estados y permisos

Los estados son valores controlados en código: borrador, confirmado, en compra, parcial o totalmente comprado/recibido/entregado/facturado, reservado, listo para entregar, cerrado y cancelado.

Se implementó una matriz mínima de permisos para consulta, captura, compras, recepción, inventario, facturación, entregas, cancelación y administración. Como Bio no tiene autenticación, el usuario actual continúa siendo el usuario fijo de la interfaz. La seguridad real requiere backend.

## 6. Base de datos, migraciones y API

El proyecto incluye persistencia PostgreSQL, migración del estado local y API REST. Los nuevos campos se agregan de forma compatible al documento operacional actual; antes de producción todavía se requiere:

- API autenticada y control transaccional multiusuario para autorizaciones y recepciones concurrentes.
- Base de datos con claves foráneas, índices únicos de folio y control de concurrencia.
- Almacenamiento documental seguro.
- Catálogos normalizados de clientes, instituciones, contactos y marcas.
- Migración versionada desde `nexo-order-operations-v1`.
- Autorización por usuario y registro de sesión.

## 7. Riesgos y pendientes

- `localStorage` no es multiusuario, no resuelve concurrencia y puede borrarse desde el navegador.
- Las tasas históricas faltantes deben capturarse y validarse; no deben completarse automáticamente.
- Las recepciones y entregas heredadas se infieren por fechas/remisiones y deben revisarse en la simulación.
- Productos importados sin coincidencia exacta quedan con conciliación de inventario pendiente.
- El archivo actual mezcla institución y referencia de OC en algunas celdas; la normalización completa requiere un catálogo maestro aprobado.
- No se ejecutó una importación definitiva del libro proporcionado.

## 8. Pruebas

`tests/orders-core.test.js` cubre cálculos, requisiciones de una y varias partidas, stock, depósito, consolidación de varios pedidos, asignación por origen, conciliación de tres vías, recepción sin factura, avances parciales y totales, cancelación, USD y tasa histórica, manejo de cuenta, cantidades excedidas, idempotencia, datos inválidos y permisos.

`tmp/pedidos-analysis/validate_import.js` ejecuta la simulación completa del libro real y verifica integridad de entidades y huellas sin alterar el almacenamiento de la aplicación.
