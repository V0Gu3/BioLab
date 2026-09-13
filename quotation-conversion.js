(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.BioQuotationConversion=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  const validDate=value=>{const date=new Date(value);return !Number.isNaN(date.getTime())?date:null};
  const itemIsComplete=item=>Number(item?.quantity)>0&&Number.isFinite(Number(item?.unitPrice))&&Number(item?.unitPrice)>=0;
  const check=(state,code,message,section,action,role,fix)=>({state,code,message,section,action,role,fix});
  function assess(quotation,{canConvert=true,now=new Date()}={}){
    const checks=[];
    if(!quotation)return {ok:false,checks:[check('blocking','quotation_missing','No se encontró la cotización seleccionada.','Historial de cotizaciones','Actualiza el historial e inténtalo de nuevo.',null,'refresh')]};
    if(!canConvert)checks.push(check('blocking','permission_denied','No tienes permiso para convertir esta cotización. Solicita autorización a un supervisor o administrador.','Permisos','Solicita el permiso “Convertir cotizaciones en OC”.','Supervisor o administrador'));
    if(quotation.status==='cancelled')checks.push(check('blocking','quotation_cancelled','La cotización está cancelada y no puede convertirse.','Historial de cotizaciones','Genera una nueva cotización si la operación continúa.',null,'new'));
    if(quotation.commercialOrderId)checks.push(check('blocking','already_converted',`La cotización ya fue convertida a la OC ${quotation.commercialOrderId}.`,'OC de clientes','Abre la OC vinculada para continuar el flujo.',null,'order'));
    const expires=validDate(quotation.expiresAtISO);
    if(!quotation.commercialOrderId&&(!expires||expires.getTime()<now.getTime()))checks.push(check('blocking','quotation_expired',`La cotización venció el ${quotation.expiresAt||'día registrado'}. Actualiza la vigencia o genera una nueva versión.`,'Vigencia','Genera una nueva cotización con vigencia vigente.',null,'new'));
    const items=Array.isArray(quotation.items)?quotation.items:[];
    if(!items.length)checks.push(check('blocking','missing_items','La cotización no tiene productos para convertir.','Productos','Agrega al menos una partida con cantidad y precio válidos.',null,'new'));
    const invalidItems=items.filter(item=>!itemIsComplete(item));
    if(invalidItems.length)checks.push(check('blocking','invalid_items',`Hay ${invalidItems.length} partida${invalidItems.length===1?'':'s'} sin cantidad o precio válido.`,`Productos y condiciones`,`Corrige las partidas incompletas antes de emitir una nueva versión.`,null,'new'));
    if(!String(quotation.client||'').trim())checks.push(check('blocking','missing_client','Falta el cliente de la cotización.','Datos comerciales','Completa el cliente antes de emitir una nueva versión.',null,'new'));
    const identity=[quotation.contact,quotation.email,quotation.phone].filter(value=>String(value||'').trim());
    if(!identity.length)checks.push(check('warning','client_contact_missing','El cliente no tiene datos de contacto en esta cotización. La conversión es posible, pero conviene completar el expediente comercial.','Clientes','Abrir cliente para complementar los datos.',null,'clients'));
    if(!quotation.acceptance)checks.push(check('warning','acceptance_pending','La aceptación del cliente todavía no está registrada. Podrás capturar la OC, cotización firmada, correo o depósito antes de activar el pedido.','OC de clientes','Continuar a la OC generada y registrar la aceptación.',null,'acceptance'));
    if(!checks.some(item=>item.state==='blocking'))checks.unshift(check('correct','ready','Cotización vigente, con cliente y partidas válidas para generar la OC.','Conversión','Puedes generar la orden de compra del cliente.'));
    return {ok:!checks.some(item=>item.state==='blocking'),checks};
  }
  return {assess};
});
