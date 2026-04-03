# Instagram Comment Analyzer - Chrome Extension

Chrome Extension untuk scrape komentar dari post Instagram dan menganalisisnya menggunakan Google Gemini AI.

## Fitur

- Scrape komentar dari post/reel Instagram dengan auto-scroll
- Analisis komentar menggunakan Google Gemini 2.0 Flash
- Ringkasan komentar secara keseluruhan
- Analisis sentimen (positif/negatif/netral)
- Identifikasi topik utama
- Highlight komentar paling menarik
- Pengaturan batas jumlah komentar (50, 100, 200, 500, atau semua)

## Cara Install

1. Download atau clone repository ini
2. Buka `chrome://extensions/` di browser Chrome
3. Aktifkan **Developer mode** (toggle di kanan atas)
4. Klik **Load unpacked** dan pilih folder project ini
5. Extension akan muncul di toolbar Chrome

## Cara Pakai

1. Buka halaman post Instagram (`instagram.com/p/...` atau `instagram.com/reel/...`)
2. Klik icon extension di toolbar Chrome
3. Masukkan **Gemini API Key** dan klik **Simpan**
   - Dapatkan API key di [Google AI Studio](https://aistudio.google.com/apikey)
4. Pilih batas jumlah komentar yang ingin di-scrape
5. Klik **Scrape & Analisis Komentar**
6. Tunggu proses scraping dan analisis selesai

## Struktur Project

```
├── manifest.json          # Chrome Extension manifest (V3)
├── popup/
│   ├── popup.html         # UI popup
│   ├── popup.css          # Styling
│   └── popup.js           # Logic popup
├── content/
│   └── content.js         # Content script (scraping + auto-scroll)
├── background/
│   └── background.js      # Service worker (Gemini API)
├── icons/                 # Extension icons
└── README.md
```

## Catatan

- Extension ini hanya berfungsi di halaman post/reel Instagram
- Diperlukan API key Google Gemini yang valid
- Instagram dapat mengubah struktur DOM sewaktu-waktu, yang mungkin mempengaruhi proses scraping
- Gunakan secara bijak dan patuhi Terms of Service Instagram
