const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BioFlowDocs = require('../flow-documents.js');

const outputDir = path.resolve(__dirname, '../output/pdf/flujo-validacion');
const jsPdfPath = process.argv[2];
if (!jsPdfPath) throw new Error('Indica la ruta local de jspdf.umd.min.js.');
const { jsPDF } = require(path.resolve(jsPdfPath));
fs.mkdirSync(outputDir, { recursive: true });

const date = '29 ago 2026, 12:00', product = { catalog: 'BR-100245', description: 'Bio-Rad - Reactivo de control nivel 1', quantity: 2, unitPrice: 1250, total: 2500 };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const common = { date, status: 'Confirmado', client: 'Hospital de Validacion - Laboratorio Central', supplier: 'Bio-Rad Mexico', currency: 'MXN', items: [product], subtotal: 2500, tax: 400, total: 2900 };
const documents = [
  ['quotation', { ...common, id: 'COT-260829-0001', status: 'Emitida', reference: 'Vigencia 30 dias', related: 'OC-260829-0001', notes: 'Precios congelados. IVA 16%. Pago a 30 dias.' }, '01-cotizacion.pdf'],
  ['client_order', { ...common, id: 'OC-260829-0001', status: 'Activa', reference: 'Cotizacion COT-260829-0001', related: 'COT-260829-0001 - OCP-260829-0001', notes: 'Orden del cliente autorizada para surtido.' }, '02-oc-cliente.pdf'],
  ['supplier_order', { ...common, id: 'OCP-260829-0001', reference: 'OC cliente OC-260829-0001', related: 'COT-260829-0001 - OC-260829-0001', notes: 'Compra confirmada al proveedor por 2 unidades.' }, '03-oc-proveedor.pdf'],
  ['inventory_entry', { id: 'INV-IN-260829-0001', date, status: 'Registrada', client: common.client, supplier: common.supplier, warehouse: 'Almacen 1', reference: 'Recepcion REC-260829-0001', related: 'OCP-260829-0001', items: [{ ...product, unitPrice: null, total: null }], notes: 'Entrada total contra OC a proveedor.' }, '04-entrada-almacen.pdf'],
  ['inventory_exit', { id: 'INV-OUT-260829-0001', date, status: 'Registrada', client: common.client, origin: 'Almacen 1', reference: 'Remision REM-260829-0001', related: 'OC-260829-0001', items: [{ ...product, unitPrice: null, total: null }], notes: 'Salida total para entrega al cliente.' }, '05-salida-almacen.pdf'],
  ['remision', { id: 'REM-260829-0001', date, status: 'Entrega total', client: common.client, origin: 'Almacen 1', reference: 'OC-260829-0001', related: 'INV-OUT-260829-0001', items: [{ ...product, unitPrice: null, total: null }], notes: 'Entrega completa de 2 unidades.' }, '06-remision.pdf'],
  ['audit', { id: 'EXP-OC-260829-0001', date, status: 'Cerrado', client: common.client, supplier: common.supplier, reference: 'COT-260829-0001 - OC-260829-0001', related: 'OCP-260829-0001 - REM-260829-0001', items: [
    { catalog: 'COT-260829-0001', description: 'Cotizacion emitida', quantity: 1 },
    { catalog: 'OC-260829-0001', description: 'OC del cliente activada', quantity: 1 },
    { catalog: 'OCP-260829-0001', description: 'OC a proveedor confirmada', quantity: 1 },
    { catalog: 'INV-IN-260829-0001', description: 'Entrada de almacen registrada', quantity: 2 },
    { catalog: 'INV-OUT-260829-0001', description: 'Salida de almacen registrada', quantity: 2 },
    { catalog: 'REM-260829-0001', description: 'Remision entregada', quantity: 2 }
  ], notes: 'Expediente completo con cadena documental cerrada.' }, '07-expediente.pdf']
];

const result = documents.map(([kind, payload, name]) => {
  payload.auditHash = hash(JSON.stringify({ kind, payload }));
  const doc = BioFlowDocs.create(kind, payload, jsPDF), bytes = Buffer.from(doc.output('arraybuffer'));
  const target = path.join(outputDir, name); fs.writeFileSync(target, bytes);
  return { kind, id: payload.id, file: target, bytes: bytes.length, sha256: hash(bytes) };
});
process.stdout.write(JSON.stringify(result, null, 2));
