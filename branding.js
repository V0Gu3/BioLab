(function (root, factory) {
  const brand = factory();
  if (typeof module === 'object' && module.exports) module.exports = brand;
  if (root) root.PROBIOLAB_BRAND = brand;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  return Object.freeze({
    name: 'PROBIOLAB',
    displayName: 'PROBIOLAB',
    documentName: 'PROBIOLAB',
    documentSubtitle: 'CONTROL OPERATIVO Y TRAZABILIDAD',
    legalName: 'Proveedor Biotecnológico para Laboratorios S. de R.L. de C.V.',
    filePrefix: 'probiolab',
    logo: 'assets/probiolab-logo-transparent.png',
    logoPrint: 'assets/probiolab-logo-print-transparent.png'
  });
});
