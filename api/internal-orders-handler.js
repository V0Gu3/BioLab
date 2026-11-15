'use strict';

const handler = require('./_handler');

module.exports = (request, response) => {
  const url = new URL(request.url || '/api/internal-orders', 'http://localhost');
  const forwardedPath = String(url.searchParams.get('__forward_path') || '').replace(/^\/+/, '');
  const nestedPath = String(url.searchParams.get('__internal_path') || '').replace(/^\/+/, '');
  url.searchParams.delete('__forward_path');
  url.searchParams.delete('__internal_path');
  request.url = forwardedPath
    ? `/api/${forwardedPath}${url.search}`
    : `/api/internal-orders${nestedPath ? `/${nestedPath}` : ''}${url.search}`;
  return handler(request, response);
};
