const axios = require('axios');

const baseURL = (process.env.YOUMED_BASE_URL || '').replace(/\/+$/, '');
const username = process.env.YOUMED_USERNAME || 'youmed';
const password = process.env.YOUMED_PASSWORD || 'youmed';

let tokenCache = null;

function requireBaseUrl() {
  if (!baseURL) {
    throw new Error('YOUMED_BASE_URL is not configured');
  }
}

async function getToken() {
  requireBaseUrl();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    username,
    password,
    grant_type: 'password',
  });

  const response = await axios.post(`${baseURL}/api/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  const accessToken = response.data && response.data.access_token;
  if (!accessToken) {
    throw new Error('Youmed token response missing access_token');
  }

  const expiresIn = Number(response.data.expires_in || 3600);
  tokenCache = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return accessToken;
}

async function request(method, path, data, params) {
  const accessToken = await getToken();
  const response = await axios({
    method,
    url: `${baseURL}${path}`,
    data,
    params,
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

async function getServices() {
  return request('GET', '/api/youmed/danhsachdichvu');
}

async function getPatient({ mayte = '', cccd = '' }) {
  return request('GET', '/api/youmed/ThongTinBenhNhan', null, { mayte, cccd });
}

async function checkAppointment(payload) {
  return request('POST', '/api/youmed/checkdatkham', payload);
}

async function bookAppointment(payload) {
  return request('POST', '/api/youmed/DatKham', payload);
}

async function createPatient(payload) {
  return request('POST', '/api/youmed/TaoBenhNhan', payload);
}

module.exports = {
  getServices,
  getPatient,
  checkAppointment,
  bookAppointment,
  createPatient,
};
