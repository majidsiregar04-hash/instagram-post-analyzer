// Background service worker: handle Gemini API calls

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeComments') {
    analyzeComments(request.comments)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep message channel open for async response
  }
});

async function analyzeComments(comments) {
  // Get API key from storage
  const { geminiApiKey } = await chrome.storage.local.get(['geminiApiKey']);
  if (!geminiApiKey) {
    throw new Error('API key Gemini belum diatur. Masukkan API key di popup.');
  }

  // Format comments for the prompt
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
  ]
}

PENTING:
- Semua analisis dalam Bahasa Indonesia
- Persentase sentimen harus berjumlah 100
- Pilih maksimal 5 topik utama
- Pilih 3 komentar paling menarik atau representatif
- Hanya keluarkan JSON murni, tanpa teks tambahan`;

  const url = `${GEMINI_API_URL}?key=${geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${errorMsg}`);
  }

  const data = await response.json();

  // Extract text from Gemini response
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini tidak mengembalikan respons yang valid.');
  }

  // Parse JSON from response (clean up potential markdown code blocks)
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
