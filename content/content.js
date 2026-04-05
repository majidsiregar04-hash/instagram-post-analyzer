// Content script: scrape Instagram post comments with manual scroll

// Scraping state
let scrapingActive = false;
let scrapingInterval = null;
let scrapeInProgress = false;
let seenTexts = new Set();
let allComments = [];
let postOwner = null;
let scrapingLimit = 0;
let scrapingPort = null;

// Keep ping handler for ensureContentScript()
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ pong: true });
    return;
  }
});

// Port-based scraping: popup connects, we continuously scrape
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scraping') return;

  scrapingPort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'start') {
      scrapingLimit = msg.limit || 0;
      await startScraping();
    }
    if (msg.action === 'stop') {
      stopScraping();
    }
  });

  port.onDisconnect.addListener(() => {
    // Popup was closed — clean up
    cleanupScraping();
  });
});

async function startScraping() {
  // Reset state
  scrapingActive = true;
  scrapeInProgress = false;
  seenTexts = new Set();
  allComments = [];
  postOwner = getPostOwnerUsername();

  // Initial expansions
  await expandTruncatedComments();
  await clickViewAllComments();
  await expandHiddenComments();
  await sleep(500);

  // Run first scrape immediately
  await scrapeOnce();

  // Start polling interval (every 1.5 seconds)
  scrapingInterval = setInterval(() => {
    scrapeOnce();
  }, 1500);
}

async function scrapeOnce() {
  if (!scrapingActive || scrapeInProgress) return;
  scrapeInProgress = true;

  try {
    // Expand replies and truncated comments
    await expandReplies();
    await expandTruncatedComments();
    await clickViewAllComments();
    await expandHiddenComments();

    // Extract comments from DOM
    const extracted = extractCommentsFromDOM(postOwner);

    let newCount = 0;
    for (const comment of extracted) {
      const normalizedText = comment.text.replace(/\s+/g, ' ').trim().toLowerCase();
      const key = comment.username.toLowerCase() + '::' + normalizedText;
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        allComments.push(comment);
        newCount++;
      }
    }

    // Send progress update to popup
    if (scrapingPort && newCount > 0) {
      try {
        scrapingPort.postMessage({ action: 'progress', count: allComments.length });
      } catch { /* port disconnected */ }
    }

    // Auto-stop if limit reached
    if (scrapingLimit > 0 && allComments.length >= scrapingLimit) {
      stopScraping();
    }
  } finally {
    scrapeInProgress = false;
  }
}

function stopScraping() {
  if (!scrapingActive) return;
  cleanupScraping();

  // Final dedup
  const finalComments = deduplicateFinal(
    scrapingLimit > 0 ? allComments.slice(0, scrapingLimit) : allComments
  );

  // Send final result
  if (scrapingPort) {
    try {
      scrapingPort.postMessage({ action: 'done', comments: finalComments });
    } catch { /* port disconnected */ }
  }
}

function cleanupScraping() {
  scrapingActive = false;
  if (scrapingInterval) {
    clearInterval(scrapingInterval);
    scrapingInterval = null;
  }
}

// Helper: find the correct root element (handles modal view vs direct page)
function getPostRoot() {
  // Modal view (post opened from feed/explore)
  const dialog = document.querySelector('div[role="dialog"] article');
  if (dialog) return dialog;
  // Direct page view
  const article = document.querySelector('article[role="presentation"]')
    || document.querySelector('article');
  return article || document;
}

// Detect the post owner username from the article header
function getPostOwnerUsername() {
  const root = getPostRoot();
  const header = root.querySelector('header');
  if (header) {
    const link = header.querySelector('a[href^="/"]');
    if (link) {
      const href = link.getAttribute('href');
      if (href && href !== '/') {
        return href.replace(/\//g, '');
      }
    }
  }
  return null;
}

// Final dedup: substring, fuzzy similarity, and cross-user identical text
function deduplicateFinal(comments) {
  const toRemove = new Set();

  for (let i = 0; i < comments.length; i++) {
    if (toRemove.has(i)) continue;
    const userI = comments[i].username.toLowerCase();
    const textI = comments[i].text.replace(/\s+/g, ' ').trim().toLowerCase();

    for (let j = i + 1; j < comments.length; j++) {
      if (toRemove.has(j)) continue;
      const userJ = comments[j].username.toLowerCase();
      if (userI !== userJ) continue;

      const textJ = comments[j].text.replace(/\s+/g, ' ').trim().toLowerCase();

      if (textI.includes(textJ)) {
        toRemove.add(j);
        continue;
      }
      if (textJ.includes(textI)) {
        toRemove.add(i);
        break;
      }

      if (similarity(textI, textJ) > 0.85) {
        if (textI.length >= textJ.length) {
          toRemove.add(j);
        } else {
          toRemove.add(i);
          break;
        }
      }
    }
  }

  // Cross-user dedup: identical long text is a scraping artifact
  const textMap = new Map();
  for (let i = 0; i < comments.length; i++) {
    if (toRemove.has(i)) continue;
    const normText = comments[i].text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normText.length <= 100) continue;
    if (textMap.has(normText)) {
      toRemove.add(i);
    } else {
      textMap.set(normText, i);
    }
  }

  return comments.filter((_, idx) => !toRemove.has(idx));
}

// Bigram-based Dice coefficient for fuzzy matching
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substring(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }
  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.substring(i, i + 2);
    const c = bigramsA.get(bg) || 0;
    if (c > 0) { bigramsA.set(bg, c - 1); matches++; }
  }
  return (2 * matches) / (a.length - 1 + b.length - 1);
}

function extractCommentsFromDOM(postOwner) {
  const comments = [];
  const root = getPostRoot();
  const parsedLis = new Set();

  const commentLists = root.querySelectorAll('ul');

  for (const ul of commentLists) {
    const parentLi = ul.parentElement?.closest('li');
    if (parentLi && parentLi.closest('ul') && root.contains(parentLi.closest('ul'))) {
      const grandParentUl = parentLi.closest('ul');
      if (grandParentUl !== ul && root.contains(grandParentUl)) continue;
    }

    const items = ul.querySelectorAll(':scope > li');
    if (items.length === 0) continue;

    let isFirst = true;
    for (const li of items) {
      if (parsedLis.has(li)) continue;
      parsedLis.add(li);

      const comment = parseCommentElement(li);
      if (comment) {
        if (isFirst && postOwner && comment.username === postOwner) {
          isFirst = false;
          continue;
        }
        isFirst = false;
        comments.push(comment);
      }

      const replyLists = li.querySelectorAll('ul');
      for (const replyUl of replyLists) {
        const replyItems = replyUl.querySelectorAll(':scope > li');
        for (const replyLi of replyItems) {
          if (parsedLis.has(replyLi)) continue;
          parsedLis.add(replyLi);

          const reply = parseCommentElement(replyLi);
          if (reply) {
            reply.isReply = true;
            comments.push(reply);
          }
        }
      }
    }
  }

  if (comments.length === 0) {
    return extractCommentsFallback(postOwner);
  }

  return comments;
}

function extractCommentsFallback(postOwner) {
  const comments = [];
  const root = getPostRoot();

  const allLinks = root.querySelectorAll('a[href^="/"]');
  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')) continue;

    const username = href.replace(/\//g, '');
    if (!username || username.includes('?') || username.length > 30) continue;
    if (username === postOwner) continue;

    const container = link.closest('div[role="button"]')?.parentElement
      || link.closest('li')
      || link.parentElement?.parentElement?.parentElement;

    if (!container) continue;

    const text = collectTextFromContainer(container, username);
    if (text) {
      comments.push({
        username: username,
        text: text,
        timestamp: extractTimestamp(container),
        isReply: false
      });
    }
  }

  return comments;
}

function parseCommentElement(li) {
  const liText = li.textContent || '';
  if (/liked\s+by\s+.+\s+and\s+\d+/i.test(liText) ||
      /disukai\s+oleh\s+.+\s+dan\s+\d+/i.test(liText)) {
    return null;
  }

  const usernameLinks = li.querySelectorAll(':scope > div a[href^="/"], :scope > div > div a[href^="/"]');
  let usernameLink = null;

  for (const link of usernameLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')
      || href.includes('/accounts/')) continue;
    usernameLink = link;
    break;
  }

  if (!usernameLink) {
    const allLinks = li.querySelectorAll('a[href^="/"]');
    if (allLinks.length > 0) {
      const link = allLinks[0];
      const href = link.getAttribute('href');
      if (href && href !== '/' && !href.includes('/p/') && !href.includes('/reel/')
        && !href.includes('/explore/') && !href.includes('/stories/')
        && !href.includes('/accounts/')) {
        usernameLink = link;
      }
    }
  }

  if (!usernameLink) return null;

  const href = usernameLink.getAttribute('href');
  if (!href || href === '/') return null;

  const username = href.replace(/\//g, '');
  if (!username || username.includes('?') || username.includes('explore')
    || username.length > 30) return null;

  const commentText = collectCommentText(li, username);

  if (!commentText) return null;

  if (isNonCommentText(commentText)) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li),
    isReply: false
  };
}

function collectCommentText(li, username) {
  const spans = li.querySelectorAll('span[dir="auto"]');
  let bestText = '';
  let bestDepth = Infinity;

  for (const span of spans) {
    const text = span.textContent?.trim();
    if (!text || text === username || text.length <= 1) continue;
    if (isTimestamp(text) || isActionText(text) || isNonCommentText(text)) continue;

    const parentLi = span.closest('li');
    if (parentLi !== li) continue;

    const parentUl = span.closest('ul');
    const liParentUl = li.closest('ul');
    if (parentUl && liParentUl && parentUl !== liParentUl) {
      const isNested = li.contains(parentUl) && parentUl !== liParentUl;
      if (isNested) continue;
    }

    const depth = getDepth(span, li);

    if (depth < bestDepth || (depth === bestDepth && text.length > bestText.length)) {
      const fullText = collectAdjacentSpanText(span, username);
      if (fullText.length >= text.length) {
        bestText = fullText;
      } else {
        bestText = text;
      }
      bestDepth = depth;
    }
  }

  if (bestText && username) {
    if (bestText.toLowerCase().startsWith(username.toLowerCase())) {
      bestText = bestText.slice(username.length).trim();
    }
    if (bestText.toLowerCase().endsWith(username.toLowerCase())) {
      bestText = bestText.slice(0, -username.length).trim();
    }
  }

  return bestText;
}

function collectAdjacentSpanText(span, username) {
  const parent = span.parentElement;
  if (!parent) return span.textContent?.trim() || '';

  const children = parent.childNodes;
  let combinedText = '';

  for (const child of children) {
    let childText = '';
    if (child.nodeType === Node.TEXT_NODE) {
      childText = child.textContent || '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName?.toLowerCase();
      if (tag === 'img') {
        childText = child.alt || '';
      } else if (tag === 'span' || tag === 'a' || tag === 'br') {
        childText = child.textContent || '';
      }
    }

    const trimmed = childText.trim();
    if (trimmed && trimmed === username) continue;
    if (trimmed && isActionText(trimmed)) continue;
    if (trimmed && isTimestamp(trimmed)) continue;

    combinedText += childText;
  }

  combinedText = combinedText.replace(/\s+/g, ' ').trim();

  const originalText = span.textContent?.trim() || '';
  if (combinedText.length > originalText.length * 2.5 && originalText.length > 5) {
    return originalText;
  }

  if (combinedText && !isActionText(combinedText) && combinedText.length > 1) {
    return combinedText;
  }

  return originalText;
}

function collectTextFromContainer(container, username) {
  const textSpans = container.querySelectorAll('span[dir="auto"]');
  for (const span of textSpans) {
    const text = span.textContent?.trim();
    if (text && text !== username && text.length > 1 && text.length < 2000
      && !isTimestamp(text) && !isActionText(text)) {
      const fullText = collectAdjacentSpanText(span, username);
      return fullText || text;
    }
  }
  return null;
}

function getDepth(element, ancestor) {
  let depth = 0;
  let current = element;
  while (current && current !== ancestor) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function extractTimestamp(element) {
  const timeEl = element.querySelector('time');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
  }
  return '';
}

function isTimestamp(text) {
  const t = text.trim();
  const patterns = [
    /^\d+[smhd]$/,
    /^\d+[wW]$/,
    /^\d+\s*(jam|menit|detik|hari|minggu|bulan|tahun)\s*(yang\s+lalu|lalu)?$/i,
    /^\d+\s*(hour|minute|second|day|week|month|year)s?\s*ago$/i,
    /^(just now|baru saja)$/i,
    /^\d{1,2}\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i
  ];
  return patterns.some(p => p.test(t));
}

function isActionText(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    /^(reply|balas)$/i,
    /^(like|suka|liked|disukai)$/i,
    /^view\s+(all\s+)?\d*\s*(replies|comments)/i,
    /^lihat\s+(semua\s+)?\d*\s*(balasan|komentar)/i,
    /^hide\s+(all\s+)?\d*\s*(replies|comments)/i,
    /^sembunyikan\s+(semua\s+)?\d*\s*(balasan|komentar)/i,
    /^(see\s+translation|lihat\s+terjemahan)$/i,
    /^(translate|terjemahkan)$/i,
    /^(report|laporkan)$/i,
    /^(delete|hapus)$/i,
    /^(edited|diedit)$/i,
    /^(load\s+more|muat\s+lebih|muat\s+lainnya)$/i,
    /^(more|lagi|selengkapnya)$/i,
    /^\d+\s*(likes?|suka)$/i,
    /^(send|kirim)$/i
  ];
  return patterns.some(p => p.test(lower));
}

function isNonCommentText(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    /^liked\s+by\s+/i,
    /^disukai\s+oleh\s+/i,
    /^\d+\s+(others?|lainnya)$/i,
    /^(and|dan)\s+\d+\s+(others?|lainnya)/i,
    /^view\s+all\s+\d+\s+likes?$/i,
    /^lihat\s+semua\s+\d+\s+suka$/i,
    /^\d[\d,.]+\s*(likes?|suka)$/i,
    /^(add\s+a\s+comment|tambahkan\s+komentar)/i,
    /^(log\s+in|masuk)\s+/i
  ];
  return patterns.some(p => p.test(lower));
}

async function expandTruncatedComments() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, button, div[role="button"]');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.trim()?.toLowerCase() || '';
    if ((text === 'more' || text === 'lagi' || text === 'selengkapnya')
      && btn.offsetParent !== null) {
      btn.click();
      clicked = true;
    }
  }
  if (clicked) {
    await sleep(300);
  }
}

async function clickViewAllComments() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, a, button, div[role="button"]');
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase()?.trim() || '';
    if ((text.includes('view all') && text.includes('comment'))
      || (text.includes('lihat semua') && text.includes('komentar'))
      || text.includes('load more comments')
      || text.includes('muat lebih banyak komentar')) {
      btn.click();
      await sleep(1500);
      return true;
    }
  }
  return false;
}

async function expandHiddenComments() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, button, div[role="button"], a');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase()?.trim() || '';
    if ((/view\s+hidden\s+comment/i.test(text)
      || /lihat\s+komentar\s+tersembunyi/i.test(text)
      || /hidden\s+comment/i.test(text)
      || /komentar\s+tersembunyi/i.test(text))
      && !/hide|sembunyikan/i.test(text)
      && btn.offsetParent !== null) {
      btn.click();
      clicked = true;
      await sleep(800);
    }
  }
  if (clicked) {
    await sleep(500);
  }
}

async function expandReplies() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, button, div[role="button"]');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase()?.trim() || '';
    if ((/view\s+(\d+\s+)?repl/i.test(text) || /lihat\s+(\d+\s+)?balasan/i.test(text))
      && !/hide|sembunyikan/i.test(text)) {
      btn.click();
      clicked = true;
      await sleep(400);
    }
  }
  if (clicked) {
    await sleep(800);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
