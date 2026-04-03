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

// Main scrape & analyze action
scrapeBtn.addEventListener('click', async () => {
  // Reset UI
  errorSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  scrapeBtn.disabled = true;

  const limit = parseInt(commentLimit.value, 10);

  try {
    // Step 1: Scrape comments via content script
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

    updateProgress(50, `${comments.length} komentar ditemukan. Menganalisis...`);

    // Step 2: Send to background for Gemini analysis
    const analysis = await chrome.runtime.sendMessage({
      action: 'analyzeComments',
      comments: comments,
      limit: limit
    });

    if (analysis.error) {
      throw new Error(analysis.error);
    }

    updateProgress(100, 'Selesai!');

    // Step 3: Display results
    displayResults(comments.length, analysis);

  } catch (err) {
    showError(err.message);
  } finally {
    scrapeBtn.disabled = false;
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

function displayResults(count, analysis) {
  progressSection.classList.add('hidden');
  resultsSection.classList.remove('hidden');

  // Comment count badge
  document.getElementById('comment-count').textContent = count + ' komentar';

  // Summary
  document.getElementById('result-summary').textContent = analysis.ringkasan || '-';

  // Sentiment
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
      topicsDiv.innerHTML += `<span class="topic-tag">${topic}</span>`;
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
          <div class="username">@${h.username || 'anonim'}</div>
          <div class="comment-text">${h.teks || h.text || ''}</div>
        </div>
      `;
    }
  } else {
    highlightsDiv.innerHTML = '<p>Tidak ada komentar menarik</p>';
  }
}
