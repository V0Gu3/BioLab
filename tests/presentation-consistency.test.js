const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('el contador cuenta 12 cotizaciones únicas y excluye los 11 pedidos del mismo cliente',()=>{
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8'),start=source.lastIndexOf('function frequentQuotationClients('),end=source.indexOf('\nfunction ',start+1),client={id:'C',name:'Escuela'};
  const quotes=Array.from({length:12},(_,i)=>({id:`Q-${i}`,client:'Escuela'}));
  const context=vm.createContext({clients:[client],quotations:[...quotes,quotes[0]],commercialOrders:Array.from({length:11},(_,i)=>({id:`PI-${i}`,client:'Escuela'})),searchKey:value=>String(value||'').toLowerCase(),canSeeQuotation:()=>true,clientMatchesName:(client,name)=>client.name===name});
  vm.runInContext(source.slice(start,end),context);
  assert.equal(context.frequentQuotationClients('Escuela')[0].uses,12);
});
test('un campo anónimo conserva el identificador de error y el descuento muestra un mensaje claro',()=>{
  const source=fs.readFileSync(require.resolve('../form-validation.js'),'utf8'),context=vm.createContext({escapeId:value=>value,fieldName:()=> 'Descuento'});
  const start=source.indexOf('  const fieldIds'),end=source.indexOf('  const contactKind',start);
  const messageStart=source.indexOf('  function messageFor'),messageEnd=source.indexOf('  function clearFieldError',messageStart);
  vm.runInContext(source.slice(start,end)+source.slice(messageStart,messageEnd)+'\nthis.idFor=errorId;',context);
  const field={id:'',name:'',validity:{rangeOverflow:true},dataset:{field:'discount'},max:'100',getAttribute:()=> 'Descuento porcentual (%)'};
  assert.equal(context.idFor(field),context.idFor(field));
  assert.notEqual(context.idFor(field),context.idFor({...field}));
  assert.equal(context.messageFor(field),'El descuento no puede superar el 100%.');
  context.fieldName=()=> 'Vigencia';
  assert.equal(context.messageFor({...field,id:'quotationValidity',dataset:{},max:'365',type:'number',getAttribute:()=> 'Vigencia'}),'Vigencia supera el máximo permitido: 365 días.');
});
test('la auditoría usa el mismo nombre español que el expediente',()=>{
  const source=fs.readFileSync(require.resolve('../orders.js'),'utf8'),start=source.indexOf('  const auditActionLabel ='),end=source.indexOf('  window.BioOrderLabels',start),context=vm.createContext({});
  vm.runInContext(source.slice(start,end)+'\nthis.label=auditActionLabel;',context);
  assert.equal(context.label('tracking_incident'),'Incidencia registrada');
});
