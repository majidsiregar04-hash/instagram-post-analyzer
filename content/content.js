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

    if (noNewCount >= 8 || scrollAttempts >= maxScrollAttempts) {
      break;
    }

    await loadMoreComments();
    scrollAttempts++;
    await waitForDOMUpdate(800);
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

// Simplified comment parser: find username, then get text from the right container
function parseCommentFromLi(li) {
  // Find username link
  const usernameLink = findUsernameLink(li);
  if (!usernameLink) return null;

  const href = usernameLink.getAttribute('href');
  if (!href || href === '/') return null;

  const username = href.replace(/\//g, '');
  if (!username || username.includes('?') || username.includes('explore')
    || username.length > 30) return null;

  // Strategy: find the text container that holds the comment
  // In Instagram's DOM, the comment text is typically in a <span> container
  // that is a sibling or near-sibling of the username element
  const commentText = extractCommentText(li, username, usernameLink);

  if (!commentText || commentText.length < 1) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li),
    isReply: false
  };
}

function findUsernameLink(li) {
  // Try direct children first
  const links = li.querySelectorAll('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')
      || href.includes('/accounts/')) continue;
    // Check it looks like a username link (short text, no weird paths)
    const text = link.textContent?.trim();
    if (text && text.length > 0 && text.length <= 30 && !text.includes(' ')) {
      return link;
    }
    // Also accept if href is simple /username/
    const cleanHref = href.replace(/\//g, '');
    if (cleanHref.length > 0 && cleanHref.length <= 30 && !cleanHref.includes('?')) {
      return link;
    }
  }
  return null;
}

// Extract comment text using innerText from the right container
function extractCommentText(li, username, usernameLink) {
  // Find the container that holds both the username and the comment text
  // Walk up from usernameLink to find the comment content div
  // Then get its full text and strip the username part

  // Approach 1: Find the closest common container of username + comment text
  // In IG's DOM, the comment is in a span near the username span
  // The parent of the username link often contains the comment text too

  // Try: get the parent container that holds the comment block
  let textContainer = usernameLink.parentElement;

  // Walk up a few levels to find a container with substantial text
  for (let i = 0; i < 4; i++) {
    if (!textContainer || textContainer === li) break;
    const innerText = getCleanInnerText(textContainer);
    // If this container has more text than just the username, use it
    if (innerText.length > username.length + 5) {
      break;
    }
    textContainer = textContainer.parentElement;
  }

  if (!textContainer || textContainer === li) {
    // Fallback: use the li's direct text content approach
    textContainer = li;
  }

  // Get innerText of the text container
  let fullText = getCleanInnerText(textContainer);

  // Strip the username from the beginning
  if (fullText.startsWith(username)) {
    fullText = fullText.slice(username.length).trim();
  }
  // Also handle case-insensitive match
  if (fullText.toLowerCase().startsWith(username.toLowerCase())) {
    fullText = fullText.slice(username.length).trim();
  }

  // Remove trailing action texts (Reply, Balas, timestamps, likes count, etc.)
  fullText = stripTrailingActions(fullText);

  // Remove leading/trailing whitespace and normalize
  fullText = fullText.replace(/\s+/g, ' ').trim();

  // Validate: not too short, not just action text
  if (!fullText || fullText.length < 1 || isActionText(fullText) || isTimestamp(fullText)) {
    return null;
  }

  return fullText;
}

// Get cleaned innerText, excluding nested reply lists and action buttons
function getCleanInnerText(element) {
  // Clone the element to manipulate without affecting DOM
  const clone = element.cloneNode(true);

  // Remove nested <ul> elements (reply threads)
  clone.querySelectorAll('ul').forEach(ul => ul.remove());

  // Remove time elements
  clone.querySelectorAll('time').forEach(t => t.remove());

  // Remove buttons that are action buttons (Reply, Like, etc.)
  clone.querySelectorAll('button').forEach(btn => {
    const text = btn.textContent?.trim()?.toLowerCase() || '';
    if (isActionText(text) || text.length < 15) {
      btn.remove();
    }
  });

  // Remove "View replies" / "Lihat balasan" spans/divs
  clone.querySelectorAll('span, div[role="button"]').forEach(el => {
    const text = el.textContent?.trim()?.toLowerCase() || '';
    if (isActionText(text) || isTimestamp(text)) {
      el.remove();
    }
  });

  // Remove SVG icons
  clone.querySelectorAll('svg').forEach(svg => svg.remove());

  // Get the remaining text
  let text = clone.innerText || clone.textContent || '';

  // Replace image alt text (emoji) properly
  // Actually innerText should handle this fine

  return text.replace(/\s+/g, ' ').trim();
}

// Strip trailing action text patterns from comment text
function stripTrailingActions(text) {
  // Common trailing patterns: "Reply", "Balas", "1h", "2d", "3 suka", etc.
  // These appear after the comment text in the container
  const trailingPatterns = [
    /\s+(Reply|Balas|Suka|Like|Liked|Send|Kirim)\s*$/i,
    /\s+\d+\s*(jam|menit|detik|hari|minggu|bulan|tahun)\s*(yang\s+lalu|lalu)?\s*$/i,
    /\s+\d+\s*(hour|minute|second|day|week|month|year)s?\s*ago\s*$/i,
    /\s+\d+[smhdwSMHDW]\s*$/,
    /\s+\d+\s*(likes?|suka)\s*$/i,
    /\s+(just now|baru saja)\s*$/i,
    /\s+See translation\s*$/i,
    /\s+Lihat terjemahan\s*$/i,
    /\s+(Edited|Diedit)\s*$/i,
    /\s+\d{1,2}\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*$/i
  ];

  let result = text;
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    changed = false;
    iterations++;
    for (const pattern of trailingPatterns) {
      const newResult = result.replace(pattern, '');
      if (newResult !== result) {
        result = newResult;
        changed = true;
      }
    }
  }

  return result.trim();
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
        && !isTimestamp(text) && !isActionText(text)) {
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
      await sleep(800);
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
        await sleep(800);
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
      await sleep(800);
      return;
    }
  }

  const commentContainer = findCommentContainer();
  if (commentContainer) {
    commentContainer.scrollTop = commentContainer.scrollHeight;
    await sleep(400);
    if (commentContainer.scrollTop > 200) {
      commentContainer.scrollTop = Math.max(0, commentContainer.scrollTop - 150);
      await sleep(200);
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
