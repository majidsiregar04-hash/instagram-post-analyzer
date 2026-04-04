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
  // Try to expand all comments first
  await clickViewAllComments();
  await sleep(1000);

  const comments = [];
  const seenTexts = new Set();
  let scrollAttempts = 0;
  const maxScrollAttempts = limit === 0 ? 150 : Math.ceil(limit / 10) + 15;
  let previousCount = 0;
  let noNewCount = 0;

  while (true) {
    // Try to click "View all comments" again in case it reappeared
    await clickViewAllComments();

    // Expand reply threads
    await expandReplies();

    // Extract comments currently in the DOM
    const extracted = extractCommentsFromDOM();

    for (const comment of extracted) {
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

    // Stop if no new comments after 7 consecutive scroll attempts
    if (noNewCount >= 7 || scrollAttempts >= maxScrollAttempts) {
      break;
    }

    // Try to load more comments
    await loadMoreComments();
    scrollAttempts++;

    // Wait for DOM to update with adaptive timing
    await waitForDOMUpdate(800);
  }

  return limit > 0 ? comments.slice(0, limit) : comments;
}

function extractCommentsFromDOM() {
  const comments = [];

  // Scope to article element to avoid picking up navigation/sidebar
  const article = document.querySelector('article');
  if (!article) {
    // Fallback: try broader search
    return extractCommentsFallback();
  }

  // Strategy 1: Find comment lists within the article
  const commentLists = article.querySelectorAll('ul');

  for (const ul of commentLists) {
    const items = ul.querySelectorAll(':scope > li');
    if (items.length === 0) continue;

    for (const li of items) {
      const comment = parseCommentElement(li);
      if (comment) {
        comments.push(comment);
      }

      // Also extract replies within this li (nested ul > li)
      const replyLists = li.querySelectorAll('ul');
      for (const replyUl of replyLists) {
        const replyItems = replyUl.querySelectorAll(':scope > li');
        for (const replyLi of replyItems) {
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
    return extractCommentsFallback();
  }

  return comments;
}

function extractCommentsFallback() {
  const comments = [];
  const article = document.querySelector('article') || document;

  // Look for username links paired with comment text
  const allLinks = article.querySelectorAll('a[href^="/"]');
  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')) continue;

    const username = href.replace(/\//g, '');
    if (!username || username.includes('?') || username.length > 30) continue;

    // Find closest comment container
    const container = link.closest('div[role="button"]')?.parentElement
      || link.closest('li')
      || link.parentElement?.parentElement?.parentElement;

    if (!container) continue;

    const textSpans = container.querySelectorAll('span[dir="auto"]');
    for (const span of textSpans) {
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

function parseCommentElement(li) {
  // Find username link within the comment
  const usernameLinks = li.querySelectorAll(':scope > div a[href^="/"], :scope > div > div a[href^="/"]');
  let usernameLink = null;

  for (const link of usernameLinks) {
    const href = link.getAttribute('href');
    if (!href || href === '/' || href.includes('/p/') || href.includes('/reel/')
      || href.includes('/explore/') || href.includes('/stories/')) continue;
    usernameLink = link;
    break;
  }

  // Fallback: any link with href
  if (!usernameLink) {
    usernameLink = li.querySelector('a[href^="/"]');
  }

  if (!usernameLink) return null;

  const href = usernameLink.getAttribute('href');
  if (!href || href === '/') return null;

  const username = href.replace(/\//g, '');
  if (!username || username.includes('?') || username.includes('explore')
    || username.includes('p/') || username.length > 30) return null;

  // Find comment text - look for span elements with actual text content
  const spans = li.querySelectorAll('span[dir="auto"]');
  let commentText = '';
  let bestSpan = null;

  for (const span of spans) {
    const text = span.textContent?.trim();
    if (!text || text === username || text.length <= 1) continue;
    if (isTimestamp(text) || isActionText(text)) continue;

    // Skip spans that are inside nested reply lists (sub-comments)
    if (span.closest('ul') !== li.closest('ul') && span.closest('li') !== li) continue;

    // Prefer the first substantial span that's directly in the comment area
    // (not nested deep in action buttons, etc.)
    const depth = getDepth(span, li);
    if (!bestSpan || depth < getDepth(bestSpan, li)) {
      if (text.length > commentText.length || depth < getDepth(bestSpan, li)) {
        commentText = text;
        bestSpan = span;
      }
    }
  }

  if (!commentText) return null;

  return {
    username: username,
    text: commentText,
    timestamp: extractTimestamp(li),
    isReply: false
  };
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
  const patterns = [
    /^\d+[smhd]$/,
    /^\d+ (jam|menit|hari|minggu|bulan|tahun)/i,
    /^\d+ (hour|minute|day|week|month|year)/i,
    /^(just now|baru saja)/i,
    /^\d+[wW]$/
  ];
  return patterns.some(p => p.test(text.trim()));
}

function isActionText(text) {
  const lower = text.toLowerCase().trim();
  const actions = [
    'reply', 'balas', 'like', 'suka', 'liked', 'disukai',
    'view replies', 'lihat balasan', 'hide replies', 'sembunyikan balasan',
    'view all', 'lihat semua', 'load more', 'muat lebih',
    'see translation', 'lihat terjemahan', 'translate', 'terjemahkan',
    'report', 'laporkan', 'delete', 'hapus', 'edited', 'diedit'
  ];
  return actions.some(a => lower === a || lower.startsWith(a));
}

async function clickViewAllComments() {
  const article = document.querySelector('article') || document;
  const buttons = article.querySelectorAll('span, a, button, div[role="button"]');
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
  const article = document.querySelector('article') || document;
  // Find "View replies (X)" / "Lihat balasan (X)" buttons
  const buttons = article.querySelectorAll('span, button, div[role="button"]');
  let clicked = false;
  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase()?.trim() || '';
    if ((text.includes('view replies') || text.includes('lihat balasan')
      || text.includes('view') && text.includes('repl'))
      && !text.includes('hide') && !text.includes('sembunyikan')) {
      btn.click();
      clicked = true;
      await sleep(500);
    }
  }
  if (clicked) {
    await sleep(1000);
  }
}

async function loadMoreComments() {
  const article = document.querySelector('article') || document;

  // Strategy 1: Click "Load more comments" button by aria-label
  const loadMoreSelectors = [
    'button[aria-label="Load more comments"]',
    'button[aria-label="Muat komentar lainnya"]',
    'svg[aria-label="Load more comments"]',
    'svg[aria-label="Muat komentar lainnya"]',
    'button[aria-label="View more comments"]',
    'button[aria-label="Lihat komentar lainnya"]'
  ];

  for (const selector of loadMoreSelectors) {
    const el = article.querySelector(selector);
    if (el) {
      const btn = el.closest('button') || el;
      btn.click();
      await sleep(800);
      return;
    }
  }

  // Strategy 2: Look for load more button by SVG icon (circle/plus pattern)
  const allButtons = article.querySelectorAll('button');
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

  // Strategy 3: Look for text-based load more buttons
  const spans = article.querySelectorAll('span, div[role="button"]');
  for (const el of spans) {
    const text = el.textContent?.toLowerCase()?.trim() || '';
    if (text === 'load more' || text === 'muat lainnya' || text === 'more comments'
      || text === 'komentar lainnya') {
      el.click();
      await sleep(800);
      return;
    }
  }

  // Strategy 4: Scroll the comments container
  const commentContainer = findCommentContainer();
  if (commentContainer) {
    commentContainer.scrollTop = commentContainer.scrollHeight;
  }
}

function findCommentContainer() {
  // Try to find the scrollable comments container within article
  const article = document.querySelector('article');
  const searchRoot = article || document;

  // Look for elements with specific roles first
  const sections = searchRoot.querySelectorAll('section, div[role="presentation"], div[role="dialog"]');
  for (const section of sections) {
    if (section.scrollHeight > section.clientHeight + 50 && section.clientHeight > 100) {
      const hasLinks = section.querySelectorAll('a[href^="/"]').length > 2;
      const hasSpans = section.querySelectorAll('span[dir="auto"]').length > 2;
      if (hasLinks && hasSpans) {
        return section;
      }
    }
  }

  // Fallback: any scrollable element with comments
  const candidates = searchRoot.querySelectorAll('ul, div');
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
    const article = document.querySelector('article') || document.body;
    let resolved = false;

    const observer = new MutationObserver(() => {
      if (!resolved) {
        resolved = true;
        observer.disconnect();
        // Give a small additional delay for rendering
        setTimeout(resolve, 200);
      }
    });

    observer.observe(article, {
      childList: true,
      subtree: true
    });

    // Fallback timeout
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
