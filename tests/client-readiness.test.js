const test=require('node:test');
const assert=require('node:assert/strict');
const policy=require('../client-readiness');
const seller={id:'V1',role:'seller',status:'active'};
test('un cliente sin vendedor queda pendiente y un administrador no cuenta como vendedor',()=>{
  assert.equal(policy.issue({name:'Cliente'},[]),policy.message);
  assert.equal(policy.issue({ownerId:'A'},[{id:'A',role:'administrator',status:'active'}]),policy.message);
  assert.equal(policy.issue({ownerId:'V1'},[{...seller,status:'inactive'}]),policy.message);
  assert.equal(policy.issue({ownerId:'V1'},[seller]),'');
});
test('solo bloquea nuevas cotizaciones; asignar vendedor permite emitir y el RFC es opcional',()=>{
  const client={id:'C',name:'Escuela',rfc:'',ownerId:''},quote={id:'Q',clientId:'C'};
  assert.throws(()=>policy.assertNewQuotations([], [quote], [client], [seller]),error=>error.status===409);
  assert.doesNotThrow(()=>policy.assertNewQuotations([quote], [quote], [client], [seller]));
  assert.doesNotThrow(()=>policy.assertNewQuotations([], [quote], [{...client,ownerId:'V1'}], [seller]));
  assert.throws(()=>policy.assertNewQuotations([], [quote], [{...client,ownerId:'V1',blocked:true}], [seller]));
});
