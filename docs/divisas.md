# Consulta diaria de divisas

PROBIOLAB consulta una vez por fecha local y vuelve a revisar periódicamente mientras la aplicación permanece abierta.

1. Fuente oficial principal: API SIE de Banco de México. Se consultan las series oportunas SF43718 (dólar estadounidense FIX), SF60632 (dólar canadiense) y SF46410 (euro), expresadas en MXN.
2. Fuente oficial secundaria: API del Banco Central Europeo, series diarias USD, CAD y MXN contra EUR.
3. Tercera fuente: API pública Frankfurter, base EUR y cotizaciones USD, CAD y MXN.
4. Último recurso: captura manual exclusiva del Administrador, con motivo obligatorio.

La consulta SIE requiere que el Administrador registre un token válido de Banco de México en Configuración > Divisas. El token se muestra siempre enmascarado y nunca se copia a los registros cambiarios ni a la bitácora. Si no está configurado o la consulta falla, PROBIOLAB registra el intento y continúa automáticamente con la fuente siguiente.

Las tasas se normalizan como pesos mexicanos por una unidad: MXN = 1, USD = MXN/EUR ÷ USD/EUR, CAD = MXN/EUR ÷ CAD/EUR y EUR = MXN/EUR.

Cada registro conserva fecha de consulta, fecha de los datos, fuente, método, endpoint, usuario y porcentaje de protección. Los fallos de cada fuente también quedan auditados.

Para una conversión de moneda origen a moneda destino se usa:

`precio protegido = precio origen × tasa cruzada ÷ (1 − protección/100)`

Las cotizaciones conservan una instantánea del registro cambiario y cada partida convertida guarda tasa, fuente, fecha, protección e importe protegido. Sin una tasa registrada para el día actual, los productos que necesitan conversión no se habilitan.

Por tratarse de una aplicación local sin servidor, no puede ejecutar trabajos cuando está cerrada. Además, en este prototipo el token queda almacenado localmente en el navegador. En producción la consulta debe ejecutarse mediante un proceso programado de backend, mantener el token como secreto del servidor y persistir los resultados en una base de datos transaccional.
