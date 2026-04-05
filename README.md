# Instagram Comment Analyzer - Chrome Extension

Chrome Extension untuk scrape komentar dari post Instagram dan menganalisisnya menggunakan Google Gemini AI.

## Fitur

- Scrape komentar dari post/reel Instagram dengan **scroll manual** + progress real-time di popup
- Otomatis expand reply, hidden comments, dan komentar terpotong
- Analisis komentar menggunakan Google Gemini 2.0 Flash
- Ringkasan komentar secara keseluruhan
- Analisis sentimen (positif/negatif/netral) dengan visualisasi bar
- Identifikasi topik utama
- Highlight komentar paling menarik
- Klasifikasi komentar per sentimen dengan tab interaktif
- Pengaturan batas jumlah komentar (50, 100, 200, 500, atau semua)
- Export laporan ke halaman report (bisa di-print/save as PDF)

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
6. **Scroll halaman Instagram ke bawah** secara manual — counter di popup akan update otomatis menunjukkan jumlah komentar yang ditemukan
7. Klik **Selesai Scraping** jika sudah cukup (atau otomatis berhenti saat limit tercapai)
8. Tunggu proses analisis Gemini AI selesai
9. Lihat hasil analisis di popup atau klik **Buka Laporan** untuk view lengkap

## Struktur Project

```
├── manifest.json          # Chrome Extension manifest (V3)
├── popup/
│   ├── popup.html         # UI popup
│   ├── popup.css          # Styling
│   ├── popup.js           # Logic popup (port-based communication)
│   ├── report.html        # Halaman laporan
│   └── report.js          # Logic render laporan
├── content/
│   └── content.js         # Content script (DOM scraping + expansion)
├── background/
│   └── background.js      # Service worker (Gemini API + report data)
├── icons/                 # Extension icons
└── README.md
```

## Catatan

- Extension ini hanya berfungsi di halaman post/reel Instagram
- Diperlukan API key Google Gemini yang valid
- Instagram dapat mengubah struktur DOM sewaktu-waktu, yang mungkin mempengaruhi proses scraping
- Gunakan secara bijak dan patuhi Terms of Service Instagram
