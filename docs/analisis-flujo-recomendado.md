# Análisis del flujo recomendado

Fecha de revisión: 2026-09-01.

## Diagnóstico

Bio ya contaba con cotizaciones con precios congelados, moneda, IVA, tipo de cambio y vigencia; OC de cliente; partidas operativas; OC a proveedor; recepciones y entregas parciales; kardex; remisiones; facturas; permisos; documentos PDF y auditoría. La estructura `supplierOrderLines` ya permitía relacionar una compra con una partida, pero la generación automática creaba una OC distinta por pedido y no aprovechaba esa relación para consolidar varios clientes.

Las brechas de mayor riesgo eran:

- Activar una OC de cliente sin conservar evidencia formal de aceptación.
- Generar compras separadas sin consolidar necesidades compatibles.
- No bloquear ni versionar explícitamente la OC autorizada.
- Tratar la recepción con datos mínimos y sin calidad, lote, serie, caducidad o rechazo.
- No exponer una conciliación de OC, recepción y factura.

## Cambios implementados

1. La activación del pedido exige referencia o archivo de aceptación. Se registran método, folio, archivo, huella, usuario, fecha y observaciones.
2. La cotización conserva versión, estado e historial; al aceptar el cliente se actualiza a `accepted`.
3. Las necesidades se consolidan por proveedor, moneda, almacén, fecha requerida y condiciones de pago.
4. Cada asignación conserva `supplierOrderId`, `requisitionId`, `orderLineId`, cantidad y destino `customer_order` o `stock`.
5. El borrador se presenta como propuesta consolidada. Al autorizar se convierte en OC, queda bloqueado y conserva versión, responsable y fotografía de asignaciones.
6. El PDF de la OC muestra pedidos relacionados y asignación por partida.
7. La recepción ya no exige factura: acepta OC, remisión u otro documento de llegada y marca la factura como pendiente cuando corresponda.
8. La recepción registra almacén, cantidad aceptada y rechazada, lote, serie, caducidad, calidad, inspección y evidencias.
9. El movimiento de inventario diferencia disponible y cuarentena; únicamente la cantidad aceptada genera entrada.
10. La conciliación de tres vías informa cantidades e importes solicitados, recibidos y facturados, pendientes y diferencias por revisar.
11. El surtido admite una combinación de inventario y compra: para una solicitud de 15 con 5 piezas libres, se reservan 5 y la OC al proveedor se genera únicamente por las 10 faltantes.
12. Las reservas se asignan por Almacén 01 o 02, descuentan compromisos anteriores y las salidas generan movimientos separados cuando interviene más de un almacén.

## Compatibilidad

Los nuevos campos viven dentro del `payload_json` que ya persiste PostgreSQL, por lo que no requieren una migración destructiva. Las tablas materializadas conservan sus columnas actuales y el contenido completo permanece disponible en JSONB. Las OC históricas sin `locked` o `version` se muestran como versión 1 y bloqueadas cuando ya no están en borrador.

## Pendientes reales por etapa

- Editor formal de nuevas versiones de cotización y OC bloqueada, con comparación entre versiones.
- Pantalla para aprobar, rechazar, cambiar proveedor o ajustar cantidades dentro de la propuesta antes de emitirla.
- Liberación de calidad posterior para mover existencias de cuarentena a disponible mediante kardex.
- Registro específico de factura del proveedor y tablero detallado de diferencias de precio, IVA y cantidad.
- Devoluciones, reposiciones y notas de crédito.
- Cierre logístico y cierre administrativo separados.
- Cobranza, únicamente si Bio incorporará finanzas.
- Autenticación y autorización obligatoria en servidor antes del uso multiusuario en producción.

Estos pendientes no bloquean el flujo actual cotización → aceptación → pedido → propuesta consolidada → OC proveedor → recepción → inventario → remisión, pero deben implementarse antes de considerar completo el ciclo administrativo y de devoluciones.
