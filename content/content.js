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
  const dialog = document.querySelector('div[role="dialog"] article');
  if (dialog) return dialog;
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

async function scrapeComments(limit) {
  await expandTruncatedComments();
  await clickViewAllComments();
  await expandHiddenComments();
  await sleep(1000);

  const comments = [];
  const seenKeys = new Set();
  let scrollAttempts = 0;
  const maxScrollAttempts = limit === 0 ? 200 : Math.ceil(limit / 10) + 20;
  let previousCount = 0;
  let noNewCount = 0;
  const postOwner = getPostOwnerUsername();

  while (true) {
    await clickViewAllComments();
    await expandReplies();
    await sleep(300);
    await expandReplies();
    await expandHiddenComments();
    await expandTruncatedComments();

    const extracted = extractCommentsFromDOM(postOwner);

    for (const comment of extracted) {
      const key = makeDedupeKey(comment.username, comment.text);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        comments.push(comment);
      }
    }

    if (limit > 0 && comments.length >= limit) {
      return deduplicateFinal(comments.slice(0, limit));
    }

    if (comments.length === previousCount) {
      noNewCount++;
    } else {
      noNewCount = 0;
      previousCount = comments.length;
    }

    if (noNewCount >= 6 || scrollAttempts >= maxScrollAttempts) {
      break;
    }

    // Track scroll position to detect stall
    const container = findCommentContainer();
    const prevScrollHeight = container ? container.scrollHeight : 0;

    await loadMoreComments();
    scrollAttempts++;
    await waitForDOMUpdate(800);

    // If scroll didn't change AND no new comments, accelerate termination
    const newScrollHeight = container ? container.scrollHeight : 0;
    if (container && newScrollHeight === prevScrollHeight && comments.length === previousCount && noNewCount >= 2) {
      noNewCount++;
    }
  }

  const result = limit > 0 ? comments.slice(0, limit) : comments;
  return deduplicateFinal(result);
}

// Create a normalized dedup key
function makeDedupeKey(username, text) {
  const normUser = username.toLowerCase().trim();
  // Normalize: lowercase, collapse whitespace, remove zero-width chars
  const normText = text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normUser + '::' + normText;
}

// Final dedup: remove substring duplicates AND fuzzy duplicates from same user
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

      // Substring check
      if (textI.includes(textJ)) {
        toRemove.add(j);
        continue;
      }
      if (textJ.includes(textI)) {
        toRemove.add(i);
        break;
      }

      // Fuzzy similarity check (for near-duplicate with slight differences)
      if (similarity(textI, textJ) > 0.85) {
        // Keep the longer one
        if (textI.length >= textJ.length) {
          toRemove.add(j);
        } else {
          toRemove.add(i);
          break;
        }
      }
    }
  }

  // Cross-user dedup: identical long text across different users is a scraping artifact
  // (e.g., parent comment text leaking into all reply entries)
  const textMap = new Map();
  for (let i = 0; i < comments.length; i++) {
    if (toRemove.has(i)) continue;
    const normText = comments[i].text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normText.length <= 100) continue; // only for long text
    if (textMap.has(normText)) {
      toRemove.add(i); // remove later duplicate
    } else {
      textMap.set(normText, i);
    }
  }

  return comments.filter((_, idx) => !toRemove.has(idx));
}

// Simple similarity ratio (bigram-based Dice coefficient)
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bigram = a.substring(i, i + 2);
    bigramsA.set(bigram, (bigramsA.get(bigram) || 0) + 1);
  }

  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bigram = b.substring(i, i + 2);
    const count = bigramsA.get(bigram) || 0;
    if (count > 0) {
      bigramsA.set(bigram, count - 1);
      matches++;
    }
  }

  return (2 * matches) / (a.length - 1 + b.length - 1);
}

function extractCommentsFromDOM(postOwner) {
  const comments = [];
  const root = getPostRoot();
  const processedLis = new Set();

  // Find all comment <ul> lists within the article
  const commentLists = root.querySelectorAll('ul');

  for (const ul of commentLists) {
    // Skip nested reply lists in outer loop
    const parentLi = ul.parentElement?.closest('li');
    if (parentLi && parentLi.closest('ul') && root.contains(parentLi.closest('ul'))) {
      const grandParentUl = parentLi.closest('ul');
      if (grandParentUl !== ul && root.contains(grandParentUl)) continue;
    }

    const items = ul.querySelectorAll(':scope > li');
    if (items.length === 0) continue;

    let isFirst = true;
    for (const li of items) {
      if (processedLis.has(li)) continue;
      processedLis.add(li);

      const comment = parseCommentFromLi(li);
      if (comment) {
        if (isFirst && postOwner && comment.username === postOwner) {
          isFirst = false;
          continue;
        }
        isFirst = false;
        comments.push(comment);
      }

      // Extract replies within this li
      const replyLists = li.querySelectorAll('ul');
      for (const replyUl of replyLists) {
        const replyItems = replyUl.querySelectorAll(':scope > li');
        for (const replyLi of replyItems) {
          if (processedLis.has(replyLi)) continue;
          processedLis.add(replyLi);

          const reply = parseCommentFromLi(replyLi);
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

// Parse a comment from an <li> element
function parseCommentFromLi(li) {
  // Skip <li> elements that are part of the likes section
  const liText = li.textContent || '';
  if (isNonCommentText(liText.trim())) return null;

  // Also check if the li contains "liked by" / "disukai oleh" anywhere
  if (/liked\s+by\s+.+\s+and\s+\d+/i.test(liText) ||
      /disukai\s+oleh\s+.+\s+dan\s+\d+/i.test(liText)) {
    return null;
  }

  // Find username link
  const usernameLink = findUsernameLink(li);
  if (!usernameLink) return null;

  const href = usernameLink.getAttribute('href');
  if (!href || href === '/') return null;

  const username = href.replace(/\//g, '');
  if (!username || username.includes('?') || username.includes('explore')
    || username.length > 30) return null;

  // Find the best comment text span
  const commentText = extractCommentText(li, username);

  if (!commentText || commentText.length < 1) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li),
    isReply: false
  };
}

function findUsernameLink(li) {
  // The comment author username is always the FIRST link in the comment <li>.
  // Mentioned usernames (@someone) appear later inside the comment text.
  // We only look at links in the first few levels of depth, not deep inside text spans.
  const links = li.querySelectorAll(':scope > div a[href^="/"], :scope > div > div a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')
      || href.includes('/accounts/')) continue;
    const cleanHref = href.replace(/\//g, '');
    if (cleanHref.length > 0 && cleanHref.length <= 30 && !cleanHref.includes('?')) {
      return link;
    }
  }
  // Fallback: first link in the li
  const allLinks = li.querySelectorAll('a[href^="/"]');
  if (allLinks.length > 0) {
    const link = allLinks[0];
    const href = link.getAttribute('href');
    if (href && href !== '/' && !href.includes('/p/') && !href.includes('/reel/')
      && !href.includes('/explore/') && !href.includes('/stories/')
      && !href.includes('/accounts/')) {
      const cleanHref = href.replace(/\//g, '');
      if (cleanHref.length > 0 && cleanHref.length <= 30 && !cleanHref.includes('?')) {
        return link;
      }
    }
  }
  return null;
}

// Extract comment text: find the right span[dir="auto"] that contains the comment
function extractCommentText(li, username) {
  // Instagram puts comment text in span[dir="auto"] elements
  // We want the one that is the actual comment, not username/action/timestamp
  const spans = li.querySelectorAll('span[dir="auto"]');
  const usernameLink = findUsernameLink(li);

  // Helper: check if a span is a valid comment text candidate
  function isValidCommentSpan(span) {
    const parentLi = span.closest('li');
    if (parentLi !== li) return false;

    const text = span.textContent?.trim();
    if (!text || text.length < 1) return false;
    if (text === username) return false;
    if (isActionText(text) || isTimestamp(text) || isNonCommentText(text)) return false;
    return true;
  }

  // Pass 1: Find first valid span AFTER the username link (most reliable for replies)
  let bestText = '';
  if (usernameLink) {
    for (const span of spans) {
      if (!isValidCommentSpan(span)) continue;

      // Check this span comes after the username link in DOM order
      if (usernameLink.compareDocumentPosition(span) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const fullText = collectSpanText(span, username, li);
        if (fullText && !isNonCommentText(fullText)) {
          bestText = fullText;
          break; // Take the FIRST valid one, not the longest
        }
      }
    }
  }

  // Pass 2: Fallback to longest valid span if pass 1 found nothing
  if (!bestText) {
    for (const span of spans) {
      if (!isValidCommentSpan(span)) continue;

      const fullText = collectSpanText(span, username, li);
      if (!fullText || isNonCommentText(fullText)) continue;

      if (fullText.length > bestText.length) {
        bestText = fullText;
      }
    }
  }

  // Clean up: strip username prefix/suffix
  if (bestText && username) {
    if (bestText.toLowerCase().startsWith(username.toLowerCase())) {
      bestText = bestText.slice(username.length).trim();
    }
    if (bestText.toLowerCase().endsWith(username.toLowerCase())) {
      bestText = bestText.slice(0, -username.length).trim();
    }
  }

  // Final check: reject non-comment text after cleanup
  if (bestText && isNonCommentText(bestText)) return '';

  return bestText;
}

// Collect text from a span and its siblings (handles emoji split across spans)
// boundaryEl: the <li> element that this span must stay within
function collectSpanText(span, username, boundaryEl) {
  const parent = span.parentElement;
  if (!parent) return span.textContent?.trim() || '';

  // Ensure parent is within the boundary <li> element
  // If parent escaped the li, just return the span's own text
  if (boundaryEl && !boundaryEl.contains(parent)) {
    return span.textContent?.trim() || '';
  }

  // Check if parent has multiple child nodes (emoji splitting case)
  const children = parent.childNodes;
  if (children.length <= 1) return span.textContent?.trim() || '';

  // Combine all child text/emoji, filtering out username and action text
  let combined = '';
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
    if (trimmed === username) continue;
    if (trimmed && isActionText(trimmed)) continue;
    if (trimmed && isTimestamp(trimmed)) continue;

    combined += childText;
  }

  combined = combined.replace(/\s+/g, ' ').trim();

  // Sanity check: if combined is way too long, original span text is safer
  const originalText = span.textContent?.trim() || '';
  if (combined.length > originalText.length * 3 && originalText.length > 5) {
    return originalText;
  }

  return combined || originalText;
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

    const spans = container.querySelectorAll('span[dir="auto"]');
    for (const span of spans) {
      const text = span.textContent?.trim();
      if (text && text !== username && text.length > 1 && text.length < 2000
        && !isTimestamp(text) && !isActionText(text) && !isNonCommentText(text)) {
        comments.push({
          username: username,
          text: text,
          timestamp: extractTimestamp(container),
          isReply: false
        });
        break;
      }
    }
  }

  return comments;
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

// Detect non-comment text: likes section, "others" text, engagement info
function isNonCommentText(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    // "Liked by X and 598 others" / "Disukai oleh X dan 598 lainnya"
    /^liked\s+by\s+.+\s+and\s+\d+/i,
    /^disukai\s+oleh\s+.+\s+dan\s+\d+/i,
    /^liked\s+by\s+/i,
    /^disukai\s+oleh\s+/i,
    // "X others" / "X lainnya"
    /^\d+\s+(others?|lainnya)$/i,
    // "and X others" / "dan X lainnya"
    /^(and|dan)\s+\d+\s+(others?|lainnya)/i,
    // View likes
    /^view\s+all\s+\d+\s+likes?$/i,
    /^lihat\s+semua\s+\d+\s+suka$/i,
    // "X likes" standalone
    /^\d[\d,.]+\s*(likes?|suka)$/i,
    // Post date text
    /^\d+\s*(January|February|March|April|May|June|July|August|September|October|November|December|Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)/i,
    // "Add a comment" placeholder
    /^(add\s+a\s+comment|tambahkan\s+komentar)/i,
    // "Log in to like" etc.
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

// Click "View hidden comments" / "Lihat komentar tersembunyi" button
async function expandHiddenComments() {
  const root = getPostRoot();
  const buttons = root.querySelectorAll('span, button, div[role="button"], a');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase()?.trim() || '';
    if ((/view\s+hidden\s+comment/i.test(text)
      || /lihat\s+komentar\s+tersembunyi/i.test(text)
      || /hidden\s+comment/i.test(text)
      || /komentar\s+tersembunyi/i.test(text)
      || /view\s+hidden\s+repl/i.test(text)
      || /lihat\s+balasan\s+tersembunyi/i.test(text))
      && !/hide|sembunyikan/i.test(text)
      && btn.offsetParent !== null) {
      btn.click();
      clicked = true;
      await randomDelay(600, 1000);
    }
  }
  if (clicked) {
    await sleep(800);
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
      await randomDelay(600, 1000);
      return;
    }
  }

  const allButtons = root.querySelectorAll('button');
  for (const btn of allButtons) {
    const svg = btn.querySelector('svg');
    const text = btn.textContent?.trim();
    if (svg && (!text || text.length < 3)) {
      const parent = btn.closest('ul') || btn.closest('section');
      if (parent) {
        btn.click();
        await randomDelay(600, 1000);
        return;
      }
    }
  }

  const spans = root.querySelectorAll('span, div[role="button"]');
  for (const el of spans) {
    const text = el.textContent?.toLowerCase()?.trim() || '';
    if (text === 'load more' || text === 'muat lainnya' || text === 'more comments'
      || text === 'komentar lainnya') {
      el.click();
      await randomDelay(600, 1000);
      return;
    }
  }

  const commentContainer = findCommentContainer();
  if (commentContainer) {
    // Always scroll to bottom to trigger lazy loading of more comments
    commentContainer.scrollTop = commentContainer.scrollHeight;
    await randomDelay(300, 600);
    if (commentContainer.scrollTop > 200) {
      commentContainer.scrollTop = Math.max(0, commentContainer.scrollTop - 150);
      await randomDelay(150, 350);
      commentContainer.scrollTop = commentContainer.scrollHeight;
    }
  }
}

function findCommentContainer() {
  const root = getPostRoot();

  const sections = root.querySelectorAll('section, div[role="presentation"], div[role="dialog"]');
  for (const section of sections) {
    if (section.scrollHeight > section.clientHeight + 50 && section.clientHeight > 100) {
      const hasLinks = section.querySelectorAll('a[href^="/"]').length > 2;
      const hasSpans = section.querySelectorAll('span[dir="auto"]').length > 2;
      if (hasLinks && hasSpans) {
        return section;
      }
    }
  }

  const candidates = root.querySelectorAll('ul, div');
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) {
      const hasLinks = el.querySelectorAll('a[href^="/"]').length > 2;
      const hasSpans = el.querySelectorAll('span[dir="auto"]').length > 2;
      if (hasLinks && hasSpans) {
        return el;
      }
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

function randomDelay(min, max) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}
