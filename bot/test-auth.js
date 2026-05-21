const axios = require('axios');
async function testAuth() {
  try {
    const res = await axios.post('http://localhost:3000/auth/sign_in', {
      email: 'huudien111@gmail.com',
      password: 'Admin@123456'
    });
    console.log('Success:', res.status, res.headers['access-token']);
  } catch (err) {
    console.error('Failed:', err.response ? err.response.status : err.message);
  }
}
testAuth();
