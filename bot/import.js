const xlsx = require('xlsx');
const fs = require('fs');

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Vui lòng cung cấp tên file: node import.js data.xlsx');
  process.exit(1);
}

const workbook = xlsx.readFile(inputFile);
const sheetName = workbook.SheetNames[0]; // Chỉ đọc Sheet 1
const sheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

const qaData = [];
let id = 1;

for (let i = 2; i < data.length; i++) { // Bỏ qua 2 dòng tiêu đề đầu tiên
  const row = data[i];
  if (!row) continue;

  const question = row[1]; // Cột B (NỘI DUNG CÂU HỎI)
  const answer = row[2];   // Cột C (NỘI DUNG PHẢN HỒI)
  
  if (question && answer && typeof question === 'string') {
    qaData.push({
      id: id++,
      category: "Imported",
      question: question.toString().trim(),
      variants: [], 
      answer: answer.toString().trim()
    });
  }
}

fs.writeFileSync('qa-data.json', JSON.stringify(qaData, null, 2), 'utf-8');
console.log(`Đã import ${qaData.length} câu hỏi vào qa-data.json thành công!`);
