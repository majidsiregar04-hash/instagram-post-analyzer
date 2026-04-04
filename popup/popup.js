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

// Store results for download
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

// Download report button
document.getElementById('download-btn').addEventListener('click', () => {
  if (lastAnalysis && lastComments.length > 0) {
    downloadReport(lastAnalysis, lastComments, categorizedComments);
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

function escapeHTMLStr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function downloadReport(analysis, comments, categorized) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID');
  const s = analysis.sentimen || {};

  function buildTable(list, cls) {
    if (!list.length) return '<p style="color:#999;font-style:italic">Tidak ada komentar.</p>';
    let r = '';
    for (let i = 0; i < list.length; i++) {
      const bg = i % 2 === 0 ? '#fff' : '#fafafa';
      r += '<tr style="border-bottom:1px solid #eee;background:' + bg + '">'
        + '<td style="padding:5px 8px;width:35px;text-align:center;color:#999">' + (i+1) + '</td>'
        + '<td style="padding:5px 8px;width:110px;font-weight:600;color:#833ab4;white-space:nowrap">@' + escapeHTMLStr(list[i].username) + '</td>'
        + '<td style="padding:5px 8px;color:#333">' + escapeHTMLStr(list[i].text) + '</td></tr>';
    }
    return '<table style="width:100%;border-collapse:collapse;font-size:9.5pt;margin-bottom:16px">'
      + '<thead><tr><th style="background:#f5f5f5;padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid ' + cls + ';font-size:9pt;color:#555">No</th>'
      + '<th style="background:#f5f5f5;padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid ' + cls + ';font-size:9pt;color:#555">User</th>'
      + '<th style="background:#f5f5f5;padding:6px 8px;text-align:left;font-weight:600;border-bottom:2px solid ' + cls + ';font-size:9pt;color:#555">Komentar</th></tr></thead>'
      + '<tbody>' + r + '</tbody></table>';
  }

  let highlights = '';
  if (analysis.komentar_menarik && analysis.komentar_menarik.length > 0) {
    for (const h of analysis.komentar_menarik) {
      const alasan = h.alasan ? '<div style="color:#888;font-style:italic;font-size:9.5pt;margin-top:4px">' + escapeHTMLStr(h.alasan) + '</div>' : '';
      highlights += '<div style="border-left:4px solid #833ab4;padding:8px 14px;margin-bottom:10px;background:#faf8fc;border-radius:0 4px 4px 0">'
        + '<div style="font-weight:700;color:#833ab4;font-size:10pt">@' + escapeHTMLStr(h.username || 'anonim') + '</div>'
        + '<div style="color:#333;margin-top:2px;font-size:10.5pt">' + escapeHTMLStr(h.teks || h.text || '') + '</div>'
        + alasan + '</div>';
    }
  } else {
    highlights = '<p style="color:#999;font-style:italic">Tidak ada komentar menarik</p>';
  }

  let topics = '';
  if (analysis.topik && analysis.topik.length > 0) {
    topics = analysis.topik.map(t => '<span style="display:inline-block;background:#f0f0f5;border:1px solid #d0d0d8;border-radius:16px;padding:4px 14px;margin:3px 4px 3px 0;font-size:10pt;color:#444">' + escapeHTMLStr(t) + '</span>').join('');
  } else {
    topics = '<p style="color:#999;font-style:italic">Tidak ada topik terdeteksi</p>';
  }

  const html = '<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><title>Instagram Comment Analysis Report</title>'
    + '<style>@page{size:A4;margin:15mm 12mm}*{margin:0;padding:0;box-sizing:border-box}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;color:#1a1a1a;font-size:11pt;line-height:1.5;background:#fff;padding:20px 30px}'
    + '@media print{body{padding:0}.no-print{display:none!important}}</style></head><body>'

    // Header
    + '<div style="text-align:center;border-bottom:3px solid #833ab4;padding-bottom:16px;margin-bottom:24px">'
    + '<h1 style="font-size:22pt;font-weight:700;color:#833ab4;margin-bottom:6px">Instagram Comment Analysis</h1>'
    + '<div style="font-size:10pt;color:#666"><strong style="color:#333">' + dateStr + '</strong> &nbsp;|&nbsp; ' + timeStr
    + ' &nbsp;|&nbsp; <strong style="color:#333">' + comments.length + '</strong> komentar dianalisis</div></div>'

    // Ringkasan
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Ringkasan</div>'
    + '<div style="background:#f8f8fa;border-left:4px solid #833ab4;padding:12px 16px;border-radius:4px;color:#333">' + escapeHTMLStr(analysis.ringkasan || '-') + '</div></div>'

    // Sentimen
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Sentimen</div>'
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr>'
    + '<td style="text-align:center;padding:12px 8px;border:1px solid #4caf50;border-radius:8px;width:33%"><div style="font-size:24pt;font-weight:700;color:#2e7d32">' + (s.positif||0) + '%</div><div style="font-size:10pt;font-weight:600;color:#4caf50;text-transform:uppercase">Positif</div></td>'
    + '<td style="width:8px"></td>'
    + '<td style="text-align:center;padding:12px 8px;border:1px solid #f44336;border-radius:8px;width:33%"><div style="font-size:24pt;font-weight:700;color:#c62828">' + (s.negatif||0) + '%</div><div style="font-size:10pt;font-weight:600;color:#f44336;text-transform:uppercase">Negatif</div></td>'
    + '<td style="width:8px"></td>'
    + '<td style="text-align:center;padding:12px 8px;border:1px solid #ff9800;border-radius:8px;width:33%"><div style="font-size:24pt;font-weight:700;color:#e65100">' + (s.netral||0) + '%</div><div style="font-size:10pt;font-weight:600;color:#ff9800;text-transform:uppercase">Netral</div></td>'
    + '</tr></table>'
    + '<div style="display:flex;height:12px;border-radius:6px;overflow:hidden;background:#eee">'
    + '<div style="background:#4caf50;width:' + (s.positif||0) + '%"></div>'
    + '<div style="background:#f44336;width:' + (s.negatif||0) + '%"></div>'
    + '<div style="background:#ff9800;width:' + (s.netral||0) + '%"></div></div></div>'

    // Topik
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Topik Utama</div>'
    + '<div>' + topics + '</div></div>'

    // Highlights
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Komentar Menarik</div>'
    + highlights + '</div>'

    // Komentar Positif
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Komentar Positif (' + categorized.positif.length + ')</div>'
    + '<div style="font-size:12pt;font-weight:700;padding:6px 10px;border-radius:4px;margin-bottom:6px;color:#fff;background:#4caf50">Positif &mdash; ' + categorized.positif.length + ' komentar</div>'
    + buildTable(categorized.positif, '#4caf50') + '</div>'

    // Komentar Negatif
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Komentar Negatif (' + categorized.negatif.length + ')</div>'
    + '<div style="font-size:12pt;font-weight:700;padding:6px 10px;border-radius:4px;margin-bottom:6px;color:#fff;background:#f44336">Negatif &mdash; ' + categorized.negatif.length + ' komentar</div>'
    + buildTable(categorized.negatif, '#f44336') + '</div>'

    // Komentar Netral
    + '<div style="margin-bottom:20px">'
    + '<div style="font-size:13pt;font-weight:700;color:#333;border-bottom:2px solid #e0e0e0;padding-bottom:4px;margin-bottom:10px">Komentar Netral (' + categorized.netral.length + ')</div>'
    + '<div style="font-size:12pt;font-weight:700;padding:6px 10px;border-radius:4px;margin-bottom:6px;color:#fff;background:#ff9800">Netral &mdash; ' + categorized.netral.length + ' komentar</div>'
    + buildTable(categorized.netral, '#ff9800') + '</div>'

    + '<div class="no-print" style="text-align:center;margin:20px 0">'
    + '<button onclick="window.print()" style="padding:10px 32px;font-size:13pt;font-weight:600;color:#fff;background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);border:none;border-radius:8px;cursor:pointer">Cetak / Save as PDF</button></div>'
    + '</body></html>';

  // Download the HTML file directly
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  a.href = url;
  a.download = 'ig-analysis-' + ts + '.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
