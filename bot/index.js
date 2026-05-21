const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QAMatcher = require('./matcher');

// ─── Config ───
const PORT = 4000;
const CHATWOOT_URL = process.env.CHATWOOT_URL || (process.env.NODE_ENV === 'production' ? 'https://adminchatbot.dienisme.online' : 'http://localhost:3000');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || 'S4XGRoN3JBvc2aS9nofJKMWX';
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || 1;
const CONFIDENCE_HIGH = 0.5;   // auto-answer (Cosine Similarity)
const CONFIDENCE_MED = 0.3;    // suggest similar questions (Cosine Similarity)
const QA_FILE = path.join(__dirname, 'qa-data.json');

// ─── Load Q&A Data ───
let qaData = JSON.parse(fs.readFileSync(QA_FILE, 'utf-8'));
const matcher = new QAMatcher();
matcher.rebuildIndex(qaData).catch(console.error);

const app = express();
app.use(bodyParser.json());

// Chỉ mở công khai file web test và hình ảnh
app.get('/test-page.html', (req, res) => res.sendFile(path.join(__dirname, 'test-page.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'test-page.html')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Middleware xác thực cho Admin (Đồng bộ Chatwoot) - Xử lý qua JS Frontend
const authCache = new Set();
const auth = async (req, res, next) => {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (!login || !password) {
    return res.status(401).send('Yeu cau dang nhap.');
  }

  // Chống bị văng do Chatwoot giới hạn đăng nhập (Rate limit)
  if (authCache.has(b64auth)) {
    return next();
  }

  try {
    const chatwootRes = await axios.post(`${CHATWOOT_URL}/auth/sign_in`, {
      email: login,
      password: password
    });
    if (chatwootRes.status === 200) {
      authCache.add(b64auth);
      return next();
    }
  } catch (err) {
    return res.status(401).send('Sai tai khoan luon.');
  }
};

// Route mở giao diện quản trị (Đã bỏ xác thực chặn load file HTML, dùng JS tự xác thực)
app.get('/BoCauHoi', (req, res) => res.sendFile(path.join(__dirname, 'BoCauHoi.html')));
app.get('/BoCauHoi.html', (req, res) => res.sendFile(path.join(__dirname, 'BoCauHoi.html')));

// Bảo mật toàn bộ dữ liệu API
app.use('/api/qa', auth);

// ─── Chatwoot API Helper ───
async function sendMessage(conversationId, message) {
  try {
    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: message,
        message_type: 'outgoing',
        private: false
      },
      {
        headers: {
          'api_access_token': CHATWOOT_API_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('Failed to send message:', err.message);
  }
}

async function assignToTeam(conversationId) {
  try {
    // Toggle status to "open" so agents see it
    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      { status: 'open' },
      {
        headers: {
          'api_access_token': CHATWOOT_API_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    // Add a private note for staff
    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: '⚠️ Bot không thể trả lời câu hỏi này. Cần nhân viên hỗ trợ.',
        message_type: 'outgoing',
        private: true
      },
      {
        headers: {
          'api_access_token': CHATWOOT_API_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err) {
    console.error('Failed to assign conversation:', err.message);
  }
}

// ─── Webhook from Chatwoot ───
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  const event = req.body.event;

  // Only process incoming messages from customers
  if (event !== 'message_created') return;

  const message = req.body;
  const msgType = message.message_type;
  const content = message.content;
  const conversationId = message.conversation?.id;

  // message_type: 'incoming' = from customer, 'outgoing' = from agent/bot
  if (msgType !== 'incoming' || !content || !conversationId) return;

  console.log(`\n📨 Received: "${content}" (conv: ${conversationId})`);

  // Check for escalation keywords FIRST
  const escalateKeywords = ['gặp nhân viên', 'nhân viên', 'hỗ trợ', 'agent', 'tư vấn', 'gặp bác sĩ'];
  const isEscalate = escalateKeywords.some(k => content.toLowerCase().includes(k));

  if (isEscalate) {
    console.log('🔄 Escalating to staff...');
    await sendMessage(conversationId, '🔄 Đã liên hệ với nhân viên, vui lòng chờ phản hồi...');
    await assignToTeam(conversationId);
    return;
  }

  // ─── Match against Q&A ───
  const result = await matcher.findBestMatch(content);

  if (result.confidence >= CONFIDENCE_HIGH && result.match) {
    // High confidence → auto-answer with GPT formulation
    console.log(`✅ Match: "${result.match.question}" (confidence: ${result.confidence.toFixed(2)})`);
    
    // Yêu cầu ChatGPT format lại dựa trên data gốc
    const smartOutput = await matcher.smartReply(content, result.match.answer);
    
    const reply = `${smartOutput}\n\n_Câu trả lời có hữu ích không? Nếu không, gõ "gặp nhân viên" để được hỗ trợ._`;
    await sendMessage(conversationId, reply);

  } else if (result.confidence >= CONFIDENCE_MED && result.suggestions.length > 0) {
    // Medium confidence → suggest
    console.log(`🤔 Suggest (confidence: ${result.confidence.toFixed(2)})`);
    let reply = 'Bạn có phải muốn hỏi về:\n';
    result.suggestions.forEach((s, i) => {
      reply += `${i + 1}. ${s.question}\n`;
    });
    reply += '\nVui lòng chọn số hoặc gõ "gặp nhân viên" để được hỗ trợ trực tiếp.';
    await sendMessage(conversationId, reply);

  } else {
    // Can't answer
    console.log(`❌ No match (confidence: ${result.confidence.toFixed(2)})`);
    await sendMessage(conversationId,
      'Xin lỗi, tôi chưa có câu trả lời cho câu hỏi này.\n\n' +
      'Bạn có thể:\n' +
      '1. Thử hỏi lại bằng cách khác\n' +
      '2. Gõ "gặp nhân viên" để được hỗ trợ trực tiếp'
    );
  }

  // ─── Handle suggestion selection (1, 2, 3) ───
  const num = parseInt(content.trim());
  if (num >= 1 && num <= 3) {
    // User selected a suggestion — lookup recent suggestions
    // For simplicity, just re-match
  }
});

// ─── Staff API: Manage Q&A ───

// GET all Q&A
app.get('/api/qa', (req, res) => {
  res.json(qaData);
});

// GET single Q&A
app.get('/api/qa/:id', (req, res) => {
  const qa = qaData.find(q => q.id === parseInt(req.params.id));
  if (!qa) return res.status(404).json({ error: 'Not found' });
  res.json(qa);
});

// POST create Q&A
app.post('/api/qa', async (req, res) => {
  const { category, question, answer, variants } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });

  const newId = qaData.length > 0 ? Math.max(...qaData.map(q => q.id)) + 1 : 1;
  const newQA = { id: newId, category: category || '', question, answer, variants: variants || [] };
  qaData.push(newQA);
  await saveAndRebuild();
  res.status(201).json(newQA);
});

// PUT update Q&A
app.put('/api/qa/:id', async (req, res) => {
  const idx = qaData.findIndex(q => q.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { category, question, answer, variants } = req.body;
  if (category !== undefined) qaData[idx].category = category;
  if (question !== undefined) qaData[idx].question = question;
  if (answer !== undefined) qaData[idx].answer = answer;
  if (variants !== undefined) qaData[idx].variants = variants;

  await saveAndRebuild();
  res.json(qaData[idx]);
});

// DELETE Q&A
app.delete('/api/qa/:id', async (req, res) => {
  const idx = qaData.findIndex(q => q.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  qaData.splice(idx, 1);
  await saveAndRebuild();
  res.json({ success: true });
});

async function saveAndRebuild() {
  fs.writeFileSync(QA_FILE, JSON.stringify(qaData, null, 2), 'utf-8');
  await matcher.rebuildIndex(qaData);
  console.log(`📚 Q&A updated: ${qaData.length} entries`);
}

// ─── Start ───
app.listen(PORT, () => {
  console.log(`\n🤖 Bot service running on port ${PORT}`);
  console.log(`📚 Loaded ${qaData.length} Q&A entries`);
  console.log(`🔗 Webhook URL: http://host.docker.internal:${PORT}/webhook`);
  console.log(`📋 Q&A API: http://localhost:${PORT}/api/qa\n`);
});
