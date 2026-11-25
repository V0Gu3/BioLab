const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
function loadFunctions(names,extra={}){const context=vm.createContext({roundQuotationMoney:value=>Math.round(value*100)/100,searchKey:value=>String(value||'').toLowerCase(),...extra});for(const name of names){const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);vm.runInContext(source.slice(start,end),context);}return context;}
test('cotizar USD en USD conserva 84.27 y la protección solo se pide al convertir moneda',()=>{
  let conversions=0;const context=loadFunctions(['quotationProductPrice'],{$:()=>({value:'USD'}),window:{BioFX:{protectedPrice(){conversions++;return {unitPrice:1776.96,protectionPercent:10}}}}});
  assert.equal(context.quotationProductPrice({sourceCurrency:'USD',sourcePrice:84.27},'USD').unitPrice,84.27);
  assert.equal(context.quotationProductPrice({sourceCurrency:'USD',sourcePrice:84.27},'USD').protectionPercent,0);
  assert.equal(conversions,0);
  assert.equal(context.quotationProductPrice({sourceCurrency:'USD',sourcePrice:84.27},'MXN').protectionPercent,10);
  assert.equal(conversions,1);
});
test('el resumen exportado distingue USD/USD de la tasa informativa USD/MXN',()=>{
  const context=loadFunctions(['quotationFxSummary']);
  const quote={exchangeRate:19.1648,exchangeProtection:10,items:[{sourceCurrency:'USD',currency:'USD',fx:{rate:1,protectionPercent:0}}]};
  assert.equal(context.quotationFxSummary(quote),'USD: sin conversión de moneda · Protección aplicada 0%');
  assert.equal(quote.exchangeRate,19.1648);
});
test('el buscador encuentra OC, remisión y documento del proveedor usando el estado cargado',()=>{
  const state={supplierOrders:[{id:'OCP-261123-0001'}],shipments:[{id:'S',folio:'REM-261123-0001',requisitionId:'PI'}],receipts:[{id:'R',reference:'QA-REM-C7-001',requisitionId:'PI'}],orderLines:[{requisitionId:'PI',quantityRequested:1,quantityDelivered:1}]};
  const context=loadFunctions(['operationalGlobalResults','globalOrderState'],{localStorage:{getItem:()=>JSON.stringify(state)},window:{BioAccess:{can:()=>true},BioDeliveryPresentation:require('../delivery-presentation')}});
  assert.equal(context.operationalGlobalResults('ocp-261123')[0].view,'supplierOrdersView');
  assert.equal(context.operationalGlobalResults('rem-261123')[0].query,'PI');
  assert.equal(context.operationalGlobalResults('qa-rem-c7')[0].query,'PI');
  assert.equal(context.globalOrderState({id:'PI',status:'active'}),'Entregado');
});
