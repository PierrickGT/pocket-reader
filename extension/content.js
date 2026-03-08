/**
 * Pocket Reader - Content Script
 * Extracts main content from web pages and handles audio playback
 * Uses prefetching to generate next paragraph while current one plays
 */

const SERVER_URL = 'http://localhost:5050';

// Audio playback state
let audioContext = null;
let currentAudioElement = null;
let currentAudioUrl = null;
let shouldStop = false;
let isPaused = false;
let playbackSpeed = 1.0;
let currentParagraphIndex = 0;
let totalParagraphs = 0;

// Selection reading state (separate from main page reading)
let selectionAudioElement = null;
let selectionAudioUrl = null;
let isReadingSelection = false;

/**
 * Get or create the audio context
 */
function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

/**
 * Get or create the selection audio context
 */

// DOM element tracking for highlighting
let readableElements = []; // Array of DOM elements that can be read
let currentHighlightedElement = null;

// CSS class for highlighting
const HIGHLIGHT_CLASS = 'pocket-reader-highlight';
const HIGHLIGHT_STYLE_ID = 'pocket-reader-styles';

/**
 * Inject highlight styles into the page
 */
function injectHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background-color: rgba(99, 102, 241, 0.15) !important;
      outline: 2px solid rgba(99, 102, 241, 0.5) !important;
      outline-offset: 2px !important;
      border-radius: 4px !important;
      transition: background-color 0.2s ease, outline 0.2s ease !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Highlight a specific element
 */
function highlightElement(element) {
  // Remove previous highlight
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
  }

  if (element) {
    element.classList.add(HIGHLIGHT_CLASS);
    currentHighlightedElement = element;

    // Scroll element into view smoothly
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });
  }
}

/**
 * Remove all highlights
 */
function removeHighlight() {
  if (currentHighlightedElement) {
    currentHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
    currentHighlightedElement = null;
  }
}

/**
 * Find the main content container
 */
function findContentContainer() {
  const selectors = [
    '[data-testid="twitterArticleReadView"]',
    'article',
    '[role="main"]',
    'main',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.content',
    '#content',
    '.story-body',
    '.article-body',
    '.post-body'
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.innerText.trim().length > 200) {
      return element;
    }
  }

  return document.body;
}

/**
 * Check if an element should be excluded from reading
 */
function isExcludedElement(element) {
  const excludedTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'];
  if (excludedTags.includes(element.tagName)) return true;

  const excludedClasses = [
    'sidebar',
    'navigation',
    'menu',
    'comments',
    'comment',
    'advertisement',
    'ad',
    'ads',
    'social-share',
    'share-buttons',
    'related-posts',
    'recommended'
  ];

  const classList = Array.from(element.classList).map((c) => c.toLowerCase());
  if (excludedClasses.some((exc) => classList.includes(exc))) return true;

  const role = element.getAttribute('role');
  if (['navigation', 'banner', 'complementary'].includes(role)) return true;

  if (element.getAttribute('aria-hidden') === 'true') return true;

  return false;
}

/**
 * Check if an element is visible
 */
function isVisible(element) {
  const style = window.getComputedStyle(element);
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.offsetParent !== null
  );
}

/**
 * Extract readable elements from the DOM
 * Returns array of objects with { element, text } for each readable block
 */
function extractReadableElements() {
  const container = findContentContainer();
  const elements = [];

  // Selectors for readable content blocks
  const readableSelectors =
    '[data-testid="twitter-article-title"], [data-text="true"], p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre';

  const candidates = container.querySelectorAll(readableSelectors);

  for (const element of candidates) {
    // Skip if inside an excluded parent
    let parent = element.parentElement;
    let excluded = false;
    while (parent && parent !== container) {
      if (isExcludedElement(parent)) {
        excluded = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (excluded) continue;

    // Skip if element itself is excluded
    if (isExcludedElement(element)) continue;

    // Skip if not visible
    if (!isVisible(element)) continue;

    // Get text content
    const text = (element.innerText || element.textContent || '').trim();

    // Skip empty or very short elements
    if (text.length < 10) continue;

    // Skip if this element's text is entirely contained in a child we'll process later
    // (avoid reading the same content twice)
    const childReadables = element.querySelectorAll(readableSelectors);
    if (childReadables.length > 0) {
      const childText = Array.from(childReadables)
        .map((c) => (c.innerText || '').trim())
        .join('');
      if (childText.length >= text.length * 0.9) {
        continue; // Skip parent, children will cover the content
      }
    }

    elements.push({
      element: element,
      text: text
    });
  }

  return elements;
}

/**
 * Extract the main readable content from the page (legacy, for text-only extraction)
 * Uses various heuristics to find the main article/content area
 */
function extractMainContent() {
  const elements = extractReadableElements();
  const texts = elements.map((e) => e.text);

  // Prepend title
  const title = getPageTitle();
  if (title) {
    texts.unshift(title);
  }

  return texts.join('\n\n');
}

/**
 * Get page title
 */
function getPageTitle() {
  return document.title || '';
}

/**
 * Get a normalized URL for position storage (remove hash and query params)
 */
function getNormalizedUrl() {
  const url = new URL(window.location.href);
  return url.origin + url.pathname;
}

/**
 * Save reading position to chrome storage
 */
function saveReadingPosition(paragraphIndex, total) {
  const url = getNormalizedUrl();
  chrome.storage.local.get('readingPositions', (result) => {
    const positions = result.readingPositions || {};
    positions[url] = {
      index: paragraphIndex,
      total: total,
      timestamp: Date.now()
    };
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Clear reading position for current URL
 */
function clearReadingPosition() {
  const url = getNormalizedUrl();
  chrome.storage.local.get('readingPositions', (result) => {
    const positions = result.readingPositions || {};
    delete positions[url];
    chrome.storage.local.set({ readingPositions: positions });
  });
}

/**
 * Send message to popup/background
 */
function notifyExtension(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Extension context might be invalid, ignore
  });
}

/**
 * Play audio from blob using Web Audio API to bypass CSP restrictions
 * Also accepts an optional onTimeUpdate callback for prefetch timing
 */
async function playAudioBlob(audioBlob, onReadyToPrefetch) {
  return new Promise((resolve, reject) => {
    (async () => {
      if (shouldStop) {
        resolve({ stopped: true });
        return;
      }

      try {
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio();
        audio.src = audioUrl;
        audio.preload = 'auto';
        audio.playbackRate = playbackSpeed;
        audio.preservesPitch = true;
        audio.mozPreservesPitch = true;
        audio.webkitPreservesPitch = true;

        currentAudioElement = audio;
        currentAudioUrl = audioUrl;

        let prefetchTimer = null;
        let settled = false;

        const cleanup = () => {
          if (prefetchTimer) {
            clearTimeout(prefetchTimer);
          }
          if (currentAudioUrl === audioUrl) {
            currentAudioUrl = null;
          }
          if (currentAudioElement === audio) {
            currentAudioElement = null;
          }
          URL.revokeObjectURL(audioUrl);
        };

        const settle = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const fail = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const setupPrefetchTimer = () => {
          if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
          const prefetchTime = (audio.duration / playbackSpeed) * 0.7 * 1000;
          prefetchTimer = setTimeout(() => {
            if (onReadyToPrefetch) {
              onReadyToPrefetch();
            }
          }, prefetchTime);
        };

        audio.addEventListener('loadedmetadata', setupPrefetchTimer, {
          once: true
        });

        // Handle completion
        audio.onended = () => {
          if (!shouldStop) {
            settle({ stopped: false });
          }
        };

        audio.onpause = () => {
          if (shouldStop) {
            settle({ stopped: true });
          }
        };

        audio.onerror = () => {
          fail(new Error('Audio playback failed'));
        };

        // Start playback
        getAudioContext();
        await audio.play();
      } catch (error) {
        reject(error);
      }
    })();
  });
}

/**
 * Synthesize a single paragraph - returns a promise for the audio blob
 */
async function synthesizeParagraph(text, voice) {
  const response = await fetch(`${SERVER_URL}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Server error');
  }

  return await response.blob();
}

/**
 * Get paragraphs from server
 */
async function getParagraphs(text) {
  const response = await fetch(`${SERVER_URL}/paragraphs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    throw new Error('Failed to split text into paragraphs');
  }

  const data = await response.json();
  return data.paragraphs;
}

/**
 * Read paragraphs with prefetching, starting from a specific index
 * @param {Array} paragraphs - Array of paragraph texts OR objects with {text, elementIndex}
 * @param {string} voice - Voice to use
 * @param {number} startIndex - Index to start reading from (0-based)
 * @param {number} speed - Playback speed multiplier
 * @param {boolean} useHighlighting - Whether to highlight elements during reading
 */
async function readParagraphsFromIndex(paragraphs, voice, startIndex = 0, speed = 1.0, useHighlighting = false) {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;
  totalParagraphs = paragraphs.length;
  currentParagraphIndex = startIndex;

  // Inject highlight styles if we're using highlighting
  if (useHighlighting) {
    injectHighlightStyles();
  }

  const total = paragraphs.length;
  const remaining = total - startIndex;

  try {
    notifyExtension({
      action: 'progress',
      percent: 10,
      text: `Reading from paragraph ${startIndex + 1}/${total}...`
    });

    // Cache for prefetched audio blobs
    const prefetchedAudio = new Map();

    // Get text from paragraph (handles both string and object formats)
    const getText = (para) => (typeof para === 'string' ? para : para.text);

    // Get element for highlighting
    const getElement = (para) => {
      if (typeof para === 'object' && para.elementIndex !== undefined) {
        return readableElements[para.elementIndex]?.element;
      }
      return null;
    };

    // Function to prefetch a paragraph
    const prefetchNext = (index) => {
      if (index < paragraphs.length && !prefetchedAudio.has(index) && !shouldStop) {
        synthesizeParagraph(getText(paragraphs[index]), voice)
          .then((blob) => {
            if (!shouldStop) {
              prefetchedAudio.set(index, blob);
            }
          })
          .catch((err) => {
            console.warn(`Prefetch failed for paragraph ${index}:`, err);
          });
      }
    };

    for (let i = startIndex; i < paragraphs.length; i++) {
      if (shouldStop) break;

      currentParagraphIndex = i;

      const progressPercent = 10 + Math.floor(((i - startIndex) / remaining) * 80);

      // Check if we have prefetched audio, otherwise generate it
      let audioBlob;
      if (prefetchedAudio.has(i)) {
        audioBlob = prefetchedAudio.get(i);
        prefetchedAudio.delete(i);
      } else {
        notifyExtension({
          action: 'progress',
          percent: progressPercent,
          text: `Generating ${i + 1}/${total}...`
        });
        audioBlob = await synthesizeParagraph(getText(paragraphs[i]), voice);
      }

      if (shouldStop) break;

      // Highlight the current element if available
      if (useHighlighting) {
        const element = getElement(paragraphs[i]);
        if (element) {
          highlightElement(element);
        }
      }

      // Notify that we're playing and save position
      notifyExtension({
        action: 'playing',
        current: i + 1,
        total: total
      });

      // Save current position for this URL
      saveReadingPosition(i, total);

      // Start prefetching next paragraph immediately when we start playing
      if (i + 1 < paragraphs.length) {
        prefetchNext(i + 1);
      }

      // Play the audio, with a callback to prefetch even further ahead at 70%
      const result = await playAudioBlob(audioBlob, () => {
        // When 70% through, start prefetching the one after next
        if (i + 2 < paragraphs.length) {
          prefetchNext(i + 2);
        }
      });

      if (result.stopped || shouldStop) break;
    }

    // Remove highlight when done
    removeHighlight();

    if (!shouldStop) {
      // Clear saved position when finished
      clearReadingPosition();
      notifyExtension({ action: 'complete' });
    }
  } catch (error) {
    removeHighlight();
    console.error('TTS error:', error);
    notifyExtension({ action: 'error', text: error.message });
  }
}

/**
 * Process and read text - extracts paragraphs first
 */
async function readText(text, voice, speed = 1.0) {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;

  try {
    notifyExtension({
      action: 'progress',
      percent: 5,
      text: 'Splitting into paragraphs...'
    });

    const paragraphs = await getParagraphs(text);

    if (shouldStop) return;

    await readParagraphsFromIndex(paragraphs, voice, 0, speed);
  } catch (error) {
    console.error('TTS error:', error);
    notifyExtension({ action: 'error', text: error.message });
  }
}

/**
 * Stop audio playback
 */
function stopPlayback() {
  shouldStop = true;
  isPaused = false;

  const audioElement = currentAudioElement;
  const audioUrl = currentAudioUrl;
  currentAudioElement = null;
  currentAudioUrl = null;

  if (audioElement) {
    try {
      audioElement.pause();
      audioElement.currentTime = 0;
    } catch (e) {
      // Ignore
    }
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
  }

  // Remove highlight
  removeHighlight();

  notifyExtension({ action: 'stopped' });
}

/**
 * Pause audio playback
 */
function pausePlayback() {
  if (currentAudioElement && !isPaused) {
    try {
      currentAudioElement.pause();
    } catch (e) {
      // Ignore
    }
    isPaused = true;
    notifyExtension({ action: 'paused' });
  }
}

/**
 * Resume audio playback
 */
async function resumePlayback() {
  if (isPaused && currentAudioElement) {
    try {
      currentAudioElement.playbackRate = playbackSpeed;
      await currentAudioElement.play();
      isPaused = false;
      notifyExtension({ action: 'resumed' });
    } catch (error) {
      console.error('Resume playback error:', error);
      notifyExtension({ action: 'error', text: 'Failed to resume playback' });
    }
  }
}

/**
 * Stop selection reading
 */
function stopSelectionReading() {
  isReadingSelection = false;

  if (selectionAudioElement) {
    try {
      selectionAudioElement.pause();
      selectionAudioElement.currentTime = 0;
    } catch (e) {
      // Source might already be stopped
    }
    selectionAudioElement = null;
  }

  if (selectionAudioUrl) {
    URL.revokeObjectURL(selectionAudioUrl);
    selectionAudioUrl = null;
  }
}

/**
 * Speak selected text using context menu
 */
async function speakSelection(voice, speed) {
  try {
    // Get selected text
    const selectedText = window.getSelection().toString().trim();

    if (!selectedText) {
      alert('No text selected');
      return;
    }

    // Stop any previous selection audio
    stopSelectionReading();

    isReadingSelection = true;

    // Synthesize the selected text
    const audioBlob = await synthesizeParagraph(selectedText, voice);

    if (!isReadingSelection) return; // Stopped while synthesizing

    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio();
    audio.src = audioUrl;
    audio.preload = 'auto';
    audio.playbackRate = speed;
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;

    selectionAudioElement = audio;
    selectionAudioUrl = audioUrl;

    audio.onended = () => {
      selectionAudioElement = null;
      if (selectionAudioUrl) {
        URL.revokeObjectURL(selectionAudioUrl);
        selectionAudioUrl = null;
      }
      isReadingSelection = false;
    };

    audio.onerror = () => {
      selectionAudioElement = null;
      if (selectionAudioUrl) {
        URL.revokeObjectURL(selectionAudioUrl);
        selectionAudioUrl = null;
      }
      isReadingSelection = false;
    };

    await audio.play();
  } catch (error) {
    isReadingSelection = false;
    console.error('Error speaking selection:', error);

    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      alert('Could not connect to TTS server. Make sure the server is running at http://localhost:5050');
    } else {
      alert('Error: ' + error.message);
    }
  }
}

/**
 * Listen for messages from popup or background
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractContent') {
    try {
      const text = extractMainContent();
      const title = getPageTitle();

      // Prepend title if available
      const fullText = title ? `${title}. ${text}` : text;

      sendResponse({
        success: true,
        text: fullText,
        title: title,
        url: window.location.href,
        length: fullText.length
      });
    } catch (error) {
      console.error('Error extracting content:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  } else if (message.action === 'scanElements') {
    // Extract readable elements and store references for highlighting
    try {
      readableElements = extractReadableElements();

      // Return just the text for each element (we keep element refs locally)
      const paragraphs = readableElements.map((item, index) => ({
        text: item.text,
        elementIndex: index
      }));

      sendResponse({
        success: true,
        paragraphs: paragraphs,
        count: paragraphs.length
      });
    } catch (error) {
      console.error('Error scanning elements:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  } else if (message.action === 'readText') {
    // Read text from the beginning (extracts paragraphs internally)
    readText(message.text, message.voice, message.speed || 1.0);
    sendResponse({ status: 'started' });
  } else if (message.action === 'readParagraphs') {
    // Read pre-scanned paragraphs from a specific index
    // Check if paragraphs have elementIndex (for highlighting)
    const useHighlighting =
      message.paragraphs.length > 0 &&
      typeof message.paragraphs[0] === 'object' &&
      message.paragraphs[0].elementIndex !== undefined;
    readParagraphsFromIndex(
      message.paragraphs,
      message.voice,
      message.startIndex || 0,
      message.speed || 1.0,
      useHighlighting
    );
    sendResponse({ status: 'started' });
  } else if (message.action === 'stop') {
    stopPlayback();
    sendResponse({ status: 'stopped' });
  } else if (message.action === 'pause') {
    pausePlayback();
    sendResponse({ status: 'paused' });
  } else if (message.action === 'resume') {
    resumePlayback();
    sendResponse({ status: 'resumed' });
  } else if (message.action === 'setSpeed') {
    playbackSpeed = message.speed;
    if (currentAudioElement) {
      currentAudioElement.playbackRate = playbackSpeed;
    }
    sendResponse({ status: 'speed_set', speed: playbackSpeed });
  } else if (message.action === 'getPlaybackState') {
    sendResponse({
      isPlaying: currentAudioElement !== null && !isPaused,
      isPaused: isPaused,
      isStopped: currentAudioElement === null
    });
  } else if (message.action === 'getSavedPosition') {
    const url = getNormalizedUrl();
    chrome.storage.local.get('readingPositions', (result) => {
      const positions = result.readingPositions || {};
      sendResponse(positions[url] || null);
    });
    return true; // Async response
  } else if (message.action === 'clearSavedPosition') {
    clearReadingPosition();
    sendResponse({ status: 'cleared' });
  } else if (message.action === 'speakSelection') {
    speakSelection(message.voice, message.speed);
    sendResponse({ status: 'started' });
  }

  // Return true to indicate async response
  return true;
});

// Log that content script is loaded
console.log('Pocket Reader content script loaded');
