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
      // Mã hóa câu hỏi của người dùng
      const queryResult = await embeddingModel.embedContent(userQuestion);
      const queryEmbedding = queryResult.embedding.values;

      // Tính điểm tương đồng với toàn bộ database
      const scores = {};
      for (const doc of this.docMap) {
        const similarity = cosineSimilarity(queryEmbedding, doc.embedding);
        if (!scores[doc.qaId] || similarity > scores[doc.qaId]) {
          scores[doc.qaId] = similarity;
        }
      }

      // Tìm câu có điểm cao nhất
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

      // Lấy top 3 câu gợi ý
      const sortedScores = Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([id]) => this.qaData.find(q => q.id === parseInt(id)))
        .filter(Boolean);

      return {
        match: bestQA,
        confidence: bestScore, // Điểm Cosine ~ 0.5 đến 1.0 tùy mức độ
        suggestions: sortedScores
      };
    } catch (err) {
      console.error("[Gemini] Match error:", err.message);
      return { match: null, confidence: 0, suggestions: [] };
    }
  }

  // Chuyển qua Gemini format lại câu trả lời mềm mỏng
  async smartReply(userQuestion, matchedAnswer) {
    try {
      const prompt = `Bạn là lễ tân trực tổng đài Bệnh Viện Ung Bướu TP.HCM. Hãy trả lời câu hỏi của bệnh nhân dựa TRÊN THÔNG TIN GỐC SAU ĐÂY. KHÔNG ĐƯỢC BỊA ĐẶT. GIỮ NGUYÊN THÔNG TIN GIÁ TIỀN, ĐỊA CHỈ, SĐT. Hãy trả lời ngắn gọn, lịch sự, xưng hô là "bệnh viện" và "anh/chị".\n\nCâu hỏi của khách: "${userQuestion}"\n\nThông tin gốc: "${matchedAnswer}"`;
      
      const result = await chatModel.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      console.error("[Gemini] Chat lỗi:", err.message);
      return matchedAnswer; // Sai thì trả về đáp án cứng
    }
  }
}

module.exports = QAMatcher;
