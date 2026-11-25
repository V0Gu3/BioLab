(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BioClientReadiness=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const message='Cliente pendiente de activación: asigna un vendedor activo para generar cotizaciones.';
  function sellerFor(client,users=[]){return client?.ownerId?users.find(user=>String(user.id)===String(client.ownerId)&&user.role==='seller'&&user.status==='active'):null;}
  function issue(client,users=[]){if(!client)return 'Primero registra el cliente y asígnale un vendedor activo.';if(client.retired||client.blocked||client.status==='inactive')return 'El cliente no está activo para generar cotizaciones.';return sellerFor(client,users)?'':message;}
  function assertNewQuotations(before=[],next=[],clients=[],users=[]){const prior=new Set(before.map(item=>String(item.id)));for(const quote of next){if(prior.has(String(quote.id)))continue;const client=quote.clientId?clients.find(client=>String(client.id)===String(quote.clientId)):clients.find(client=>String(client.name||'').trim().toLowerCase()===String(quote.client||'').trim().toLowerCase());const error=issue(client,users);if(error)throw Object.assign(new Error(error),{status:409});}}
  return {message,sellerFor,issue,assertNewQuotations};
});
