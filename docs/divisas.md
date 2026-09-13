# Consulta diaria de divisas

PROBIOLAB usa la fecha operativa de `America/Mexico_City`, no la fecha del navegador. Cada inicio de día requiere una actualización confirmada para USD, CAD y EUR; MXN permanece como moneda base.

1. Fuente oficial principal: API SIE de Banco de México. Se consultan las series oportunas SF43718 (dólar estadounidense FIX), SF60632 (dólar canadiense) y SF46410 (euro), expresadas en MXN.
2. Fuente oficial secundaria: API del Banco Central Europeo, series diarias USD, CAD y MXN contra EUR.
3. Tercera fuente: API pública Frankfurter, base EUR y cotizaciones USD, CAD y MXN.
4. Último recurso: captura manual exclusiva del Administrador, con motivo obligatorio.

La consulta SIE requiere que el Administrador registre un token válido de Banco de México en Configuración > Divisas. El token se muestra siempre enmascarado y nunca se copia a los registros cambiarios ni a la bitácora. Si no está configurado o la consulta falla, PROBIOLAB registra el intento y continúa automáticamente con la fuente siguiente.

Las tasas se normalizan como pesos mexicanos por una unidad: MXN = 1, USD = MXN/EUR ÷ USD/EUR, CAD = MXN/EUR ÷ CAD/EUR y EUR = MXN/EUR.

Al primer acceso administrativo sin una actualización confirmada, se presenta un modal con la propuesta consultada, el último valor validado, fuente, evidencia, observaciones y los tres valores por confirmar. El mismo día se actualiza el registro existente en lugar de crear duplicados. Cada confirmación conserva fecha operativa, fecha y hora de captura, usuario, fuente, evidencia, observaciones, valor anterior, estado de validación y alerta de variaciones atípicas.

Si todavía no existe una actualización del día, el vendedor recibe una advertencia no bloqueante y se utiliza el último registro validado. La cotización conserva ese uso de contingencia en su snapshot y en la auditoría. El vendedor no puede actualizar divisas ni ve el precio de lista dentro del buscador de cotizaciones.

Para una conversión de moneda origen a moneda destino se usa:

`precio protegido = precio origen × tasa cruzada ÷ (1 − protección/100)`

Las cotizaciones conservan una instantánea del registro cambiario: divisas aplicadas, fecha operativa, fuente, usuario/proceso, protección y si se utilizó un valor del día anterior. Una actualización posterior nunca recalcula una cotización histórica. La regla comercial permanece sin cambios: precio de venta más protección cambiaria produce el precio final cotizado.

Por tratarse de una aplicación local sin servidor, no puede ejecutar trabajos cuando está cerrada. Además, en este prototipo el token queda almacenado localmente en el navegador. En producción la consulta debe ejecutarse mediante un proceso programado de backend, mantener el token como secreto del servidor y persistir los resultados en una base de datos transaccional.
