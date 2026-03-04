// Offscreen document for speech recognition
// This runs in a hidden document with microphone access

const WS_URL = 'ws://localhost:5005';

let websocket = null;
let recognition = null;
let speechSynthesis = window.speechSynthesis;
let currentTranscript = '';
let isListening = false;
let userEmail = null;
let microphoneStream = null;
let microphonePermissionGranted = false;

console.log('🎤 Offscreen document loaded for speech recognition');

// Initialize
initWebSocket();
initSpeechRecognition();
loadVoices();

// Don't request permission on load - wait for user action
console.log('⏳ Waiting for user to click microphone button...');

// ============================================================================
// Message Handler - Communication with Sidebar
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 Offscreen received message:', message);

  switch (message.type) {
    case 'START_LISTENING':
      userEmail = message.userEmail;
      startListening();
      sendResponse({ success: true });
      break;

    case 'STOP_LISTENING':
      stopListening();
      sendResponse({ success: true });
      break;

    case 'SPEAK':
      speak(message.text);
      sendResponse({ success: true });
      break;

    case 'INIT_WEBSOCKET':
      userEmail = message.userEmail;
      initWebSocket();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return true; // Keep channel open for async response
});

// ============================================================================
// WebSocket
// ============================================================================

function initWebSocket() {
  if (!userEmail) {
    console.log('⚠️ No user email, waiting...');
    return;
  }

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    console.log('✅ WebSocket already connected');
    return;
  }

  const wsUrl = `${WS_URL}/ws/chat/${encodeURIComponent(userEmail)}`;
  console.log('🔄 Connecting to WebSocket:', wsUrl);

  try {
    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('✅ WebSocket connected successfully');
      sendToSidebar({ type: 'WS_CONNECTED' });
    };

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('📨 WebSocket message:', data);
      handleWebSocketMessage(data);
    };

    websocket.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      sendToSidebar({ type: 'WS_ERROR', error: 'Connection failed' });
    };

    websocket.onclose = (event) => {
      console.log('🔴 WebSocket disconnected. Code:', event.code);
      sendToSidebar({ type: 'WS_DISCONNECTED' });

      setTimeout(() => {
        console.log('🔄 Attempting to reconnect...');
        initWebSocket();
      }, 3000);
    };
  } catch (error) {
    console.error('❌ Failed to create WebSocket:', error);
  }
}

function handleWebSocketMessage(data) {
  if (data.type === 'complete' || data.type === 'step' && data.step_type === 'agent_finish') {
    const message = data.final_output || data.content || data.message || 'Task completed';
    sendToSidebar({
      type: 'AI_RESPONSE',
      message: message
    });
    speak(message);
  } else if (data.type === 'error') {
    const errorMsg = data.error || 'An error occurred';
    sendToSidebar({
      type: 'AI_RESPONSE',
      message: errorMsg,
      isError: true
    });
    speak('Error: ' + errorMsg);
  }
}

// ============================================================================
// Microphone Permission
// ============================================================================

async function requestMicrophonePermission() {
  try {
    console.log('🎤 Requesting microphone permission...');

    // Request microphone access
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    console.log('✅ Microphone permission granted in offscreen document');
    microphonePermissionGranted = true;

    // We don't need to keep the stream active for speech recognition
    // Speech recognition will request its own access now that permission is granted
    if (microphoneStream) {
      microphoneStream.getTracks().forEach(track => track.stop());
      microphoneStream = null;
    }

    // Notify sidebar that microphone is ready
    sendToSidebar({ type: 'MICROPHONE_READY' });

    return true;
  } catch (error) {
    console.error('❌ Microphone permission denied in offscreen:', error);
    microphonePermissionGranted = false;

    // Notify sidebar of permission error
    sendToSidebar({
      type: 'ERROR',
      error: 'Microphone access denied. Please allow microphone access in the permission popup.'
    });

    return false;
  }
}

// ============================================================================
// Speech Recognition
// ============================================================================

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    console.error('❌ Speech recognition not supported');
    sendToSidebar({ type: 'ERROR', error: 'Speech recognition not supported' });
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    console.log('🎤 Speech recognition started');
    isListening = true;
    sendToSidebar({ type: 'LISTENING_STARTED' });
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript + ' ';
      } else {
        interimTranscript += transcript;
      }
    }

    if (finalTranscript) {
      currentTranscript += finalTranscript;
    }

    sendToSidebar({
      type: 'TRANSCRIPT_UPDATE',
      final: currentTranscript,
      interim: interimTranscript
    });
  };

  recognition.onerror = (event) => {
    console.error('❌ Speech recognition error:', event.error);
    isListening = false;

    if (event.error === 'not-allowed') {
      sendToSidebar({
        type: 'ERROR',
        error: 'Microphone access denied. Please allow microphone access.'
      });
    } else if (event.error !== 'no-speech') {
      sendToSidebar({
        type: 'ERROR',
        error: 'Speech recognition error: ' + event.error
      });
    }
  };

  recognition.onend = () => {
    console.log('🛑 Speech recognition ended');
    isListening = false;
    sendToSidebar({ type: 'LISTENING_STOPPED' });

    // Auto-send after 1.5 seconds
    if (currentTranscript.trim()) {
      setTimeout(() => {
        if (!isListening && currentTranscript.trim()) {
          console.log('✅ Auto-sending:', currentTranscript);
          sendCommand(currentTranscript.trim());
        }
      }, 1500);
    }
  };

  console.log('✅ Speech recognition initialized');
}

async function startListening() {
  // Check if microphone permission is granted
  if (!microphonePermissionGranted) {
    console.log('⚠️ Microphone permission not granted, requesting...');
    const granted = await requestMicrophonePermission();

    if (!granted) {
      console.error('❌ Cannot start listening without microphone permission');
      sendToSidebar({
        type: 'ERROR',
        error: 'Microphone permission required. Please allow access when prompted.'
      });
      return;
    }
  }

  if (!recognition) {
    initSpeechRecognition();
  }

  if (isListening) {
    console.log('⚠️ Already listening');
    return;
  }

  currentTranscript = '';

  try {
    recognition.start();
    console.log('🎤 Started listening');
  } catch (error) {
    console.error('❌ Failed to start listening:', error);

    if (error.message && error.message.includes('already started')) {
      recognition.stop();
      setTimeout(() => {
        try {
          recognition.start();
        } catch (e) {
          console.error('❌ Restart failed:', e);
        }
      }, 100);
    } else {
      // Send error to sidebar
      sendToSidebar({
        type: 'ERROR',
        error: 'Failed to start speech recognition: ' + error.message
      });
    }
  }
}

function stopListening() {
  if (recognition && isListening) {
    recognition.stop();
    console.log('🛑 Stopped listening');
  }
}

// ============================================================================
// Text-to-Speech
// ============================================================================

function loadVoices() {
  if (speechSynthesis.getVoices().length === 0) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      console.log('🔊 Voices loaded:', speechSynthesis.getVoices().length);
    });
  }
}

function speak(text) {
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.2;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  const voices = speechSynthesis.getVoices();
  const preferredVoice = voices.find(voice =>
    voice.name.includes('Google') ||
    voice.name.includes('Microsoft') ||
    voice.lang.startsWith('en')
  );

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  }

  utterance.onstart = () => {
    sendToSidebar({ type: 'SPEAKING_STARTED' });
  };

  utterance.onend = () => {
    sendToSidebar({ type: 'SPEAKING_ENDED' });
  };

  speechSynthesis.speak(utterance);
  console.log('🔊 Speaking:', text);
}

// ============================================================================
// Send Command
// ============================================================================

function sendCommand(message) {
  if (!message.trim()) return;

  sendToSidebar({
    type: 'COMMAND_SENT',
    message: message
  });

  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    console.error('❌ WebSocket not connected');
    sendToSidebar({
      type: 'ERROR',
      error: 'Not connected to server. Please check if agent_server.py is running.'
    });
    speak('Not connected to server. Please check the terminal.');
    return;
  }

  try {
    websocket.send(JSON.stringify({ message: message }));
    console.log('✅ Sent command:', message);

    currentTranscript = '';
    sendToSidebar({
      type: 'TRANSCRIPT_UPDATE',
      final: '',
      interim: ''
    });
  } catch (error) {
    console.error('❌ Failed to send:', error);
    sendToSidebar({
      type: 'ERROR',
      error: 'Failed to send message'
    });
    speak('Failed to send message. Please try again.');
  }
}

// ============================================================================
// Helper - Send Message to Sidebar
// ============================================================================

function sendToSidebar(message) {
  chrome.runtime.sendMessage(message).catch(err => {
    // Sidebar might not be open, that's okay
    console.log('📤 Message to sidebar (may be closed):', message.type);
  });
}
