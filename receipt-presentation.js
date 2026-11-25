(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BioReceiptPresentation=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const number=value=>Number.isFinite(Number(value))?Number(value):0;
  const filename=value=>/\.(?:jpe?g|png|webp|gif|pdf|xlsx?|docx?|csv|eml|msg)$/i.test(String(value||'').trim());
  function reference(receipt){const values=[receipt.reference,receipt.supplierRemission,receipt.supplierInvoiceReference].map(value=>String(value||'').trim()).filter(Boolean);return values.find(value=>!filename(value))||'Folio del proveedor no capturado (registro histórico)';}
  function summary(receipt){const items=receipt.items||[],accepted=items.reduce((sum,item)=>sum+number(item.quantityAccepted??item.quantity),0),rejected=items.reduce((sum,item)=>sum+number(item.quantityRejected),0);return items.length?`Aceptadas ${accepted}, rechazadas ${rejected}`:'Sin partidas vinculadas; requiere revisión histórica';}
  function details(receipt,lines=[],formatDate=value=>value){return (receipt.items||[]).map(item=>{const line=lines.find(line=>String(line.id)===String(item.orderLineId)),accepted=number(item.quantityAccepted??item.quantity),rejected=number(item.quantityRejected);return [line?.catalog||line?.description||'Partida del pedido',(receipt.items||[]).length>1?`${accepted} aceptada${accepted===1?'':'s'}, ${rejected} rechazada${rejected===1?'':'s'}`:'',item.lot?`Lote ${item.lot}`:'',item.serial?`Serie ${item.serial}`:'',item.expiryDate?`Cad. ${formatDate(item.expiryDate)}`:''].filter(Boolean).join(' · ');}).join('; ');}
  function scope(receipts,requestId,lineIds){const ids=new Set([...lineIds].map(String));return receipts.filter(receipt=>!receipt.duplicateOf&&receipt.status!=='duplicate_ignored').flatMap(receipt=>{const original=receipt.items||[],items=original.filter(item=>ids.has(String(item.orderLineId)));return items.length||(!original.length&&String(receipt.requisitionId)===String(requestId))?[{...receipt,items,sharedSupplierOrder:items.length<original.length}]:[];});}
  function auditEntries(entries,receipts){
    const groups=new Map(),seen=new Set();
    for(const entry of entries){if(entry.id&&seen.has(String(entry.id)))continue;if(entry.id)seen.add(String(entry.id));
      const candidates=['receipt','receipt_total','receipt_partial'].includes(entry.action)?receipts.filter(receipt=>String(receipt.receivedAt||'')===String(entry.at||'')&&(receipt.items||[]).some(item=>String(item.orderLineId)===String(entry.entityId))):[];
      const matches=candidates.filter(receipt=>[receipt.id,receipt.reference,receipt.supplierRemission,receipt.supplierInvoiceReference].filter(Boolean).map(String).includes(String(entry.reference||'')));
      const receipt=matches.length===1?matches[0]:candidates.length===1?candidates[0]:null;
      const key=receipt?JSON.stringify(['receipt',receipt.id,entry.at,entry.action,entry.user]):JSON.stringify(['event',entry.id,entry.action,entry.at,entry.entityType,entry.entityId,entry.reference,entry.before,entry.after,entry.notes,entry.receipt]);
      const current=groups.get(key);
      if(current){current.eventIds.push(entry.id);current.relatedLineIds=[...new Set([...current.relatedLineIds,entry.entityId])];if(entry.notes&&!current.notes.includes(entry.notes))current.notes=[current.notes,entry.notes].filter(Boolean).join(' · ');}
      else groups.set(key,{...entry,notes:entry.notes||'',reference:receipt?reference(receipt):entry.reference,eventIds:[entry.id],relatedLineIds:[entry.entityId],...(receipt?{receiptId:receipt.id}:{})});
    }
    return [...groups.values()];
  }
  return {reference,summary,details,scope,auditEntries,filename};
});
