(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BioInventoryProof = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function validate({ reason, reference, evidence } = {}) {
    if (String(reason || '').trim().length < 8) return 'Describe el motivo con al menos 8 caracteres.';
    if (!String(reference || '').trim()) return 'Captura el folio o referencia del documento de respaldo.';
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(file => !file.hash || !file.id)) return 'Adjunta y conserva al menos una evidencia de respaldo.';
    return '';
  }
  function assertNewMovements(current = [], next = []) {
    const previous = new Set(current.map(item => String(item.id)));
    for (const item of next) {
      if (previous.has(String(item.id))) continue;
      const needsProof = ['salida','merma','traspaso'].includes(item.type) || ['initial_stock','physical_count','manual_adjustment'].includes(item.source) || /^Alta de producto$|^Conteo físico confirmado/.test(item.title || '');
      if (!needsProof) continue;
      const error = validate({ reason: item.reason || item.note, reference: item.reference, evidence: item.evidence });
      if (error) throw Object.assign(new Error(`El movimiento ${item.id || ''} requiere respaldo. ${error}`), { status: 400 });
    }
  }
  return { validate, assertNewMovements };
});
