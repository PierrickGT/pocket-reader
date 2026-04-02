/**
 * Pocket Reader - Content Script
 * Extracts main content from web pages and handles audio playback
 * Compiles all paragraphs into a single audio file before playing
 */

const SERVER_URL = 'http://localhost:5050';

// Audio playback state
let audioContext = null;
let currentAudioElement = null;
let currentAudioUrl = null;
let shouldStop = false;
let isPaused = false;
let playbackSpeed = 1.0;
let mainAbortController = null;
let playbackTimeUpdateInterval = null;

// Selection reading state (separate from main page reading)
let selectionAudioElement = null;
let selectionAudioUrl = null;
let isReadingSelection = false;
let selectionStreamAbortController = null;

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
 * Find the main content container
 */
function findContentContainer() {
  const selectors = [
    '[data-testid="twitterArticleReadView"]',
    '[data-testid="tweet"]',
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

  const readableSelectors =
    '[data-testid="twitter-article-title"], [data-testid="tweetText"], [data-text="true"], p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre';

  const candidates = container.querySelectorAll(readableSelectors);

  for (const element of candidates) {
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

    if (isExcludedElement(element)) continue;
    if (!isVisible(element)) continue;

    const text = (element.innerText || element.textContent || '').trim();
    if (text.length < 10) continue;

    const childReadables = element.querySelectorAll(readableSelectors);
    if (childReadables.length > 0) {
      const childText = Array.from(childReadables)
        .map((c) => (c.innerText || '').trim())
        .join('');
      if (childText.length >= text.length * 0.9) {
        continue;
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
 * Extract the main readable content from the page
 */
function extractMainContent() {
  const elements = extractReadableElements();
  const texts = elements.map((e) => e.text);

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
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Start sending time-based progress updates to the popup while playing
 */
function startTimeUpdates() {
  stopTimeUpdates();
  playbackTimeUpdateInterval = setInterval(() => {
    if (!currentAudioElement || shouldStop || isPaused) return;

    const duration = currentAudioElement.duration;
    const currentTime = currentAudioElement.currentTime;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const percent = 10 + Math.floor((currentTime / duration) * 80);
    const remaining = Math.max(0, (duration - currentTime) / playbackSpeed);
    const mins = Math.floor(remaining / 60);
    const secs = Math.floor(remaining % 60);
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    notifyExtension({
      action: 'progress',
      percent: percent,
      text: `Playing... ${timeStr} left`
    });
  }, 1000);
}

function stopTimeUpdates() {
  if (playbackTimeUpdateInterval) {
    clearInterval(playbackTimeUpdateInterval);
    playbackTimeUpdateInterval = null;
  }
}

/**
 * Compile all text into a single audio file via the server, then play it.
 * @param {string} text - Full text to compile and play
 * @param {string} voice - Voice to use
 * @param {number} speed - Playback speed multiplier
 */
async function compileAndPlay(text, voice, speed = 1.0) {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;
  mainAbortController = new AbortController();

  try {
    notifyExtension({
      action: 'compiling'
    });

    notifyExtension({
      action: 'progress',
      percent: 5,
      text: 'Compiling audio...'
    });

    const response = await fetch(`${SERVER_URL}/synthesize-full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: mainAbortController.signal
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Server error');
    }

    if (shouldStop) return;

    const audioBlob = await response.blob();

    if (shouldStop) return;

    notifyExtension({
      action: 'progress',
      percent: 10,
      text: 'Playing audio...'
    });

    await playCompiledAudio(audioBlob);

    if (!shouldStop) {
      clearReadingPosition();
      notifyExtension({ action: 'complete' });
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('TTS error:', error);
    notifyExtension({ action: 'error', text: error.message });
  } finally {
    stopTimeUpdates();
    if (mainAbortController) {
      mainAbortController = null;
    }
  }
}

/**
 * Play a compiled audio blob from start to finish
 */
async function playCompiledAudio(audioBlob) {
  return new Promise((resolve, reject) => {
    (async () => {
      if (shouldStop) {
        resolve();
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

        let settled = false;

        const cleanup = () => {
          stopTimeUpdates();
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

        audio.onended = () => {
          if (!shouldStop) {
            settle();
          }
        };

        audio.onpause = () => {
          if (shouldStop) {
            settle();
          }
        };

        audio.onerror = () => {
          fail(new Error('Audio playback failed'));
        };

        getAudioContext();
        await audio.play();
        startTimeUpdates();
      } catch (error) {
        reject(error);
      }
    })();
  });
}

/**
 * Process and read text - sends directly to compile-then-play
 */
async function readText(text, voice, speed = 1.0) {
  shouldStop = false;
  isPaused = false;
  playbackSpeed = speed;
  await compileAndPlay(text, voice, speed);
}

/**
 * Stop audio playback
 */
function stopPlayback() {
  shouldStop = true;
  isPaused = false;
  stopTimeUpdates();

  if (mainAbortController) {
    mainAbortController.abort();
    mainAbortController = null;
  }

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
    stopTimeUpdates();
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
      startTimeUpdates();
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

  if (selectionStreamAbortController) {
    selectionStreamAbortController.abort();
    selectionStreamAbortController = null;
  }

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
 * Decode base64 audio into a Blob
 */
function base64ToAudioBlob(base64Audio) {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/**
 * Synthesize a single text blob - returns a promise for the audio blob
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
 * Play one selection chunk and resolve when finished
 */
async function playSelectionChunk(audioBlob, speed) {
  return new Promise((resolve, reject) => {
    (async () => {
      if (!isReadingSelection) {
        resolve({ stopped: true });
        return;
      }

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

      let settled = false;
      const cleanup = () => {
        if (selectionAudioElement === audio) {
          selectionAudioElement = null;
        }
        if (selectionAudioUrl === audioUrl) {
          selectionAudioUrl = null;
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

      audio.onended = () => settle({ stopped: false });
      audio.onpause = () => {
        if (!isReadingSelection) {
          settle({ stopped: true });
        }
      };
      audio.onerror = () => {
        const mediaError = audio.error;
        const code = mediaError ? mediaError.code : 'unknown';
        fail(new Error(`Selection audio playback failed (code: ${code})`));
      };

      try {
        await audio.play();
      } catch (error) {
        fail(error);
      }
    })().catch((error) => reject(error));
  });
}

/**
 * Stream synthesized selection audio chunks from server
 */
async function streamSelectionAudio(text, voice, onChunk, abortSignal) {
  const response = await fetch(`${SERVER_URL}/synthesize-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
    signal: abortSignal
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Streaming synthesis failed');
  }

  if (!response.body) {
    throw new Error('Streaming response is not supported by this browser');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line) => {
    if (!line) return;

    const payload = JSON.parse(line);
    if (payload.type === 'chunk' && payload.audio) {
      onChunk(base64ToAudioBlob(payload.audio));
      return;
    }

    if (payload.type === 'error') {
      throw new Error(payload.error || 'Streaming synthesis failed');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  const trailingLine = buffer.trim();
  if (trailingLine) {
    handleLine(trailingLine);
  }
}

/**
 * Speak selected text using context menu (still uses streaming for low latency)
 */
async function speakSelection(voice, speed) {
  let selectedText = '';
  let hasPlayedAnyStreamChunk = false;

  try {
    selectedText = window.getSelection().toString().trim();

    if (!selectedText) {
      alert('No text selected');
      return;
    }

    stopSelectionReading();

    isReadingSelection = true;

    selectionStreamAbortController = new AbortController();

    const chunkQueue = [];
    let streamComplete = false;
    let streamError = null;
    let queueResolver = null;

    const enqueueChunk = (chunkBlob) => {
      if (queueResolver) {
        const resolve = queueResolver;
        queueResolver = null;
        resolve(chunkBlob);
      } else {
        chunkQueue.push(chunkBlob);
      }
    };

    const finishQueue = () => {
      streamComplete = true;
      if (queueResolver) {
        const resolve = queueResolver;
        queueResolver = null;
        resolve(null);
      }
    };

    const getNextChunk = async () => {
      if (chunkQueue.length > 0) {
        return chunkQueue.shift();
      }
      if (streamComplete) {
        return null;
      }
      return new Promise((resolve) => {
        queueResolver = resolve;
      });
    };

    const streamTask = streamSelectionAudio(selectedText, voice, enqueueChunk, selectionStreamAbortController.signal)
      .catch((error) => {
        streamError = error;
      })
      .finally(() => {
        finishQueue();
      });

    while (isReadingSelection) {
      const nextChunk = await getNextChunk();

      if (!nextChunk) {
        break;
      }

      try {
        const playResult = await playSelectionChunk(nextChunk, speed);
        if (playResult.stopped) {
          break;
        }
        hasPlayedAnyStreamChunk = true;
      } catch (playbackError) {
        if (!hasPlayedAnyStreamChunk) {
          streamError = playbackError;
          break;
        }

        console.warn('Selection chunk playback failed, skipping chunk:', playbackError);
      }
    }

    await streamTask;

    if (streamError && streamError.name !== 'AbortError') {
      if (!hasPlayedAnyStreamChunk) {
        console.warn('Selection streaming failed before playback; falling back to /synthesize:', streamError);
        const fallbackBlob = await synthesizeParagraph(selectedText, voice);

        if (!isReadingSelection) {
          return;
        }

        await playSelectionChunk(fallbackBlob, speed);
        return;
      }

      throw streamError;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    console.error('Error speaking selection:', error);

    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      alert('Could not connect to TTS server. Make sure the server is running at http://localhost:5050');
    } else {
      alert('Error: ' + error.message);
    }
  } finally {
    isReadingSelection = false;
    if (selectionStreamAbortController) {
      selectionStreamAbortController = null;
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
  } else if (message.action === 'readText') {
    readText(message.text, message.voice, message.speed || 1.0);
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
    return true;
  } else if (message.action === 'clearSavedPosition') {
    clearReadingPosition();
    sendResponse({ status: 'cleared' });
  } else if (message.action === 'speakSelection') {
    speakSelection(message.voice, message.speed);
    sendResponse({ status: 'started' });
  }

  return true;
});

console.log('Pocket Reader content script loaded');
