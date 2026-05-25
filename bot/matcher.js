require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const VECTORS_FILE = path.join(__dirname, 'vectors.json');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Dùng model embedding để chuyển văn bản thành vector
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
// Dùng model dạng chat/generate để format cứng câu trả lời
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Hàm tính Cosine Similarity (Độ tương đồng cosine cho vector)
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INTENT_RULES = [
  {
    key: 'address',
    label: 'dia chi benh vien',
    keywords: ['dia chi', 'd c', 'o dau', 'cho nao', 'co so nao', 'duong nao', 'cong may'],
    qaHints: ['dia chi benh vien']
  },
  {
    key: 'phone',
    label: 'so dien thoai lien he',
    keywords: ['sdt', 'so dt', 'so dien thoai', 'dien thoai', 'hotline', 'tong dai', 'lien he'],
    qaHints: ['so dien thoai lien he']
  },
  {
    key: 'website',
    label: 'website benh vien',
    keywords: ['website', 'trang web', 'web benh vien', 'link web'],
    qaHints: ['website benh vien']
  },
  {
    key: 'schedule',
    label: 'lich kham benh',
    keywords: ['lich kham', 'gio kham', 'gio lam viec', 'lich lam viec', 'thoi gian kham', 'may gio kham', 'cuoi tuan'],
    qaHints: ['lich kham benh']
  },
  {
    key: 'payment',
    label: 'hinh thuc thanh toan',
    keywords: ['thanh toan', 'tra tien', 'chuyen khoan', 'quet the', 'tien mat'],
    qaHints: ['hinh thuc thanh toan']
  },
  {
    key: 'insurance',
    label: 'bao hiem y te',
    keywords: ['bhyt', 'bao hiem', 'bao hiem y te', 'the bao hiem', 'giay chuyen tuyen'],
    qaHints: ['bao hiem y te', 'hinh thuc kham']
  }
];

class QAMatcher {
  constructor() {
    this.qaData = [];
    this.docMap = []; // Chứa vector embeddings của tất cả câu hỏi
    this.isReady = false;

    // Phục hồi lại não Vector từ ổ cứng nếu có cúp điện hay khởi động lại
    if (fs.existsSync(VECTORS_FILE)) {
      try {
        this.docMap = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf-8'));
      } catch (err) { }
    }
  }

  // Khởi tạo và mã hóa toàn bộ Q&A (Có bộ nhớ đệm chống Spam API)
  async rebuildIndex(newQaData) {
    this.qaData = newQaData;
    const oldDocMap = this.docMap; // Lưu trữ cấu trúc cũ để tái sử dụng
    this.docMap = [];
    this.isReady = false;

    let newApiCount = 0;

    for (const qa of this.qaData) {
      if (!qa.question) continue;
      
      try {
        // Tái sử dụng nếu câu hỏi đã tồn tại (Không gọi API nữa)
        const oldMain = oldDocMap.find(d => d.qaId === qa.id && d.text === qa.question);
        if (oldMain && oldMain.embedding) {
          this.docMap.push(oldMain);
        } else {
          newApiCount++;
          const result = await embeddingModel.embedContent(qa.question);
          this.docMap.push({ qaId: qa.id, text: qa.question, embedding: result.embedding.values });
        }

        if (qa.variants) {
          for (const v of qa.variants) {
            if (!v) continue;
            const oldV = oldDocMap.find(d => d.qaId === qa.id && d.text === v);
            if (oldV && oldV.embedding) {
              this.docMap.push(oldV);
            } else {
              newApiCount++;
              const resV = await embeddingModel.embedContent(v);
              this.docMap.push({ qaId: qa.id, text: v, embedding: resV.embedding.values });
            }
          }
        }
      } catch (err) {
        console.error(`[Gemini] Lỗi mã hóa câu hỏi ID ${qa.id}:`, err.message);
      }
    }

    this.isReady = true;
    if (newApiCount > 0) {
      console.log(`[Gemini] Đã gọi API mã hóa thêm ${newApiCount} vector mới. (Tổng vector: ${this.docMap.length})`);
      // Lưu lại vào ổ đĩa để khởi động sau không bị mất
      fs.writeFileSync(VECTORS_FILE, JSON.stringify(this.docMap), 'utf-8');
    }
  }

  async findBestMatch(userQuestion) {
    if (!this.isReady) {
      return { match: null, confidence: 0, suggestions: [] };
    }

    try {
      return await this.scoreQuestion(userQuestion);
    } catch (err) {
      console.error("[Gemini] Match error:", err.message);
      return { match: null, confidence: 0, suggestions: [] };
    }
  }

  async scoreQuestion(userQuestion) {
    const queryResult = await embeddingModel.embedContent(userQuestion);
    const queryEmbedding = queryResult.embedding.values;

    const scores = {};
    for (const doc of this.docMap) {
      const similarity = cosineSimilarity(queryEmbedding, doc.embedding);
      if (!scores[doc.qaId] || similarity > scores[doc.qaId]) {
        scores[doc.qaId] = similarity;
      }
    }

    let bestId = null;
    let bestScore = 0;
    for (const [qaId, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestId = parseInt(qaId);
      }
    }

    if (!bestId) return { match: null, confidence: 0, suggestions: [] };

    const bestQA = this.qaData.find(q => q.id === bestId);
    const sortedScores = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id, score]) => {
        const qa = this.qaData.find(q => q.id === parseInt(id));
        return qa ? { ...qa, confidence: score } : null;
      })
      .filter(Boolean);

    return {
      match: bestQA,
      confidence: bestScore,
      suggestions: sortedScores
    };
  }

  findQaByHints(hints) {
    for (const hint of hints) {
      const normalizedHint = normalizeText(hint);
      const match = this.qaData.find(qa => normalizeText(qa.question).includes(normalizedHint));
      if (match) return match;
    }
    return null;
  }

  findIntentMatches(userQuestion) {
    const normalized = normalizeText(userQuestion);
    const matches = [];

    for (const rule of INTENT_RULES) {
      if (!rule.keywords.some(keyword => normalized.includes(keyword))) continue;

      const qa = this.findQaByHints(rule.qaHints);
      if (qa) {
        matches.push({
          ...qa,
          confidence: 1,
          source: 'intent',
          intent: rule.key
        });
      }
    }

    return matches;
  }

  splitIntoSubQuestions(userQuestion) {
    const normalizedSeparators = String(userQuestion || '')
      .split(/\s*(?:&|\+|\/|,|;|\?)\s*|\s+(?:và|va|với|voi|cùng|cung|kèm|kem|hoặc|hoac)\s+/i)
      .map(part => part.trim())
      .filter(part => normalizeText(part).length >= 6);

    return [...new Set([userQuestion, ...normalizedSeparators])];
  }

  addMatch(uniqueMatches, candidate) {
    if (!candidate || !candidate.id || uniqueMatches.has(candidate.id)) return;
    uniqueMatches.set(candidate.id, candidate);
  }

  async findAnswerBundle(userQuestion, options = {}) {
    const highThreshold = options.highThreshold ?? 0.5;
    const segmentThreshold = options.segmentThreshold ?? 0.48;

    if (!this.isReady) {
      return { match: null, matches: [], confidence: 0, suggestions: [] };
    }

    const uniqueMatches = new Map();
    const intentMatches = this.findIntentMatches(userQuestion);
    intentMatches.forEach(match => this.addMatch(uniqueMatches, match));

    if (intentMatches.length >= 2) {
      const matches = [...uniqueMatches.values()].slice(0, 4);
      return {
        match: matches[0] || null,
        matches,
        confidence: matches[0]?.confidence || 0,
        suggestions: []
      };
    }

    const originalResult = await this.findBestMatch(userQuestion);
    if (originalResult.match && originalResult.confidence >= highThreshold) {
      this.addMatch(uniqueMatches, {
        ...originalResult.match,
        confidence: originalResult.confidence,
        source: 'embedding'
      });
    }

    const subQuestions = this.splitIntoSubQuestions(userQuestion).slice(1, 6);
    for (const subQuestion of subQuestions) {
      const result = await this.findBestMatch(subQuestion);
      if (result.match && result.confidence >= segmentThreshold) {
        this.addMatch(uniqueMatches, {
          ...result.match,
          confidence: result.confidence,
          source: 'segment'
        });
      }
    }

    const matches = [...uniqueMatches.values()]
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 4);

    return {
      match: matches[0] || null,
      matches,
      confidence: matches[0]?.confidence || originalResult.confidence || 0,
      suggestions: originalResult.suggestions || []
    };
  }

  formatSourceAnswers(matchedAnswers) {
    if (Array.isArray(matchedAnswers)) {
      return matchedAnswers
        .map((item, index) => `${index + 1}. ${item.question}\n${item.answer}`)
        .join('\n\n');
    }

    return matchedAnswers;
  }

  fallbackReply(matchedAnswers) {
    if (Array.isArray(matchedAnswers)) {
      return matchedAnswers
        .map(item => `${item.question}\n${item.answer}`)
        .join('\n\n');
    }

    return matchedAnswers;
  }

  // Chuyển qua Gemini format lại câu trả lời mềm mỏng
  async smartReply(userQuestion, matchedAnswers) {
    try {
      const sourceAnswers = this.formatSourceAnswers(matchedAnswers);
      const prompt = `Bạn là lễ tân trực tổng đài Bệnh Viện Ung Bướu TP.HCM. Hãy trả lời câu hỏi của bệnh nhân dựa TRÊN THÔNG TIN GỐC SAU ĐÂY. KHÔNG ĐƯỢC BỊA ĐẶT. GIỮ NGUYÊN THÔNG TIN GIÁ TIỀN, ĐỊA CHỈ, SĐT. Nếu câu hỏi có nhiều ý, phải trả lời đầy đủ từng ý đã có trong thông tin gốc, không chỉ chọn một ý đúng nhất. Hãy trả lời ngắn gọn, lịch sự, xưng hô là "bệnh viện" và "anh/chị".\n\nCâu hỏi của khách: "${userQuestion}"\n\nThông tin gốc:\n${sourceAnswers}`;
      
      const result = await chatModel.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      console.error("[Gemini] Chat lỗi:", err.message);
      return this.fallbackReply(matchedAnswers); // Sai thì trả về đáp án cứng
    }
  }
}

module.exports = QAMatcher;
