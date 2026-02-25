// Content script for X (Twitter)
// Card-stacking TLDR system: each bookmark creates an independent card.
// Supports parallel processing — users can keep scrolling and bookmarking.

(function () {
  'use strict';

  const MAX_VISIBLE_CARDS = 3;
  const hostname = window.location.hostname.toLowerCase();
  const isXHost = hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.twitter.com';
  const isWeChatHost = hostname === 'mp.weixin.qq.com';
  let cardContainer = null;
  let activeCards = []; // { id, element, timerId }
  let cardSeq = 0;
  let currentTheme = 'auto'; // 'auto' | 'light' | 'dark'
  let currentMode = 'tldr'; // 'tldr' | 'original'
  let aiEnabled = true;
  let wechatButton = null;

  // ── Theme & mode management ───────────────────────────────────────────────

  // Load initial theme and mode preferences from storage
  chrome.storage.sync.get({ theme: 'auto', mdMode: 'tldr', aiEnabled: true }, function (data) {
    currentTheme = data.theme || 'auto';
    currentMode = data.mdMode || 'tldr';
    aiEnabled = data.aiEnabled !== false;
    applyThemeToContainer();
  });

  // Listen for setting changes from the popup
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.theme) {
      currentTheme = changes.theme.newValue || 'auto';
      applyThemeToContainer();
    }
    if (area === 'sync' && changes.mdMode) {
      currentMode = changes.mdMode.newValue || 'tldr';
    }
    if (area === 'sync' && changes.aiEnabled) {
      aiEnabled = changes.aiEnabled.newValue !== false;
    }
  });

  // Apply theme class to the card container element
  function applyThemeToContainer() {
    if (!cardContainer) return;
    cardContainer.classList.remove('btl-auto', 'btl-light', 'btl-dark');
    cardContainer.classList.add('btl-' + currentTheme);
  }

  initPageEntry();

  function initPageEntry() {
    if (isXHost) initXBookmarkListener();
    if (isWeChatHost) initWeChatFloatingButton();
  }

  // ── Bookmark click detection (X) ──────────────────────────────────────────

  function initXBookmarkListener() {
    document.addEventListener('click', (event) => {
      const bookmarkBtn = findAncestorByTestId(event.target, 'bookmark');
      if (!bookmarkBtn) return;

      // Only fire when adding a bookmark, not when removing one.
      // X uses "removeBookmark" for the un-bookmark button.
      const removeBtn = findAncestorByTestId(event.target, 'removeBookmark');
      if (removeBtn) return;

      const article = bookmarkBtn.closest('article[data-testid="tweet"]');
      if (!article) return;

      const cardId = 'btl-' + (++cardSeq);
      createLoadingCard(cardId);
      processBookmark(article, cardId);
    }, true);
  }

  // ── Floating trigger (WeChat public articles) ─────────────────────────────

  function initWeChatFloatingButton() {
    if (wechatButton || document.getElementById('btl-wechat-trigger')) return;

    wechatButton = document.createElement('button');
    wechatButton.id = 'btl-wechat-trigger';
    wechatButton.className = 'btl-wechat-trigger';
    wechatButton.type = 'button';
    wechatButton.textContent = '保存到就是学到';
    wechatButton.title = '提取本文并生成摘要';
    wechatButton.addEventListener('click', onWeChatTriggerClick);

    document.body.appendChild(wechatButton);
  }

  function setWeChatButtonState(state) {
    if (!wechatButton) return;
    if (state === 'loading') {
      wechatButton.disabled = true;
      wechatButton.classList.add('btl-wechat-trigger-loading');
      wechatButton.textContent = aiEnabled ? '处理中...' : '保存中...';
      return;
    }
    wechatButton.disabled = false;
    wechatButton.classList.remove('btl-wechat-trigger-loading');
    wechatButton.textContent = '保存到就是学到';
  }

  async function onWeChatTriggerClick() {
    const cardId = 'btl-' + (++cardSeq);
    createLoadingCard(cardId);
    setWeChatButtonState('loading');
    try {
      const wechatData = extractWeChatArticleContent();
      chrome.runtime.sendMessage(
        { type: 'GENERATE_TLDR', tweetData: wechatData, articleUrl: null, quotedTweetUrl: null },
        (response) => {
          setWeChatButtonState('idle');
          if (chrome.runtime.lastError) {
            updateCard(cardId, '扩展连接失败，请刷新页面', true);
            return;
          }
          if (response?.success) {
            if (response.mode === 'raw' || response.mode === 'obsidian_raw') {
              updateCard(cardId, '已保存原文到 Markdown', false, wechatData.tweetUrl);
            } else {
              updateCard(cardId, response.tldr, false, wechatData.tweetUrl);
            }
          } else {
            updateCard(cardId, response?.error || '生成摘要失败', true);
          }
        }
      );
    } catch (err) {
      setWeChatButtonState('idle');
      updateCard(cardId, '未能提取公众号正文，请先完成页面验证后重试', true);
    }
  }

  // ── Main async flow (per card) ────────────────────────────────────────────

  async function processBookmark(article, cardId) {
    try {
      await expandShowMore(article);
      const tweetData = extractTweetContent(article);
      const articleUrl = detectArticleUrl(article);
      const quotedTweetUrl = detectQuotedTweetUrl(article);

      const hasContent = tweetData.text || tweetData.textWithMedia || tweetData.cardText
        || tweetData.quotedText || tweetData.quotedTextWithMedia || tweetData.fallbackText
        || (tweetData.imageAssets && tweetData.imageAssets.length > 0);
      if (!hasContent && !articleUrl && !quotedTweetUrl) {
        updateCard(cardId, '未找到可总结的内容', true);
        return;
      }

      chrome.runtime.sendMessage(
        { type: 'GENERATE_TLDR', tweetData, articleUrl, quotedTweetUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            updateCard(cardId, '扩展连接失败，请刷新页面', true);
            return;
          }
          if (response?.success) {
            if (response.mode === 'raw' || response.mode === 'obsidian_raw') {
              updateCard(cardId, '已保存原文到 Markdown', false, tweetData.tweetUrl);
            } else {
              updateCard(cardId, response.tldr, false, tweetData.tweetUrl);
            }
          } else {
            updateCard(cardId, response?.error || '生成摘要失败', true);
          }
        }
      );
    } catch (err) {
      updateCard(cardId, '处理出错: ' + err.message, true);
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function findAncestorByTestId(el, testId) {
    while (el && el !== document.body) {
      if (el.getAttribute?.('data-testid') === testId) return el;
      el = el.parentElement;
    }
    return null;
  }

  function extractWeChatArticleContent() {
    const titleEl = document.querySelector('#activity-name')
      || document.querySelector('h1#activity-name')
      || document.querySelector('h1');
    const title = titleEl ? titleEl.innerText.trim() : '';

    const authorEl = document.querySelector('#js_name')
      || document.querySelector('.profile_meta_value')
      || document.querySelector('.wx_tap_link.js_wx_tap_highlight');
    const author = authorEl ? authorEl.innerText.trim() : '公众号作者';

    const contentEl = document.querySelector('#js_content')
      || document.querySelector('.rich_media_content')
      || document.querySelector('article');
    if (!contentEl) {
      throw new Error('content not found');
    }

    const clone = contentEl.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe').forEach((el) => el.remove());
    const media = extractWeChatMediaAssets(clone);
    const bodyText = htmlToMarkdown(clone).replace(/\n{3,}/g, '\n\n').trim();
    if (!bodyText || bodyText.length < 80) {
      throw new Error('content too short');
    }

    const sourceUrl = window.location.href;
    const text = (title ? (title + '\n\n') : '') + bodyText;
    const referencedUrls = collectWeChatReferencedUrls(contentEl);
    for (const v of media.videoAssets) {
      if (!referencedUrls.includes(v.url)) referencedUrls.push(v.url);
    }

    return {
      platform: 'wechat',
      contentType: 'article',
      title: title || '微信公众号文章',
      text: text.slice(0, 15000),
      author,
      quotedText: '',
      quotedAuthor: '',
      cardText: '',
      fallbackText: '',
      tweetUrl: sourceUrl,
      url: sourceUrl,
      metrics: null,
      referencedUrls,
      imageAssets: media.imageAssets,
      videoAssets: media.videoAssets,
    };
  }

  function extractWeChatMediaAssets(cloneContentEl) {
    const imageAssets = [];
    const videoAssets = [];
    const imageSeen = new Set();
    const videoSeen = new Set();

    function pushImage(url, alt) {
      const normalized = normalizeAbsoluteUrl(url);
      if (!normalized || imageSeen.has(normalized)) return;
      imageSeen.add(normalized);
      imageAssets.push({ url: normalized, alt: (alt || '').trim() });
    }

    function pushVideo(url) {
      const normalized = normalizeAbsoluteUrl(url);
      if (!normalized || videoSeen.has(normalized)) return;
      videoSeen.add(normalized);
      videoAssets.push({ url: normalized });
    }

    // Convert video blocks into stable placeholders, avoid grabbing player UI text.
    const videoBlocks = cloneContentEl.querySelectorAll(
      'video, .js_video_container, .js_tx_video_container, [data-role="txp_video_container"], iframe[src*="v.qq.com"]'
    );
    videoBlocks.forEach((el) => {
      if (!el || !el.parentNode) return;
      const src = el.getAttribute('src')
        || el.getAttribute('data-src')
        || el.getAttribute('data-url')
        || el.querySelector?.('source[src]')?.getAttribute('src')
        || el.querySelector?.('iframe[src]')?.getAttribute('src')
        || '';
      if (src) pushVideo(src);
      var idx = videoAssets.length || 1;
      var marker = document.createElement('p');
      var videoUrl = src ? normalizeAbsoluteUrl(src) : '';
      marker.textContent = videoUrl ? ('[视频 ' + idx + '](' + videoUrl + ')') : ('[视频 ' + idx + '](about:blank)');
      el.parentNode.insertBefore(marker, el);
      el.remove();
    });

    const imgs = cloneContentEl.querySelectorAll('img');
    imgs.forEach((img) => {
      const src = img.getAttribute('data-src')
        || img.getAttribute('data-backsrc')
        || img.getAttribute('src')
        || '';
      const alt = img.getAttribute('alt') || img.getAttribute('data-alt') || '';
      pushImage(src, alt);

      if (img.parentNode) {
        const idx = imageAssets.length || 1;
        const marker = document.createElement('span');
        const imageUrl = src ? normalizeAbsoluteUrl(src) : '';
        marker.textContent = imageUrl ? ('![图片 ' + idx + '](' + imageUrl + ')') : ('![图片 ' + idx + '](about:blank)');
        img.parentNode.insertBefore(marker, img);
        img.remove();
      }
    });

    return { imageAssets, videoAssets };
  }

  function collectWeChatReferencedUrls(contentEl) {
    const urls = [];
    const seen = new Set();
    const links = contentEl.querySelectorAll('a[href]');
    links.forEach((link) => {
      const href = link.getAttribute('href') || link.href || '';
      const normalized = normalizeAbsoluteUrl(href);
      if (!normalized) return;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      urls.push(normalized);
    });
    return urls;
  }

  function normalizeAbsoluteUrl(urlLike) {
    if (!urlLike) return '';
    var candidate = String(urlLike).trim();
    if (!candidate) return '';
    if (candidate.startsWith('//')) candidate = window.location.protocol + candidate;
    if (candidate.startsWith('javascript:') || candidate.startsWith('#')) return '';
    try {
      return new URL(candidate, window.location.href).toString();
    } catch (_) {
      return '';
    }
  }

  function normalizeXImageUrl(urlLike) {
    const normalized = normalizeAbsoluteUrl(urlLike);
    if (!normalized) return '';
    try {
      const parsed = new URL(normalized);
      const host = (parsed.hostname || '').toLowerCase();
      if (/(^|\.)pbs\.twimg\.com$/.test(host)) {
        parsed.searchParams.set('name', 'orig');
      }
      return parsed.toString();
    } catch (_) {
      return normalized;
    }
  }

  function htmlToMarkdown(element) {
    var result = '';
    var walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      null,
      false
    );

    var node;
    var lastBlockWasEmpty = false;
    
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        var text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text) {
          result += text;
          lastBlockWasEmpty = false;
        }
        continue;
      }

      var tag = node.nodeName.toLowerCase();
      var parent = node.parentElement;
      var parentTag = parent ? parent.nodeName.toLowerCase() : '';

      if (tag === 'br') {
        result += '\n';
      } else if (['p', 'div', 'section', 'article'].includes(tag)) {
        if (!lastBlockWasEmpty && result && !result.endsWith('\n')) result += '\n';
        var textContent = node.innerText.trim();
        if (textContent) {
          lastBlockWasEmpty = false;
        } else {
          lastBlockWasEmpty = true;
        }
      } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        if (!lastBlockWasEmpty && result) result += '\n';
        var level = parseInt(tag[1]);
        result += '#'.repeat(level) + ' ' + node.innerText.trim() + '\n';
        lastBlockWasEmpty = false;
      } else if (tag === 'strong' || tag === 'b') {
        var strongText = node.innerText.trim();
        if (strongText) result += '**' + strongText + '**';
      } else if (tag === 'em' || tag === 'i') {
        var emText = node.innerText.trim();
        if (emText) result += '_' + emText + '_';
      } else if (['ul', 'ol'].includes(tag)) {
        if (!lastBlockWasEmpty && result) result += '\n';
        var isOrdered = tag === 'ol';
        var liIndex = 0;
        var items = node.querySelectorAll(':scope > li');
        items.forEach(function (li) {
          liIndex++;
          var bullet = isOrdered ? (liIndex + '. ') : '- ';
          result += bullet + li.innerText.trim() + '\n';
        });
        lastBlockWasEmpty = false;
      } else if (tag === 'blockquote') {
        if (!lastBlockWasEmpty && result) result += '\n';
        var quoteLines = node.innerText.split('\n');
        quoteLines.forEach(function (line) {
          if (line.trim()) result += '> ' + line + '\n';
        });
        lastBlockWasEmpty = false;
      } else if (tag === 'code') {
        result += '`' + node.innerText + '`';
      } else if (tag === 'pre') {
        if (!lastBlockWasEmpty && result) result += '\n';
        result += '```\n' + node.innerText + '\n```\n';
        lastBlockWasEmpty = false;
      }
    }

    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ── Show-more expansion ───────────────────────────────────────────────────

  async function expandShowMore(article) {
    const links = article.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
    if (links.length === 0) return;
    links.forEach((l) => l.click());
    await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!article.querySelector('[data-testid="tweet-text-show-more-link"]')) {
          obs.disconnect(); resolve();
        }
      });
      obs.observe(article, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 3000);
    });
  }

  // ── Content extraction ────────────────────────────────────────────────────

  function extractTweetContent(article) {
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const text = tweetTextEl ? tweetTextEl.innerText : '';

    const authorEl = article.querySelector('[data-testid="User-Name"]');
    const author = authorEl ? authorEl.innerText.split('\n')[0] : '';

    const quotedTweet = article.querySelector('[data-testid="quoteTweet"]');
    const quotedText = quotedTweet
      ? (quotedTweet.querySelector('[data-testid="tweetText"]')?.innerText || '') : '';
    const quotedTextEl = quotedTweet
      ? quotedTweet.querySelector('[data-testid="tweetText"]')
      : null;
    const quotedAuthorEl = quotedTweet
      ? quotedTweet.querySelector('[data-testid="User-Name"]') : null;
    const quotedAuthor = quotedAuthorEl ? quotedAuthorEl.innerText.split('\n')[0] : '';
    const mediaContent = extractTweetMediaContent(article, tweetTextEl, quotedTweet, quotedTextEl);

    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    const cardText = cardEl ? cardEl.innerText : '';
    const referencedUrls = collectReferencedUrls(article, quotedTweet);

    let fallbackText = '';
    if (!text && !cardText) {
      // For X Articles: prefer heading-based extraction to avoid metadata noise
      // (author info, engagement metrics, bio that duplicate the markdown header).
      // Article body is the parent of the first h1 section heading.
      const h1s = article.querySelectorAll('h1');
      if (h1s.length >= 2) {
        const bodyContainer = h1s[0].parentElement;
        if (bodyContainer && bodyContainer.innerText.trim().length > 200) {
          const clone = bodyContainer.cloneNode(true);
          // Remove "Upgrade to Premium" banners and similar noise
          clone.querySelectorAll('[role="status"]').forEach((s) => s.remove());
          fallbackText = clone.innerText.trim();
        }
      }
      if (!fallbackText) {
        const clone = article.cloneNode(true);
        // Remove ALL engagement metric groups
        clone.querySelectorAll('[role="group"]').forEach((g) => g.remove());
        fallbackText = clone.innerText.trim();
      }
    }

    // Extract the tweet's own permalink (timestamp link, not inside quoted tweet)
    let tweetUrl = window.location.href;
    const allStatusLinks = article.querySelectorAll('a[href*="/status/"]');
    for (const link of allStatusLinks) {
      if (quotedTweet && quotedTweet.contains(link)) continue;
      if (link.querySelector('time')) {
        const href = link.getAttribute('href') || '';
        tweetUrl = href.startsWith('/') ? 'https://x.com' + href : (href || tweetUrl);
        break;
      }
    }

    // Extract engagement metrics (replies, retweets, likes, views)
    const metrics = extractEngagementMetrics(article);

    return {
      text, author, quotedText, quotedAuthor, cardText, fallbackText,
      tweetUrl, url: window.location.href, metrics, referencedUrls,
      textWithMedia: mediaContent.mainBody,
      quotedTextWithMedia: mediaContent.quotedBody,
      imageAssets: mediaContent.mainImageAssets,
      quotedImageAssets: mediaContent.quotedImageAssets,
    };
  }

  function extractTweetMediaContent(article, tweetTextEl, quotedTweet, quotedTextEl) {
    const mainBlocks = [];
    const quotedBlocks = [];

    if (tweetTextEl) {
      mainBlocks.push({
        type: 'text',
        node: tweetTextEl,
        text: tweetTextEl.innerText.trim(),
      });
    }
    if (quotedTextEl) {
      quotedBlocks.push({
        type: 'text',
        node: quotedTextEl,
        text: quotedTextEl.innerText.trim(),
      });
    }

    const photoNodes = article.querySelectorAll('[data-testid="tweetPhoto"]');
    for (const photoNode of photoNodes) {
      const parsed = parseTweetPhotoNode(photoNode);
      if (!parsed.markdownLines.length) continue;
      if (quotedTweet && quotedTweet.contains(photoNode)) {
        quotedBlocks.push({
          type: 'photo',
          node: photoNode,
          markdownLines: parsed.markdownLines,
          assets: parsed.assets,
        });
      } else {
        mainBlocks.push({
          type: 'photo',
          node: photoNode,
          markdownLines: parsed.markdownLines,
          assets: parsed.assets,
        });
      }
    }

    // Fallback for X Articles: article body images are rendered as plain <img>
    // tags, not wrapped in [data-testid="tweetPhoto"] containers.
    const articleImageAssets = [];
    if (!mainBlocks.some(function (b) { return b.type === 'photo'; })) {
      const allImgs = article.querySelectorAll('img');
      const imgSeen = new Set();
      for (const img of allImgs) {
        if (quotedTweet && quotedTweet.contains(img)) continue;
        if (img.closest('[data-testid="Tweet-User-Avatar"]')) continue;
        if (img.closest('[role="group"]')) continue;
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        const url = normalizeXImageUrl(src);
        if (!url || imgSeen.has(url)) continue;
        try {
          const parsed = new URL(url);
          const path = parsed.pathname || '';
          if (/\/profile_images\//.test(path)) continue;
          if (/\/emoji\//.test(path)) continue;
        } catch (_) { continue; }
        const w = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
        const h = img.naturalHeight || parseInt(img.getAttribute('height')) || 0;
        if (w > 0 && w < 48 && h > 0 && h < 48) continue;
        imgSeen.add(url);
        const alt = (img.getAttribute('alt') || '').trim();
        articleImageAssets.push({ url: url, alt: alt });
      }
    }

    const mainRender = renderTweetBodyBlocks(mainBlocks);
    const quotedRender = renderTweetBodyBlocks(quotedBlocks);
    return {
      mainBody: mainRender.body,
      quotedBody: quotedRender.body,
      mainImageAssets: mainRender.assets.length > 0 ? mainRender.assets : articleImageAssets,
      quotedImageAssets: quotedRender.assets,
    };
  }

  function parseTweetPhotoNode(photoNode) {
    const imgs = photoNode.querySelectorAll('img');
    const assets = [];
    const markdownLines = [];
    const seen = new Set();

    for (const img of imgs) {
      const src = img.getAttribute('src')
        || img.getAttribute('data-src')
        || '';
      const url = normalizeXImageUrl(src);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const alt = (img.getAttribute('alt') || '').trim();
      assets.push({ url: url, alt: alt });
      markdownLines.push('![' + (alt || '图片') + '](' + url + ')');
    }

    return { assets: assets, markdownLines: markdownLines };
  }

  function renderTweetBodyBlocks(blocks) {
    if (!blocks.length) return { body: '', assets: [] };

    blocks.sort(function (a, b) {
      if (a.node === b.node) return 0;
      var pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const parts = [];
    const assets = [];
    const assetSeen = new Set();

    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text) parts.push(block.text);
        continue;
      }
      const joined = block.markdownLines.join('\n');
      if (joined) parts.push(joined);
      if (block.assets && block.assets.length) {
        for (const asset of block.assets) {
          if (!asset || !asset.url || assetSeen.has(asset.url)) continue;
          assetSeen.add(asset.url);
          assets.push(asset);
        }
      }
    }

    return {
      body: parts.join('\n\n').trim(),
      assets: assets,
    };
  }

  // Collect external links referenced by the bookmarked post itself.
  // This covers both inline links and "card preview" links.
  function collectReferencedUrls(article, quotedTweet) {
    const links = article.querySelectorAll('a[href]');
    const seen = new Set();
    const urls = [];

    for (const link of links) {
      if (quotedTweet && quotedTweet.contains(link)) continue;

      const hrefRaw = link.getAttribute('href') || link.href || '';
      const href = hrefRaw.startsWith('/') ? ('https://x.com' + hrefRaw) : hrefRaw;
      if (!href) continue;

      let parsed;
      try {
        parsed = new URL(href, window.location.origin);
      } catch (_) {
        continue;
      }

      const host = (parsed.hostname || '').toLowerCase();
      const path = parsed.pathname || '';

      // Ignore X internal navigation links that are not post references.
      if (host === 'x.com' || host === 'twitter.com' || host === 'www.twitter.com') {
        if (
          /^\/[^/]+\/status\/\d+/.test(path)
          || /^\/i\/(?:article|status|analytics)/.test(path)
          || /\/(?:photo|video)\//.test(path)
          || /^\/[^/]+$/.test(path)
        ) {
          continue;
        }
      }

      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    }

    return urls;
  }

  // ── Engagement metrics extraction ──────────────────────────────────────────

  function extractEngagementMetrics(article) {
    var metrics = { replies: '0', retweets: '0', likes: '0', views: '0' };
    var group = article.querySelector('[role="group"]');
    if (!group) return metrics;

    // Each action button exposes its count in the aria-label attribute,
    // e.g. "123 replies. Reply", "5 reposts. Repost", "10 likes. Like".
    // If the count is zero X omits the number (just "Reply", "Like", etc.).
    var testIds = { reply: 'replies', retweet: 'retweets', like: 'likes' };
    for (var tid in testIds) {
      var btn = group.querySelector('[data-testid="' + tid + '"]');
      if (btn) {
        var label = btn.getAttribute('aria-label') || '';
        var m = label.match(/([\d,]+)/);
        if (m) metrics[testIds[tid]] = m[1].replace(/,/g, '');
      }
    }

    // Views count: X puts it in an analytics link or a standalone element
    // outside the main action buttons. Try analytics link first, then
    // look for any aria-label mentioning "view" near the action bar.
    var viewLink = article.querySelector('a[href*="/analytics"]');
    if (viewLink) {
      var viewLabel = viewLink.getAttribute('aria-label') || '';
      var vm = viewLabel.match(/([\d,]+)/);
      if (vm) metrics.views = vm[1].replace(/,/g, '');
    } else {
      // Fallback: some X layouts show views as a separate span in the group
      var allLabels = group.querySelectorAll('[aria-label]');
      for (var i = 0; i < allLabels.length; i++) {
        var al = allLabels[i].getAttribute('aria-label') || '';
        if (/views?/i.test(al)) {
          var vvm = al.match(/([\d,]+)/);
          if (vvm) { metrics.views = vvm[1].replace(/,/g, ''); break; }
        }
      }
    }

    return metrics;
  }

  // ── URL detection ─────────────────────────────────────────────────────────

  function detectArticleUrl(article) {
    // Only detect X Articles by their distinctive URL pattern (/i/article/ or /articles/).
    // Previously a broad data-testid*="article" CSS selector caused false positives,
    // matching non-article elements and sending regular tweet URLs to fetchPageContent,
    // which then grabbed unrelated tweets from the page as "article content".
    const links = article.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      if (/\/(articles?)\//i.test(href)) {
        // Strip media/photo/video suffixes — X Article image links look like
        // /user/article/123/media/456 but the article page is /user/article/123
        const cleanHref = href.replace(/\/(media|photo|video)\/.*$/, '');
        return cleanHref.startsWith('/') ? 'https://x.com' + cleanHref : cleanHref;
      }
    }
    // Fallback: look for X Article-specific data-testid values (exact matches only).
    // These are the selectors used by extractPageContent to find article bodies.
    const articleTestIds = [
      '[data-testid="noteBody"]',
      '[data-testid="richTextContainer"]',
      '[data-testid="articleBody"]',
      '[data-testid="article-content"]',
    ];
    for (const sel of articleTestIds) {
      const el = article.querySelector(sel);
      if (el) {
        const cl = el.closest('a[href]') || el.querySelector('a[href]');
        if (cl) {
          const h = cl.href || cl.getAttribute('href') || '';
          if (h) return h.startsWith('/') ? 'https://x.com' + h : h;
        }
      }
    }
    return null;
  }

  function detectQuotedTweetUrl(article) {
    const qt = article.querySelector('[data-testid="quoteTweet"]');
    if (!qt) return null;
    const links = qt.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      if (/\/status\/\d+/.test(href)) return href.startsWith('/') ? 'https://x.com' + href : href;
    }
    return null;
  }

  // ── Card container & stacking ─────────────────────────────────────────────

  function ensureContainer() {
    if (!cardContainer || !cardContainer.parentNode) {
      cardContainer = document.createElement('div');
      cardContainer.className = 'btl-card-container btl-' + currentTheme;
      document.body.appendChild(cardContainer);
    }
    return cardContainer;
  }

  function createLoadingCard(cardId) {
    const container = ensureContainer();
    // Auto-dismiss oldest if at capacity
    while (activeCards.length >= MAX_VISIBLE_CARDS) {
      dismissCard(activeCards[0].id);
    }

    const card = document.createElement('div');
    card.className = 'btl-tldr-card';
    card.dataset.cardId = cardId;

    // Header
    const header = document.createElement('div');
    header.className = 'btl-card-header';
    const title = document.createElement('span');
    title.className = 'btl-card-title';
    // Use extension icon instead of emoji
    const iconImg = document.createElement('img');
    iconImg.className = 'btl-card-title-icon';
    iconImg.src = chrome.runtime.getURL('icons/icon48.png');
    iconImg.alt = '';
    title.appendChild(iconImg);
    title.appendChild(document.createTextNode('收藏到就是学到'));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btl-card-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => dismissCard(cardId));
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body — loading state
    const body = document.createElement('div');
    body.className = 'btl-card-body';
    const wrap = document.createElement('div');
    wrap.className = 'btl-loading';
    const spinner = document.createElement('div');
    spinner.className = 'btl-spinner';
    const loadText = document.createElement('span');
    loadText.textContent = aiEnabled ? '正在生成摘要...' : '正在保存原文...';
    wrap.appendChild(spinner);
    wrap.appendChild(loadText);
    body.appendChild(wrap);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    activeCards.push({ id: cardId, element: card, timerId: null });
  }

  function updateCard(cardId, content, isError, tweetUrl) {
    const info = activeCards.find((c) => c.id === cardId);
    if (!info) return;

    const card = info.element;
    if (isError) card.classList.add('btl-error');

    // Replace body contents
    const body = card.querySelector('.btl-card-body');
    body.textContent = '';

    const contentEl = document.createElement('div');
    contentEl.className = 'btl-tldr-content';
    renderFormattedTLDR(contentEl, content || '');
    body.appendChild(contentEl);

    // Original tweet link (if available and not an error)
    if (!isError && tweetUrl) {
      const linkWrap = document.createElement('div');
      linkWrap.className = 'btl-original-link';
      const a = document.createElement('a');
      a.href = tweetUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '查看原帖 \u2197';
      linkWrap.appendChild(a);
      body.appendChild(linkWrap);
    }

    // Auto-dismiss after 60 s
    info.timerId = setTimeout(() => dismissCard(cardId), 60000);
  }

  function dismissCard(cardId) {
    const idx = activeCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;
    const info = activeCards[idx];
    if (info.timerId) clearTimeout(info.timerId);
    info.element.classList.add('btl-fade-out');
    setTimeout(() => {
      if (info.element.parentNode) info.element.remove();
    }, 300);
    activeCards.splice(idx, 1);
  }

  // ── Formatted TLDR rendering ──────────────────────────────────────────────

  function renderFormattedTLDR(container, text) {
    const lines = text.split('\n');
    let currentList = null;
    let currentListType = '';

    function flushList() {
      if (currentList) { container.appendChild(currentList); }
      currentList = null; currentListType = '';
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { flushList(); continue; }

      const headingMatch = trimmed.match(/^\*\*(.+?)\*\*\s*[-:]?\s*$/);
      if (headingMatch) { flushList(); const h = document.createElement('div'); h.className = 'btl-section-heading'; h.textContent = headingMatch[1]; container.appendChild(h); continue; }

      const scoreMatch = trimmed.match(/^(Credibility|可信度|信頼度)\s*[:：]\s*(\d+)\s*\/\s*10/i);
      if (scoreMatch) {
        flushList();
        const sl = document.createElement('div'); sl.className = 'btl-score-line';
        const score = parseInt(scoreMatch[2], 10);
        const cls = score >= 7 ? 'btl-score-high' : (score >= 4 ? 'btl-score-mid' : 'btl-score-low');
        const badge = document.createElement('span'); badge.className = 'btl-score-badge ' + cls; badge.textContent = scoreMatch[2] + '/10';
        const justification = trimmed.slice(trimmed.indexOf('/10') + 3).replace(/^\s*[-\u2014]\s*/, '');
        sl.appendChild(document.createTextNode(scoreMatch[1] + ': '));
        sl.appendChild(badge);
        if (justification) { const rest = document.createElement('span'); rest.textContent = ' \u2014 ' + justification; sl.appendChild(rest); }
        container.appendChild(sl); continue;
      }

      const bulletMatch = trimmed.match(/^[-\u2022*]\s+(.*)/);
      if (bulletMatch) {
        if (currentListType !== 'ul') { flushList(); currentList = document.createElement('ul'); currentListType = 'ul'; }
        const li = document.createElement('li'); renderInline(li, bulletMatch[1]); currentList.appendChild(li); continue;
      }

      const numMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
      if (numMatch) {
        if (currentListType !== 'ol') { flushList(); currentList = document.createElement('ol'); currentListType = 'ol'; }
        const li = document.createElement('li'); renderInline(li, numMatch[1]); currentList.appendChild(li); continue;
      }

      flushList();
      const p = document.createElement('p'); renderInline(p, trimmed); container.appendChild(p);
    }
    flushList();
  }

  function renderInline(el, text) {
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length === 0) { el.appendChild(document.createTextNode(text)); return; }
    let cursor = 0;
    for (const m of matches) {
      if (m.index > cursor) el.appendChild(document.createTextNode(text.slice(cursor, m.index)));
      if (m[2]) { const s = document.createElement('strong'); s.textContent = m[2]; el.appendChild(s); }
      else if (m[3]) { const e = document.createElement('em'); e.textContent = m[3]; el.appendChild(e); }
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
  }

  // ── Markdown download via <a download> tag ────────────────────────────────
  // Background sends markdown content here when native host is unavailable.
  // The HTML download attribute reliably sets filenames on all platforms,
  // unlike chrome.downloads which ignores the filename param on Windows.

  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === 'SAVE_MARKDOWN') {
      var blob = new Blob([message.markdown], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = message.fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
    }
  });
})();
