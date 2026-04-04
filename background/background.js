// Background service worker: handle Gemini API calls and report tab

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const BATCH_SIZE = 80;

// Store report data in memory (fast, no storage overhead)
let pendingReportData = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeComments') {
    analyzeComments(request.comments)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.action === 'openReport') {
    // Store data in memory and open report.html in new tab
    pendingReportData = request.data;
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/report.html') });
    sendResponse({ ok: true });
    return;
  }

  if (request.action === 'getReportData') {
    // report.html requests the stored data
    sendResponse({ data: pendingReportData });
    return;
  }
});

async function analyzeComments(comments) {
  const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
  if (!geminiApiKey) {
    throw new Error('API key Gemini belum diatur. Masukkan API key di popup.');
  }

  if (comments.length <= BATCH_SIZE) {
    return await analyzeFullBatch(comments, geminiApiKey);
  }

  const batches = [];
  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    batches.push(comments.slice(i, i + BATCH_SIZE));
  }

  const result = await analyzeFullBatch(batches[0], geminiApiKey);
  const allClassifications = result.klasifikasi_komentar || [];

  for (let i = 1; i < batches.length; i++) {
    const batchResult = await classifyBatch(batches[i], i * BATCH_SIZE, geminiApiKey);
    if (batchResult.klasifikasi_komentar) {
      allClassifications.push(...batchResult.klasifikasi_komentar);
    }
  }

  result.klasifikasi_komentar = allClassifications;
  return result;
}

async function analyzeFullBatch(comments, apiKey) {
  const commentList = comments
    .map((c, i) => `${i + 1}. @${c.username}: ${c.text}`)
    .join('\n');

  const prompt = `Kamu adalah analis media sosial. Analisis komentar-komentar Instagram berikut ini.

DAFTAR KOMENTAR (${comments.length} komentar):
${commentList}

Berikan analisis dalam format JSON yang VALID (tanpa markdown, tanpa backtick) dengan struktur berikut:
{
  "ringkasan": "Ringkasan singkat tentang keseluruhan komentar dalam 2-3 kalimat",
  "sentimen": {
    "positif": <angka persentase 0-100>,
    "negatif": <angka persentase 0-100>,
    "netral": <angka persentase 0-100>
  },
  "topik": ["topik 1", "topik 2", "topik 3", "topik 4", "topik 5"],
  "komentar_menarik": [
    {"username": "nama_user", "teks": "isi komentar", "alasan": "kenapa menarik"},
    {"username": "nama_user", "teks": "isi komentar", "alasan": "kenapa menarik"},
    {"username": "nama_user", "teks": "isi komentar", "alasan": "kenapa menarik"}
  ],
  "klasifikasi_komentar": [
    {"index": 1, "sentimen": "positif"},
    {"index": 2, "sentimen": "negatif"},
    {"index": 3, "sentimen": "netral"}
  ]
}

PENTING:
- Semua analisis dalam Bahasa Indonesia
- Persentase sentimen harus berjumlah 100
- Pilih maksimal 5 topik utama
- Pilih 3 komentar paling menarik atau representatif
- klasifikasi_komentar HARUS berisi SEMUA komentar (dari index 1 sampai ${comments.length})
- Setiap komentar diklasifikasi sebagai "positif", "negatif", atau "netral"
- Hanya keluarkan JSON murni, tanpa teks tambahan`;

  return await callGeminiAPI(prompt, apiKey);
}

async function classifyBatch(comments, startIndex, apiKey) {
  const commentList = comments
    .map((c, i) => `${startIndex + i + 1}. @${c.username}: ${c.text}`)
    .join('\n');

  const prompt = `Klasifikasikan sentimen setiap komentar Instagram berikut sebagai "positif", "negatif", atau "netral".

DAFTAR KOMENTAR:
${commentList}

Berikan hasil dalam format JSON yang VALID (tanpa markdown, tanpa backtick) dengan struktur:
{
  "klasifikasi_komentar": [
    {"index": ${startIndex + 1}, "sentimen": "positif"},
    {"index": ${startIndex + 2}, "sentimen": "negatif"}
  ]
}

PENTING:
- klasifikasi_komentar HARUS berisi SEMUA komentar dari daftar di atas
- Setiap komentar diklasifikasi sebagai "positif", "negatif", atau "netral"
- Hanya keluarkan JSON murni, tanpa teks tambahan`;

  return await callGeminiAPI(prompt, apiKey);
}

async function callGeminiAPI(prompt, apiKey) {
  const url = `${GEMINI_API_URL}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${errorMsg}`);
  }

  const data = await response.json();

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini tidak mengembalikan respons yang valid.');
  }

  const cleanedText = rawText
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch {
    throw new Error('Gagal memproses respons Gemini. Coba lagi.');
  }
}
