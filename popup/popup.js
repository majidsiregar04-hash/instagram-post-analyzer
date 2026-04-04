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

// Save report data to storage and open report.html in a new tab
function openPrintPage(analysis, comments, categorized) {
  const reportData = {
    analysis: analysis,
    comments: comments,
    categorized: categorized
  };

  chrome.storage.local.set({ reportData: reportData }, () => {
    const reportUrl = chrome.runtime.getURL('popup/report.html');
    chrome.tabs.create({ url: reportUrl });
  });
}
