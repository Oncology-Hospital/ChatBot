const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function testAuth() {
  const baseUrl = cleanBaseUrl(
    process.env.CHATWOOT_AUTH_URL
    || process.env.CHATWOOT_URL
    || process.env.CHATWOOT_API_URL
    || process.env.FRONTEND_URL
    || 'http://localhost:3000'
  );
  const email = process.env.TEST_CHATWOOT_EMAIL;
  const password = process.env.TEST_CHATWOOT_PASSWORD;

  if (!email || !password) {
    console.error('Set TEST_CHATWOOT_EMAIL and TEST_CHATWOOT_PASSWORD in .env to run this test.');
    process.exitCode = 1;
    return;
  }

  try {
    const res = await axios.post(`${baseUrl}/auth/sign_in`, { email, password });
    console.log('Success:', res.status, res.headers['access-token']);
  } catch (err) {
    console.error('Failed:', err.response ? err.response.status : err.message);
  }
}
testAuth();
