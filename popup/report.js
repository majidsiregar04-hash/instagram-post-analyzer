// Report page: fetch data from background and render

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildTable(list, borderColor) {
  if (!list.length) return '<p class="empty">Tidak ada komentar.</p>';
  let rows = '';
  for (let i = 0; i < list.length; i++) {
    rows += '<tr>'
      + '<td class="num">' + (i + 1) + '</td>'
      + '<td class="user">@' + escapeHTML(list[i].username) + '</td>'
      + '<td class="comment">' + escapeHTML(list[i].text) + '</td>'
      + '</tr>';
  }
  return '<table>'
    + '<thead><tr>'
    + '<th style="border-bottom:2px solid ' + borderColor + '">No</th>'
    + '<th style="border-bottom:2px solid ' + borderColor + '">User</th>'
    + '<th style="border-bottom:2px solid ' + borderColor + '">Komentar</th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
}

function renderReport(data) {
  const { analysis, comments, categorized } = data;
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID');
  const s = analysis.sentimen || {};

  // Topics
  let topicsHtml = '';
  if (analysis.topik && analysis.topik.length > 0) {
    topicsHtml = analysis.topik.map(t => '<span class="topic-tag">' + escapeHTML(t) + '</span>').join('');
  } else {
    topicsHtml = '<p class="empty">Tidak ada topik terdeteksi</p>';
  }

  // Highlights
  let highlightsHtml = '';
  if (analysis.komentar_menarik && analysis.komentar_menarik.length > 0) {
    for (const h of analysis.komentar_menarik) {
      const reason = h.alasan ? '<div class="reason">' + escapeHTML(h.alasan) + '</div>' : '';
      highlightsHtml += '<div class="highlight">'
        + '<div class="user">@' + escapeHTML(h.username || 'anonim') + '</div>'
        + '<div class="text">' + escapeHTML(h.teks || h.text || '') + '</div>'
        + reason + '</div>';
    }
  } else {
    highlightsHtml = '<p class="empty">Tidak ada komentar menarik</p>';
  }

  const html = ''
    // Header
    + '<div class="header">'
    + '<h1>Instagram Comment Analysis</h1>'
    + '<div class="meta"><strong>' + dateStr + '</strong> &nbsp;|&nbsp; ' + timeStr
    + ' &nbsp;|&nbsp; <strong>' + comments.length + '</strong> komentar dianalisis</div></div>'

    // Ringkasan
    + '<div class="section">'
    + '<div class="section-title">Ringkasan</div>'
    + '<div class="summary-box">' + escapeHTML(analysis.ringkasan || '-') + '</div></div>'

    // Sentimen
    + '<div class="section">'
    + '<div class="section-title">Sentimen</div>'
    + '<div class="sentiment-grid">'
    + '<div class="sentiment-card positive"><div class="pct">' + (s.positif || 0) + '%</div><div class="label">Positif</div></div>'
    + '<div class="sentiment-card negative"><div class="pct">' + (s.negatif || 0) + '%</div><div class="label">Negatif</div></div>'
    + '<div class="sentiment-card neutral"><div class="pct">' + (s.netral || 0) + '%</div><div class="label">Netral</div></div>'
    + '</div>'
    + '<div class="sentiment-bar">'
    + '<div class="seg-positive" style="width:' + (s.positif || 0) + '%"></div>'
    + '<div class="seg-negative" style="width:' + (s.negatif || 0) + '%"></div>'
    + '<div class="seg-neutral" style="width:' + (s.netral || 0) + '%"></div>'
    + '</div></div>'

    // Topik
    + '<div class="section">'
    + '<div class="section-title">Topik Utama</div>'
    + '<div>' + topicsHtml + '</div></div>'

    // Highlights
    + '<div class="section">'
    + '<div class="section-title">Komentar Menarik</div>'
    + highlightsHtml + '</div>'

    // Komentar Positif
    + '<div class="section">'
    + '<div class="section-title">Komentar Positif (' + categorized.positif.length + ')</div>'
    + '<div class="cat-header positive">Positif &mdash; ' + categorized.positif.length + ' komentar</div>'
    + buildTable(categorized.positif, '#4caf50') + '</div>'

    // Komentar Negatif
    + '<div class="section">'
    + '<div class="section-title">Komentar Negatif (' + categorized.negatif.length + ')</div>'
    + '<div class="cat-header negative">Negatif &mdash; ' + categorized.negatif.length + ' komentar</div>'
    + buildTable(categorized.negatif, '#f44336') + '</div>'

    // Komentar Netral
    + '<div class="section">'
    + '<div class="section-title">Komentar Netral (' + categorized.netral.length + ')</div>'
    + '<div class="cat-header neutral">Netral &mdash; ' + categorized.netral.length + ' komentar</div>'
    + buildTable(categorized.netral, '#ff9800') + '</div>'

    // Print button
    + '<div class="print-btn-wrap no-print">'
    + '<button class="print-btn" onclick="window.print()">Cetak / Save as PDF</button></div>';

  document.getElementById('loading').style.display = 'none';
  const reportDiv = document.getElementById('report');
  reportDiv.innerHTML = html;
  reportDiv.style.display = 'block';
}

// Fetch data from background service worker
chrome.runtime.sendMessage({ action: 'getReportData' }, (response) => {
  if (response && response.data) {
    renderReport(response.data);
  } else {
    document.getElementById('loading').textContent = 'Gagal memuat data laporan. Silakan coba lagi dari popup.';
  }
});
