/**
 * Pocket Reader - Popup Script
 * Handles UI interactions and communication with content script
 */

const SERVER_URL = 'http://localhost:5050';

// DOM Elements
const serverStatus = document.getElementById('server-status');
const voiceSelect = document.getElementById('voice-select');
const speedControl = document.getElementById('speed-control');
const speedValue = document.getElementById('speed-value');

const btnRead = document.getElementById('btn-read');
const btnPause = document.getElementById('btn-pause');
const btnStop = document.getElementById('btn-stop');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const messageEl = document.getElementById('message');

// State
let isPlaying = false;
let isPaused = false;
let serverConnected = false;
let currentTabId = null;

/**
 * Initialize popup
 */
async function init() {
  // Load saved voice preference
  const { voice, speed } = await chrome.storage.local.get(['voice', 'speed']);
  if (voice) {
    voiceSelect.value = voice;
  }
  if (speed) {
    speedControl.value = speed;
    speedValue.textContent = `${speed}x`;
  }

  // Check server status
  await checkServerStatus();

  // Set up event listeners
  voiceSelect.addEventListener('change', saveVoicePreference);
  speedControl.addEventListener('input', handleSpeedChange);
  btnRead.addEventListener('click', handleRead);
  btnPause.addEventListener('click', handlePause);
  btnStop.addEventListener('click', handleStop);

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener(handleContentMessage);

  // Check current playback state
  const { playing } = await chrome.storage.local.get('playing');
  if (playing) {
    setPlayingState(true);
  }
}

/**
 * Check if the TTS server is running
 */
async function checkServerStatus() {
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000)
    });

    if (response.ok) {
      setServerStatus('connected', 'Server connected');
      serverConnected = true;
      btnRead.disabled = false;
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    setServerStatus('disconnected', 'Server offline');
    serverConnected = false;
    btnRead.disabled = true;
    showMessage('error', 'Server not running. Start it with: uv run server.py');
  }
}

/**
 * Update server status indicator
 */
function setServerStatus(status, text) {
  serverStatus.className = `status status-${status}`;
  serverStatus.querySelector('.status-text').textContent = text;
}

/**
 * Save voice preference
 */
function saveVoicePreference() {
  chrome.storage.local.set({ voice: voiceSelect.value });
}

/**
 * Handle speed change
 */
function handleSpeedChange() {
  const speed = parseFloat(speedControl.value);
  speedValue.textContent = `${speed.toFixed(1)}x`;
  chrome.storage.local.set({ speed: speed });

  if (currentTabId && isPlaying) {
    chrome.tabs.sendMessage(currentTabId, { action: 'setSpeed', speed: speed }).catch(() => {});
  }
}

/**
 * Handle Read button click
 */
async function handleRead() {
  if (!serverConnected) {
    showMessage('error', 'Server not connected');
    return;
  }

  hideMessage();
  setPlayingState(true);
  updateProgress(0, 'Starting...');

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      throw new Error('No active tab found');
    }

    currentTabId = tab.id;

    // Ensure content script is loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
    } catch (e) {
      // Script might already be loaded
    }

    const voice = voiceSelect.value;
    const speed = parseFloat(speedControl.value);

    chrome.tabs.sendMessage(tab.id, { action: 'extractContent' }, (response) => {
      if (chrome.runtime.lastError) {
        showMessage('error', 'Could not access page content');
        setPlayingState(false);
        return;
      }

      if (!response || !response.text) {
        showMessage('error', 'Could not extract page content');
        setPlayingState(false);
        return;
      }

      chrome.tabs.sendMessage(tab.id, {
        action: 'readText',
        text: response.text,
        voice: voice,
        speed: speed
      });
    });
  } catch (error) {
    console.error('Error starting read:', error);
    showMessage('error', error.message);
    setPlayingState(false);
  }
}

/**
 * Handle Pause/Resume button click
 */
function handlePause() {
  if (!currentTabId) return;

  if (isPaused) {
    // Resume playback
    chrome.tabs.sendMessage(currentTabId, { action: 'resume' }).catch(() => {});
    setPausedState(false);
  } else {
    // Pause playback
    chrome.tabs.sendMessage(currentTabId, { action: 'pause' }).catch(() => {});
    setPausedState(true);
  }
}

/**
 * Handle Stop button click
 */
function handleStop() {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: 'stop' }).catch(() => {});
  }
  setPlayingState(false);
  setPausedState(false);
  hideMessage();
  progressContainer.classList.add('hidden');
}

/**
 * Handle messages from content script
 */
function handleContentMessage(message, sender) {
  // Only handle messages from content scripts (they have a tab)
  if (!sender.tab) return;

  switch (message.action) {
    case 'compiling':
      setPlayingState(true);
      updateProgress(5, 'Compiling audio...');
      break;

    case 'progress':
      updateProgress(message.percent, message.text);
      break;

    case 'playing':
      setPlayingState(true);
      updateProgress(10, 'Playing audio...');
      break;

    case 'stopped':
      setPlayingState(false);
      setPausedState(false);
      progressContainer.classList.add('hidden');
      break;

    case 'paused':
      setPausedState(true);
      break;

    case 'resumed':
      setPausedState(false);
      break;

    case 'error':
      showMessage('error', message.text);
      setPlayingState(false);
      break;

    case 'complete':
      setPlayingState(false);
      progressContainer.classList.add('hidden');
      showMessage('success', 'Finished reading');
      break;
  }
}

/**
 * Update playing state UI
 */
function setPlayingState(playing) {
  isPlaying = playing;
  btnRead.disabled = playing || !serverConnected;
  btnPause.disabled = !playing;
  btnStop.disabled = !playing;

  if (playing) {
    progressContainer.classList.remove('hidden');
  }

  chrome.storage.local.set({ playing: playing });
}

/**
 * Update paused state UI
 */
function setPausedState(paused) {
  isPaused = paused;
  const pauseIcon = btnPause.querySelector('.icon');
  const pauseText = btnPause.childNodes[btnPause.childNodes.length - 1];

  if (paused) {
    pauseIcon.className = 'icon icon-play';
    pauseText.textContent = 'Resume';
  } else {
    pauseIcon.className = 'icon icon-pause';
    pauseText.textContent = 'Pause';
  }
}

/**
 * Update progress bar
 */
function updateProgress(percent, text) {
  progressContainer.classList.remove('hidden');
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text;
}

/**
 * Show message
 */
function showMessage(type, text) {
  messageEl.className = `message ${type}`;
  messageEl.textContent = text;
  messageEl.classList.remove('hidden');
}

/**
 * Hide message
 */
function hideMessage() {
  messageEl.classList.add('hidden');
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
