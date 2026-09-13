'use strict';
const { createApp } = require('../server/server');

let application;
module.exports = async (request, response) => {
  application ||= await createApp();
  application.emit('request', request, response);
};
