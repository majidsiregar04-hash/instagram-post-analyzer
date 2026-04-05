// Content script: scrape Instagram post comments with auto-scroll

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeComments') {
    scrapeComments(request.limit || 0)
      .then((comments) => sendResponse({ comments }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (request.action === 'ping') {
    sendResponse({ pong: true });
    return;
  }
});

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
  // The first username link in the header area is typically the post owner
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

async function scrapeComments(limit) {
  // Expand truncated comments first
  await expandTruncatedComments();

  // Try to expand all comments
  await clickViewAllComments();

  // Try to expand hidden comments
  await expandHiddenComments();

  await sleep(1000);

  const comments = [];
  const seenTexts = new Set();
  let scrollAttempts = 0;
  const maxScrollAttempts = limit === 0 ? 200 : Math.ceil(limit / 10) + 20;
  let previousCount = 0;
  let noNewCount = 0;
  const postOwner = getPostOwnerUsername();

  while (true) {
    // Try to click "View all comments" again
    await clickViewAllComments();

    // Expand reply threads (with retry)
    await expandReplies();
    await sleep(300);
    await expandReplies(); // retry for newly appeared buttons

    // Expand truncated comments
    await expandTruncatedComments();

    // Extract comments currently in the DOM
    const extracted = extractCommentsFromDOM(postOwner);

    for (const comment of extracted) {
      // Normalize dedup key: collapse whitespace, lowercase
      const normalizedText = comment.text.replace(/\s+/g, ' ').trim().toLowerCase();
      const key = comment.username.toLowerCase() + '::' + normalizedText;
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        comments.push(comment);
      }
    }

    // Check if we reached the limit
    if (limit > 0 && comments.length >= limit) {
      return comments.slice(0, limit);
    }

    // Check if we've exhausted scrolling
    if (comments.length === previousCount) {
      noNewCount++;
    } else {
      noNewCount = 0;
      previousCount = comments.length;
    }

    // Stop if no new comments after 8 consecutive scroll attempts
    if (noNewCount >= 8 || scrollAttempts >= maxScrollAttempts) {
      break;
    }

    // Try to load more comments
    await loadMoreComments();
    scrollAttempts++;

    // Wait for DOM to update
    await waitForDOMUpdate(800);
  }

  const result = limit > 0 ? comments.slice(0, limit) : comments;

  // Final dedup pass
  return deduplicateFinal(result);
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

      // Fuzzy similarity check
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
  const parsedLis = new Set(); // Track parsed <li> elements to avoid duplicates

  // Strategy 1: Find comment lists within the article
  // Only iterate top-level <ul> (skip nested reply <ul> in outer loop)
  const commentLists = root.querySelectorAll('ul');

  for (const ul of commentLists) {
    // Skip this <ul> if it's nested inside an <li> that's inside another <ul>
    // (i.e., it's a reply sub-list, not the main comment list)
    const parentLi = ul.parentElement?.closest('li');
    if (parentLi && parentLi.closest('ul') && root.contains(parentLi.closest('ul'))) {
      // This is a nested reply list - skip in outer loop, will be handled in inner loop
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
        // Skip caption (first comment from post owner)
        if (isFirst && postOwner && comment.username === postOwner) {
          isFirst = false;
          continue;
        }
        isFirst = false;
        comments.push(comment);
      }

      // Also extract replies within this li (nested ul > li)
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

  // Strategy 2: If strategy 1 found nothing, try fallback
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
    if (username === postOwner) continue; // skip post owner in fallback

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
  // Skip likes section ("Liked by X and 598 others")
  const liText = li.textContent || '';
  if (/liked\s+by\s+.+\s+and\s+\d+/i.test(liText) ||
      /disukai\s+oleh\s+.+\s+dan\s+\d+/i.test(liText)) {
    return null;
  }

  // Find username link - prefer first link in shallow depth (comment author)
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
    // Fallback: first link in the li
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

  // Collect comment text by combining adjacent spans (handles emoji splitting)
  const commentText = collectCommentText(li, username);

  if (!commentText) return null;

  // Filter out non-comment text (likes, engagement info)
  if (isNonCommentText(commentText)) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li),
    isReply: false
  };
}

// Collect comment text by combining spans, handling emoji splitting
function collectCommentText(li, username) {
  // Find the comment text container - usually a span or div near the username
  // that contains the actual comment with possibly split emoji spans
  const spans = li.querySelectorAll('span[dir="auto"]');
  let bestText = '';
  let bestDepth = Infinity;

  for (const span of spans) {
    const text = span.textContent?.trim();
    if (!text || text === username || text.length <= 1) continue;
    if (isTimestamp(text) || isActionText(text) || isNonCommentText(text)) continue;

    // Skip spans inside nested reply lists
    const parentLi = span.closest('li');
    if (parentLi !== li) continue;

    // Skip spans inside nested ul (reply threads)
    const parentUl = span.closest('ul');
    const liParentUl = li.closest('ul');
    if (parentUl && liParentUl && parentUl !== liParentUl) {
      // span is inside a nested ul within this li - skip
      const isNested = li.contains(parentUl) && parentUl !== liParentUl;
      if (isNested) continue;
    }

    const depth = getDepth(span, li);

    // Prefer shallower spans (closer to the comment root)
    if (depth < bestDepth || (depth === bestDepth && text.length > bestText.length)) {
      // Try to get full text including emoji by going up to parent and collecting all child text
      const fullText = collectAdjacentSpanText(span, username);
      if (fullText.length >= text.length) {
        bestText = fullText;
      } else {
        bestText = text;
      }
      bestDepth = depth;
    }
  }

  // Strip username from result if it appears at start/end
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

// Collect text from a span and its adjacent sibling spans (emoji splitting fix)
function collectAdjacentSpanText(span, username) {
  const parent = span.parentElement;
  if (!parent) return span.textContent?.trim() || '';

  // Collect text from sibling nodes, but filter out username/action/timestamp text
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
    // Skip if this child's text is the username, action text, or timestamp
    if (trimmed && trimmed === username) continue;
    if (trimmed && isActionText(trimmed)) continue;
    if (trimmed && isTimestamp(trimmed)) continue;

    combinedText += childText;
  }

  // Normalize whitespace
  combinedText = combinedText.replace(/\s+/g, ' ').trim();

  // Sanity check: if combined text is unreasonably longer than the original span,
  // it probably grabbed too much - fall back to original span text
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
  // Regex patterns for action text with variable numbers
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

// Detect non-comment text: likes section, engagement info
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

// Expand truncated comments ("more" / "lagi" buttons)
async function expandTruncatedComments() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, button, div[role="button"]');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.trim()?.toLowerCase() || '';
    // Match "more" / "lagi" / "selengkapnya" but only short text (not "load more comments")
    if ((text === 'more' || text === 'lagi' || text === 'selengkapnya')
      && btn.offsetParent !== null) { // visible
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

async function loadMoreComments() {
  const root = getPostRoot();

  // Strategy 1: Click by aria-label
  const loadMoreSelectors = [
    'button[aria-label="Load more comments"]',
    'button[aria-label="Muat komentar lainnya"]',
    'svg[aria-label="Load more comments"]',
    'svg[aria-label="Muat komentar lainnya"]',
    'button[aria-label="View more comments"]',
    'button[aria-label="Lihat komentar lainnya"]'
  ];

  for (const selector of loadMoreSelectors) {
    const el = root.querySelector(selector);
    if (el) {
      const btn = el.closest('button') || el;
      btn.click();
      await sleep(800);
      return;
    }
  }

  // Strategy 2: Text-based load more buttons
  const spans = root.querySelectorAll('span, div[role="button"]');
  for (const el of spans) {
    const text = el.textContent?.toLowerCase()?.trim() || '';
    if (text === 'load more' || text === 'muat lainnya' || text === 'more comments'
      || text === 'komentar lainnya') {
      el.click();
      await sleep(800);
      return;
    }
  }

  // Strategy 3: Container scroll (modal view)
  const commentContainer = findCommentContainer();
  if (commentContainer) {
    commentContainer.scrollTop = commentContainer.scrollHeight;
    await sleep(400);
    if (commentContainer.scrollTop > 200) {
      commentContainer.scrollTop = Math.max(0, commentContainer.scrollTop - 150);
      await sleep(200);
      commentContainer.scrollTop = commentContainer.scrollHeight;
    }
    return;
  }

  // Strategy 4: Page-level scroll (direct post pages where whole page scrolls)
  window.scrollTo(0, document.documentElement.scrollHeight);
  await sleep(400);
  window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - 200));
  await sleep(200);
  window.scrollTo(0, document.documentElement.scrollHeight);
}

function findCommentContainer() {
  // Only look for scrollable containers in modal view (dialog).
  // On direct post pages the whole page scrolls via window.scrollTo,
  // so we must return null to let the page-level scroll fallback handle it.
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return null;

  const divs = dialog.querySelectorAll('div');
  for (const div of divs) {
    if (div.clientHeight < 50) continue;
    const hasScroll = div.scrollHeight > div.clientHeight + 20;
    const style = window.getComputedStyle(div);
    const hasOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (!hasScroll && !hasOverflow) continue;
    // Must contain comment-like content (multiple user links + text spans)
    const hasLinks = div.querySelectorAll('a[href^="/"]').length > 2;
    const hasSpans = div.querySelectorAll('span[dir="auto"]').length > 2;
    if (hasLinks && hasSpans) return div;
  }

  // Fallback: any scrollable div in the dialog
  for (const div of divs) {
    if (div.clientHeight < 50) continue;
    const style = window.getComputedStyle(div);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      return div;
    }
  }

  return null;
}

function waitForDOMUpdate(timeout) {
  return new Promise(resolve => {
    const root = getPostRoot();
    const target = (root === document) ? document.body : root;
    let resolved = false;

    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        setTimeout(resolve, 200);
      }
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        resolve();
      }
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
