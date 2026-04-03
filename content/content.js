// Content script: scrape Instagram post comments with auto-scroll

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeComments') {
    scrapeComments(request.limit || 0)
      .then((comments) => sendResponse({ comments }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep message channel open for async response
  }
});

async function scrapeComments(limit) {
  // Try to expand all comments first by clicking "View all comments" button
  await clickViewAllComments();

  const comments = [];
  const seenTexts = new Set();
  let scrollAttempts = 0;
  const maxScrollAttempts = limit === 0 ? 100 : Math.ceil(limit / 10) + 10;
  let previousCount = 0;
  let noNewCount = 0;

  while (true) {
    // Extract comments currently in the DOM
    const extracted = extractCommentsFromDOM();

    for (const comment of extracted) {
      // Deduplicate by username + text combo
      const key = comment.username + '::' + comment.text;
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

    // Stop if no new comments after 5 consecutive scroll attempts
    if (noNewCount >= 5 || scrollAttempts >= maxScrollAttempts) {
      break;
    }

    // Try to load more comments
    await loadMoreComments();
    scrollAttempts++;

    // Wait for DOM to update
    await sleep(1500);
  }

  return limit > 0 ? comments.slice(0, limit) : comments;
}

function extractCommentsFromDOM() {
  const comments = [];

  // Strategy 1: Find comment elements via article structure
  // Instagram comments are typically inside <ul> elements within the post article
  const commentLists = document.querySelectorAll('ul');

  for (const ul of commentLists) {
    const items = ul.querySelectorAll(':scope > li');
    // Skip lists that are likely navigation or other UI (too few or too many non-comment items)
    if (items.length === 0) continue;

    for (const li of items) {
      const comment = parseCommentElement(li);
      if (comment) {
        comments.push(comment);
      }
    }
  }

  // Strategy 2: If strategy 1 found nothing, try broader selector
  if (comments.length === 0) {
    const spans = document.querySelectorAll('span[dir="auto"]');
    const anchors = document.querySelectorAll('a[role="link"]');

    // Build a map of username -> comment pairs
    const commentContainers = document.querySelectorAll('[role="button"]');
    // Fallback: look for any element structure that has user link + text
    const allLinks = document.querySelectorAll('a[href^="/"]');
    for (const link of allLinks) {
      const href = link.getAttribute('href');
      if (!href || href === '/' || href.includes('/p/') || href.includes('/explore/')) continue;

      const username = href.replace(/\//g, '');
      if (!username || username.includes('?') || username.length > 30) continue;

      // Check if parent/sibling has comment text
      const container = link.closest('div[role="button"]')?.parentElement
        || link.closest('li')
        || link.parentElement?.parentElement;

      if (!container) continue;

      const textSpans = container.querySelectorAll('span[dir="auto"]');
      for (const span of textSpans) {
        const text = span.textContent?.trim();
        if (text && text !== username && text.length > 1 && text.length < 2000) {
          comments.push({
            username: username,
            text: text,
            timestamp: extractTimestamp(container)
          });
          break;
        }
      }
    }
  }

  return comments;
}

function parseCommentElement(li) {
  // Find username link within the comment
  const usernameLink = li.querySelector('a[href^="/"]');
  if (!usernameLink) return null;

  const href = usernameLink.getAttribute('href');
  if (!href || href === '/') return null;

  const username = href.replace(/\//g, '');
  // Filter out non-username links
  if (!username || username.includes('?') || username.includes('explore')
    || username.includes('p/') || username.length > 30) return null;

  // Find comment text - look for span elements with actual text content
  const spans = li.querySelectorAll('span[dir="auto"]');
  let commentText = '';

  for (const span of spans) {
    const text = span.textContent?.trim();
    // Skip if text is just the username, a timestamp, or too short
    if (text && text !== username && text.length > 1 && !isTimestamp(text)) {
      // Pick the longest span as the actual comment
      if (text.length > commentText.length) {
        commentText = text;
      }
    }
  }

  if (!commentText) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li)
  };
}

function extractTimestamp(element) {
  // Instagram timestamps are usually in <time> elements
  const timeEl = element.querySelector('time');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent?.trim() || '';
  }
  return '';
}

function isTimestamp(text) {
  // Common Instagram timestamp patterns
  const patterns = [
    /^\d+[smhd]$/,           // "2h", "5m", "1d"
    /^\d+ (jam|menit|hari|minggu|bulan|tahun)/i,
    /^\d+ (hour|minute|day|week|month|year)/i,
    /^(just now|baru saja)/i,
    /^\d+[wW]$/
  ];
  return patterns.some(p => p.test(text.trim()));
}

async function clickViewAllComments() {
  // Look for "View all X comments" or "Lihat semua X komentar" button
  const buttons = document.querySelectorAll('span, a, button');
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || '';
    if (text.includes('view all') || text.includes('lihat semua')
      || text.includes('load more') || text.includes('muat lebih')) {
      btn.click();
      await sleep(2000);
      return;
    }
  }
}

async function loadMoreComments() {
  // Strategy 1: Click "Load more comments" / "+" button
  const loadMoreSelectors = [
    'button[aria-label="Load more comments"]',
    'button[aria-label="Muat komentar lainnya"]',
    'svg[aria-label="Load more comments"]',
    'svg[aria-label="Muat komentar lainnya"]'
  ];

  for (const selector of loadMoreSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const btn = el.closest('button') || el;
      btn.click();
      await sleep(1000);
      return;
    }
  }

  // Strategy 2: Look for any "load more" type button/icon by traversing the comment area
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    // Instagram's "load more comments" button often has a circle/plus SVG and minimal text
    const svg = btn.querySelector('svg');
    const text = btn.textContent?.trim();
    if (svg && (!text || text.length < 3)) {
      // Could be the load more button - check if it's in the comments area
      const parent = btn.closest('ul') || btn.closest('article');
      if (parent) {
        btn.click();
        await sleep(1000);
        return;
      }
    }
  }

  // Strategy 3: Scroll the comments container
  const commentContainer = findCommentContainer();
  if (commentContainer) {
    commentContainer.scrollTop = commentContainer.scrollHeight;
  }
}

function findCommentContainer() {
  // Try to find the scrollable comments container
  // It's usually a <ul> or <div> that is scrollable within the post
  const candidates = document.querySelectorAll('ul, div');
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) {
      // Check if this element contains comment-like content
      const hasLinks = el.querySelectorAll('a[href^="/"]').length > 2;
      const hasSpans = el.querySelectorAll('span[dir="auto"]').length > 2;
      if (hasLinks && hasSpans) {
        return el;
      }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
