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

// Store results for report
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

// Scraping state
let scrapingPort = null;
const doneBtn = document.getElementById('done-btn');

// Main scrape & analyze action
scrapeBtn.addEventListener('click', async () => {
  errorSection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  scrapeBtn.disabled = true;

  const limit = parseInt(commentLimit.value, 10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || (!tab.url.includes('instagram.com/p/') && !tab.url.includes('instagram.com/reel/'))) {
      throw new Error('Buka halaman post Instagram terlebih dahulu.');
    }

    // Ensure content script is injected
    await ensureContentScript(tab.id);

    // Connect port to content script
    scrapingPort = chrome.tabs.connect(tab.id, { name: 'scraping' });

    // Show scraping UI
    progressFill.classList.add('pulsing');
    progressText.textContent = 'Scroll halaman Instagram ke bawah... 0 komentar ditemukan';
    doneBtn.classList.remove('hidden');

    // Listen for progress and done messages
    scrapingPort.onMessage.addListener(async (msg) => {
      if (msg.action === 'progress') {
        progressText.textContent = `Scroll halaman Instagram ke bawah... ${msg.count} komentar ditemukan`;
      }

      if (msg.action === 'done') {
        const comments = msg.comments;
        doneBtn.classList.add('hidden');
        progressFill.classList.remove('pulsing');
        scrapingPort = null;

        if (!comments || comments.length === 0) {
          showError('Tidak ada komentar yang ditemukan. Pastikan post memiliki komentar.');
          scrapeBtn.disabled = false;
          return;
        }

        lastComments = comments;
        updateProgress(60, `${comments.length} komentar ditemukan. Menganalisis...`);

        try {
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
      }
    });

    scrapingPort.onDisconnect.addListener(() => {
      if (scrapingPort) {
        // Unexpected disconnect
        scrapingPort = null;
        doneBtn.classList.add('hidden');
        progressFill.classList.remove('pulsing');
        showError('Koneksi terputus. Pastikan halaman Instagram masih terbuka.');
        scrapeBtn.disabled = false;
      }
    });

    // Tell content script to start scraping
    scrapingPort.postMessage({ action: 'start', limit: limit });

  } catch (err) {
    showError(err.message);
    scrapeBtn.disabled = false;
  }
});

// Done button — stop scraping and proceed to analysis
doneBtn.addEventListener('click', () => {
  if (scrapingPort) {
    doneBtn.classList.add('hidden');
    progressText.textContent = 'Menyelesaikan scraping...';
    scrapingPort.postMessage({ action: 'stop' });
  }
});

// Open report in new tab button
document.getElementById('download-btn').addEventListener('click', () => {
  if (lastAnalysis && lastComments.length > 0) {
    openReport(lastAnalysis, lastComments, categorizedComments);
  }
});

// Ensure content script is loaded by pinging first, inject if needed
async function ensureContentScript(tabId) {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(resp);
        }
      });
    });
    if (response && response.pong) return; // Content script already loaded
  } catch {
    // Content script not loaded, inject it
  }

  // Inject content script programmatically
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['content/content.js']
  });

  // Wait a moment for the script to initialize
  await new Promise(r => setTimeout(r, 500));
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

// Open report in a new browser tab via background service worker
function openReport(analysis, comments, categorized) {
  chrome.runtime.sendMessage({
    action: 'openReport',
    data: { analysis, comments, categorized }
  });
}
