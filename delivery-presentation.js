(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BioDeliveryPresentation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const zone='America/Mexico_City',n=value=>Number.isFinite(Number(value))?Number(value):0;
  function day(value){const date=new Date(value);if(Number.isNaN(date.getTime()))return '';const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(key=>parts.find(part=>part.type===key).value).join('-');}
  function format(value){if(!value)return 'Sin fecha';const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(String(value)),date=new Date(dateOnly?`${value}T12:00:00-06:00`:value);if(Number.isNaN(date.getTime()))return 'Sin fecha';return date.toLocaleString('es-MX',{timeZone:zone,dateStyle:'medium',...(dateOnly?{}:{timeStyle:'short'})});}
  function dateLabel(shipment){const calendar=shipment.date;if(calendar&&/^\d{4}-\d{2}-\d{2}$/.test(calendar))return format(shipment.deliveredAt&&day(shipment.deliveredAt)===calendar?shipment.deliveredAt:calendar);return format(calendar||shipment.deliveredAt);}
  function isComplete(shipment,lines=[],shipments=[]){
    const required=lines.filter(line=>Math.max(0,n(line.quantityRequested)-n(line.quantityCancelled))>0);
    if(!required.length)return shipment.type==='total';
    const rows=shipments.filter(row=>row.requisitionId===shipment.requisitionId&&!['cancelled','duplicate_ignored'].includes(row.status)&&!row.duplicateOf).slice().sort((a,b)=>String(a.deliveredAt||a.date||'').localeCompare(String(b.deliveredAt||b.date||'')));
    const delivered=new Map(),seen=new Set();let found=false;
    for(const row of rows){if(seen.has(String(row.id)))continue;seen.add(String(row.id));for(const item of row.items||[])delivered.set(String(item.orderLineId),(delivered.get(String(item.orderLineId))||0)+Math.max(0,n(item.quantity)));if(String(row.id)===String(shipment.id)){found=true;break;}}
    return found?required.every(line=>(delivered.get(String(line.id))||0)>=Math.max(0,n(line.quantityRequested)-n(line.quantityCancelled))):shipment.type==='total';
  }
  function label(shipment,lines,shipments){return isComplete(shipment,lines,shipments)?'Entrega completa':'Entrega parcial';}
  function progress(lines=[]){return lines.reduce((result,line)=>{const authorized=Math.max(0,n(line.quantityRequested)-n(line.quantityCancelled)),actual=Math.max(0,n(line.quantityDelivered));result.requested+=authorized;result.delivered+=Math.min(authorized,actual);result.overDelivered+=Math.max(0,actual-authorized);return result;},{requested:0,delivered:0,overDelivered:0});}
  return {format,dateLabel,isComplete,label,day,progress};
});
