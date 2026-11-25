const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('incidencia muestra evidencia y bloqueo fuera del plegable y los devuelve al cambiar de tipo', () => {
  const source = fs.readFileSync(require.resolve('../orders.js'), 'utf8');
  const code = source.slice(source.indexOf('  const trackingFieldSlots ='), source.indexOf('  const toggleReceiptFields ='));
  const nodes = new Map();
  function container() {
    return { fields: [], append(field) { if(field.parent)field.parent.fields=field.parent.fields.filter(item=>item!==field);this.fields.push(field);field.parent=this; } };
  }
  const optional = container(), visibleGrid = container();
  optional.querySelectorAll = () => optional.fields.filter(field=>field.input.required).map(field=>field.input);
  optional.before = visible => nodes.set('#trackingRequiredFields', visible);
  nodes.set('#trackingOptionalFields', optional); nodes.set('.order-progress-grid', {});
  const fields = ['orderProgressEvidence','orderProgressBlockers','orderProgressAssignee'].map(id=>{
    const label={innerHTML:''},field={hidden:false,querySelector:()=>label,before(slot){const parent=this.parent;slot.after=field=>parent.append(field)}};
    const input={required:true,closest:()=>field};field.input=input;optional.append(field);nodes.set('#'+id,input);return field;
  });
  const context=vm.createContext({q:selector=>nodes.get(selector),formField:id=>nodes.get('#'+id)?.closest(),document:{createComment:()=>({}),createElement:()=>({querySelector:selector=>selector==='.receipt-extra-grid'?visibleGrid:visibleGrid.fields[0]?.input})}});
  vm.runInContext(code+'\nthis.sync=showRequiredTrackingFields;',context);
  context.sync('tracking');
  assert.equal(optional.fields.length,0);
  assert.equal(visibleGrid.fields.length,3);
  assert.equal(nodes.get('#trackingRequiredFields').hidden,false);
  assert.match(fields[1].querySelector().innerHTML,/obligatorio/);
  fields.forEach(field=>{field.input.required=false});
  context.sync('tracking');
  assert.equal(optional.fields.length,3);
  assert.equal(visibleGrid.fields.length,0);
  assert.equal(nodes.get('#trackingRequiredFields').hidden,true);
  assert.match(fields[1].querySelector().innerHTML,/opcional/);
});
