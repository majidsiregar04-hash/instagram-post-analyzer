const apiKeyInput = document.getElementById('api-key');
const saveKeyBtn = document.getElementById('save-key');
const keyStatus = document.getElementById('key-status');
const commentLimit = document.getElementById('comment-limit');
const scrapeBtn = document.getElementById('scrape-btn');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const errorSection = document.getElementById('error-section');
const errorText = document.getElementById('error-text');
const resultsSection = document.getElementById('results-section');

// Store results for print page
let lastAnalysis = null;
let lastComments = [];
let categorizedComments = { positif: [], negatif: [], netral: [] };

// Load saved API key on popup open
chrome.storage.local.get(['geminiApiKey'], (result) => {
  if (result.geminiApiKey) {
    apiKeyInput.value = result.geminiApiKey;
    keyStatus.textContent = 'API key tersimpan';
    keyStatus.className = 'status-text success';
    scrapeBtn.disabled = false;
  }
});

// Save API key
saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = 'API key tidak boleh kosong';
    keyStatus.className = 'status-text error';
    return;
  }
  chrome.storage.local.set({ geminiApiKey: key }, () => {
    keyStatus.textContent = 'API key berhasil disimpan!';
    keyStatus.className = 'status-text success';
    scrapeBtn.disabled = false;
  });
});

// Sentiment tab switching
document.querySelectorAll('.sentiment-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sentiment-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.comment-list-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.getAttribute('data-tab');
    document.getElementById('comment-list-' + tabName).classList.add('active');
  });
});

// Main scrape & analyze action
scrapeBtn.addEventListener('click', async () => {
  errorSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  scrapeBtn.disabled = true;

  const limit = parseInt(commentLimit.value, 10);

  try {
    updateProgress(10, 'Memulai scraping komentar...');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || (!tab.url.includes('instagram.com/p/') && !tab.url.includes('instagram.com/reel/'))) {
      throw new Error('Buka halaman post Instagram terlebih dahulu.');
    }

    const comments = await sendMessageToContentScript(tab.id, {
      action: 'scrapeComments',
      limit: limit
    });

    if (!comments || comments.length === 0) {
      throw new Error('Tidak ada komentar yang ditemukan. Pastikan post memiliki komentar.');
    }

    lastComments = comments;
    updateProgress(50, `${comments.length} komentar ditemukan. Menganalisis...`);

    const analysis = await chrome.runtime.sendMessage({
      action: 'analyzeComments',
      comments: comments,
      limit: limit
    });

    if (analysis.error) {
      throw new Error(analysis.error);
    }

    lastAnalysis = analysis;
    updateProgress(100, 'Selesai!');

    displayResults(comments.length, analysis, comments);

  } catch (err) {
    showError(err.message);
  } finally {
    scrapeBtn.disabled = false;
  }
});

// Print / Save as PDF button
document.getElementById('print-btn').addEventListener('click', () => {
  if (lastAnalysis && lastComments.length > 0) {
    openPrintPage(lastAnalysis, lastComments, categorizedComments);
  }
});

function sendMessageToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error('Gagal terhubung ke halaman. Coba refresh halaman Instagram.'));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response ? response.comments : []);
    });
  });
}

function updateProgress(percent, text) {
  progressFill.style.width = percent + '%';
  progressText.textContent = text;
}

function showError(message) {
  progressSection.classList.add('hidden');
  errorSection.classList.remove('hidden');
  errorText.textContent = message;
}

function displayResults(count, analysis, comments) {
  progressSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  document.getElementById('comment-count').textContent = count + ' komentar';
  document.getElementById('result-summary').textContent = analysis.ringkasan || '-';

  // Sentiment bars
  const sentimentDiv = document.getElementById('result-sentiment');
  sentimentDiv.innerHTML = '';
  const sentiments = [
    { label: 'Positif', key: 'positif', cssClass: 'positive' },
    { label: 'Negatif', key: 'negatif', cssClass: 'negative' },
    { label: 'Netral', key: 'netral', cssClass: 'neutral' }
  ];

  for (const s of sentiments) {
    const pct = analysis.sentimen?.[s.key] ?? 0;
    sentimentDiv.innerHTML += `
      <div class="sentiment-row">
        <span class="sentiment-label">${s.label}</span>
        <div class="sentiment-bar-bg">
          <div class="sentiment-bar-fill ${s.cssClass}" style="width: ${pct}%"></div>
        </div>
        <span class="sentiment-pct">${pct}%</span>
      </div>
    `;
  }

  // Topics
  const topicsDiv = document.getElementById('result-topics');
  topicsDiv.innerHTML = '';
  if (analysis.topik && analysis.topik.length > 0) {
    for (const topic of analysis.topik) {
      topicsDiv.innerHTML += `<span class="topic-tag">${escapeHTML(topic)}</span>`;
    }
  } else {
    topicsDiv.innerHTML = '<p>Tidak ada topik terdeteksi</p>';
  }

  // Highlights
  const highlightsDiv = document.getElementById('result-highlights');
  highlightsDiv.innerHTML = '';
  if (analysis.komentar_menarik && analysis.komentar_menarik.length > 0) {
    for (const h of analysis.komentar_menarik) {
      highlightsDiv.innerHTML += `
        <div class="highlight-item">
          <div class="username">@${escapeHTML(h.username || 'anonim')}</div>
          <div class="comment-text">${escapeHTML(h.teks || h.text || '')}</div>
        </div>
      `;
    }
  } else {
    highlightsDiv.innerHTML = '<p>Tidak ada komentar menarik</p>';
  }

  // Categorize comments by sentiment
  categorizedComments = { positif: [], negatif: [], netral: [] };

  if (analysis.klasifikasi_komentar && analysis.klasifikasi_komentar.length > 0) {
    for (const item of analysis.klasifikasi_komentar) {
      const idx = item.index - 1;
      const sentiment = item.sentimen?.toLowerCase() || 'netral';
      const comment = comments[idx];
      if (comment) {
        const entry = { username: comment.username, text: comment.text };
        if (categorizedComments[sentiment]) {
          categorizedComments[sentiment].push(entry);
        } else {
          categorizedComments.netral.push(entry);
        }
      }
    }
  } else {
    for (const comment of comments) {
      categorizedComments.netral.push({ username: comment.username, text: comment.text });
    }
  }

  // Update tab badges
  document.getElementById('count-positif').textContent = categorizedComments.positif.length;
  document.getElementById('count-negatif').textContent = categorizedComments.negatif.length;
  document.getElementById('count-netral').textContent = categorizedComments.netral.length;

  // Render comment lists
  renderCommentList('positif', categorizedComments.positif, 'positive');
  renderCommentList('negatif', categorizedComments.negatif, 'negative');
  renderCommentList('netral', categorizedComments.netral, 'neutral');
}

function renderCommentList(sentimentKey, comments, cssClass) {
  const container = document.getElementById('comment-list-' + sentimentKey);
  container.innerHTML = '';

  if (comments.length === 0) {
    container.innerHTML = '<p class="empty-list">Tidak ada komentar</p>';
    return;
  }

  for (const c of comments) {
    container.innerHTML += `
      <div class="comment-item ${cssClass}">
        <span class="comment-item-user">@${escapeHTML(c.username)}</span>
        <span class="comment-item-text">${escapeHTML(c.text)}</span>
      </div>
    `;
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Generate a print-friendly HTML page and open it in a new tab
function openPrintPage(analysis, comments, categorized) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID');
  const sentPct = analysis.sentimen || {};

  // Build highlights HTML
  let highlightsHTML = '';
  if (analysis.komentar_menarik && analysis.komentar_menarik.length > 0) {
    for (const h of analysis.komentar_menarik) {
      const username = escapeHTMLStr(h.username || 'anonim');
      const teks = escapeHTMLStr(h.teks || h.text || '');
      const alasan = h.alasan ? `<div class="reason">${escapeHTMLStr(h.alasan)}</div>` : '';
      highlightsHTML += `
        <div class="highlight-card">
          <div class="highlight-user">@${username}</div>
          <div class="highlight-text">${teks}</div>
          ${alasan}
        </div>`;
    }
  } else {
    highlightsHTML = '<p class="muted">Tidak ada komentar menarik</p>';
  }

  // Build topics HTML
  let topicsHTML = '';
  if (analysis.topik && analysis.topik.length > 0) {
    topicsHTML = analysis.topik.map(t => `<span class="tag">${escapeHTMLStr(t)}</span>`).join('');
  } else {
    topicsHTML = '<p class="muted">Tidak ada topik terdeteksi</p>';
  }

  // Build comment tables per sentiment
  function buildCommentTable(list, colorClass) {
    if (list.length === 0) return '<p class="muted">Tidak ada komentar dalam kategori ini.</p>';
    let rows = '';
    for (let i = 0; i < list.length; i++) {
      rows += `<tr>
        <td class="col-num">${i + 1}</td>
        <td class="col-user">@${escapeHTMLStr(list[i].username)}</td>
        <td class="col-text">${escapeHTMLStr(list[i].text)}</td>
      </tr>`;
    }
    return `<table class="comment-table ${colorClass}">
      <thead><tr><th class="col-num">No</th><th class="col-user">User</th><th class="col-text">Komentar</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const positifTable = buildCommentTable(categorized.positif, 'tbl-positive');
  const negatifTable = buildCommentTable(categorized.negatif, 'tbl-negative');
  const netralTable = buildCommentTable(categorized.netral, 'tbl-neutral');

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>Instagram Comment Analysis Report</title>
<style>
  @page {
    size: A4;
    margin: 15mm 12mm;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a;
    font-size: 11pt;
    line-height: 1.5;
    background: #fff;
    padding: 20px 30px;
  }

  /* Header */
  .report-header {
    text-align: center;
    border-bottom: 3px solid #833ab4;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .report-header h1 {
    font-size: 22pt;
    font-weight: 700;
    background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 6px;
  }
  .report-header .meta {
    font-size: 10pt;
    color: #666;
  }
  .report-header .meta strong { color: #333; }

  /* Sections */
  .section {
    margin-bottom: 20px;
    break-inside: avoid;
  }
  .section-title {
    font-size: 13pt;
    font-weight: 700;
    color: #333;
    border-bottom: 2px solid #e0e0e0;
    padding-bottom: 4px;
    margin-bottom: 10px;
  }

  /* Summary box */
  .summary-box {
    background: #f8f8fa;
    border-left: 4px solid #833ab4;
    padding: 12px 16px;
    border-radius: 4px;
    font-size: 11pt;
    color: #333;
  }

  /* Sentiment */
  .sentiment-grid {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }
  .sentiment-card {
    flex: 1;
    text-align: center;
    padding: 12px 8px;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  .sentiment-card .pct {
    font-size: 24pt;
    font-weight: 700;
    line-height: 1.2;
  }
  .sentiment-card .lbl {
    font-size: 10pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
  }
  .sentiment-card.positive { border-color: #4caf50; }
  .sentiment-card.positive .pct { color: #2e7d32; }
  .sentiment-card.positive .lbl { color: #4caf50; }
  .sentiment-card.negative { border-color: #f44336; }
  .sentiment-card.negative .pct { color: #c62828; }
  .sentiment-card.negative .lbl { color: #f44336; }
  .sentiment-card.neutral { border-color: #ff9800; }
  .sentiment-card.neutral .pct { color: #e65100; }
  .sentiment-card.neutral .lbl { color: #ff9800; }

  /* Bar visual */
  .sentiment-bar-container {
    display: flex;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    margin-top: 10px;
    background: #eee;
  }
  .bar-pos { background: #4caf50; }
  .bar-neg { background: #f44336; }
  .bar-neu { background: #ff9800; }

  /* Topics */
  .tags { margin-top: 6px; }
  .tag {
    display: inline-block;
    background: #f0f0f5;
    border: 1px solid #d0d0d8;
    border-radius: 16px;
    padding: 4px 14px;
    margin: 3px 4px 3px 0;
    font-size: 10pt;
    color: #444;
  }

  /* Highlights */
  .highlight-card {
    border-left: 4px solid #833ab4;
    padding: 8px 14px;
    margin-bottom: 10px;
    background: #faf8fc;
    border-radius: 0 4px 4px 0;
  }
  .highlight-user {
    font-weight: 700;
    color: #833ab4;
    font-size: 10pt;
  }
  .highlight-text {
    color: #333;
    margin-top: 2px;
    font-size: 10.5pt;
  }
  .reason {
    color: #888;
    font-style: italic;
    font-size: 9.5pt;
    margin-top: 4px;
  }

  /* Comment tables */
  .comment-section-header {
    font-size: 12pt;
    font-weight: 700;
    padding: 6px 10px;
    border-radius: 4px;
    margin-bottom: 6px;
    color: #fff;
  }
  .comment-section-header.positive-hdr { background: #4caf50; }
  .comment-section-header.negative-hdr { background: #f44336; }
  .comment-section-header.neutral-hdr { background: #ff9800; }

  .comment-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
    font-size: 9.5pt;
  }
  .comment-table thead th {
    background: #f5f5f5;
    padding: 6px 8px;
    text-align: left;
    font-weight: 600;
    border-bottom: 2px solid #ddd;
    font-size: 9pt;
    color: #555;
  }
  .comment-table tbody tr {
    border-bottom: 1px solid #eee;
  }
  .comment-table tbody tr:nth-child(even) {
    background: #fafafa;
  }
  .comment-table td {
    padding: 5px 8px;
    vertical-align: top;
  }
  .col-num { width: 35px; text-align: center; color: #999; }
  .col-user { width: 110px; font-weight: 600; color: #833ab4; white-space: nowrap; }
  .col-text { color: #333; }

  .tbl-positive thead th { border-bottom-color: #4caf50; }
  .tbl-negative thead th { border-bottom-color: #f44336; }
  .tbl-neutral thead th { border-bottom-color: #ff9800; }

  .muted { color: #999; font-style: italic; }

  /* Print button */
  .no-print { text-align: center; margin: 20px 0; }
  .print-btn {
    padding: 10px 32px;
    font-size: 13pt;
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .print-btn:hover { opacity: 0.9; }

  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
    .section { break-inside: avoid; }
    .comment-table tr { break-inside: avoid; }
    .highlight-card { break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="report-header">
  <h1>Instagram Comment Analysis</h1>
  <div class="meta">
    <strong>${dateStr}</strong> &nbsp;|&nbsp; ${timeStr} &nbsp;|&nbsp; <strong>${comments.length}</strong> komentar dianalisis
  </div>
</div>

<div class="section">
  <div class="section-title">Ringkasan</div>
  <div class="summary-box">${escapeHTMLStr(analysis.ringkasan || '-')}</div>
</div>

<div class="section">
  <div class="section-title">Sentimen</div>
  <div class="sentiment-grid">
    <div class="sentiment-card positive">
      <div class="pct">${sentPct.positif ?? 0}%</div>
      <div class="lbl">Positif</div>
    </div>
    <div class="sentiment-card negative">
      <div class="pct">${sentPct.negatif ?? 0}%</div>
      <div class="lbl">Negatif</div>
    </div>
    <div class="sentiment-card neutral">
      <div class="pct">${sentPct.netral ?? 0}%</div>
      <div class="lbl">Netral</div>
    </div>
  </div>
  <div class="sentiment-bar-container">
    <div class="bar-pos" style="width: ${sentPct.positif ?? 0}%"></div>
    <div class="bar-neg" style="width: ${sentPct.negatif ?? 0}%"></div>
    <div class="bar-neu" style="width: ${sentPct.netral ?? 0}%"></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Topik Utama</div>
  <div class="tags">${topicsHTML}</div>
</div>

<div class="section">
  <div class="section-title">Komentar Menarik</div>
  ${highlightsHTML}
</div>

<div class="section">
  <div class="section-title">Komentar Positif (${categorized.positif.length})</div>
  <div class="comment-section-header positive-hdr">Positif &mdash; ${categorized.positif.length} komentar</div>
  ${positifTable}
</div>

<div class="section">
  <div class="section-title">Komentar Negatif (${categorized.negatif.length})</div>
  <div class="comment-section-header negative-hdr">Negatif &mdash; ${categorized.negatif.length} komentar</div>
  ${negatifTable}
</div>

<div class="section">
  <div class="section-title">Komentar Netral (${categorized.netral.length})</div>
  <div class="comment-section-header neutral-hdr">Netral &mdash; ${categorized.netral.length} komentar</div>
  ${netralTable}
</div>

<div class="no-print">
  <button class="print-btn" onclick="window.print()">Cetak / Save as PDF</button>
</div>

</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url: url }, (tab) => {
    // Use chrome.scripting.executeScript to auto-trigger print dialog
    // after the tab finishes loading
    const tabId = tab.id;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => { window.print(); }
          });
        }, 600);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Escape HTML for use in template strings (not DOM-based)
function escapeHTMLStr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
