// Permission popup - Requests microphone access
const allowBtn = document.getElementById('allowBtn');
const statusEl = document.getElementById('status');

let micStream = null;

// Request microphone access
allowBtn.addEventListener('click', async () => {
  statusEl.innerHTML = '<span class="spinner"></span>Requesting permission...';
  allowBtn.disabled = true;

  try {
    // Request microphone access
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    console.log('✅ Microphone permission granted!');

    // Show success message
    statusEl.className = 'status success';
    statusEl.textContent = '✅ Permission granted! Closing...';

    // Store that permission was granted
    await chrome.storage.local.set({ microphonePermissionGranted: true });

    // Stop the stream after a short delay so the audio hardware stays warm
    // for SpeechRecognition.start() which fires immediately after this popup closes.
    setTimeout(() => {
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
    }, 500);

    // Close window after a brief delay (use Chrome API — window.close() is unreliable in extension popups)
    setTimeout(() => {
      chrome.windows.getCurrent(win => chrome.windows.remove(win.id));
    }, 1000);

  } catch (error) {
    console.error('❌ Microphone permission denied:', error);

    statusEl.className = 'status error';

    if (error.name === 'NotAllowedError') {
      // Distinguish permanent denial from a transient one before showing UI.
      try {
        const permStatus = await navigator.permissions.query({ name: 'microphone' });
        if (permStatus.state === 'denied') {
          // Permanently blocked in Chrome — the Allow button will never succeed.
          console.log('[MIC POPUP] Permanent denial confirmed — showing settings guide');
          await chrome.storage.local.remove('microphonePermissionGranted');
          allowBtn.style.display = 'none';
          statusEl.innerHTML =
            '<strong>Microphone is permanently blocked.</strong><br><br>' +
            'To enable it in Chrome:<br>' +
            '1. Click the <strong>lock icon</strong> in Chrome\'s address bar, OR<br>' +
            '2. Go to <strong>Settings → Privacy and security<br>' +
            '&nbsp;&nbsp;&nbsp;→ Site settings → Microphone</strong><br>' +
            '3. Remove this extension from the blocked list<br>' +
            '4. Reload the extension';
        } else {
          // Transient — user can retry (hardware busy, tab switch, etc.)
          console.log('[MIC POPUP] Transient denial — user can retry');
          statusEl.textContent = '❌ Permission denied. Please try again.';
          allowBtn.disabled = false;
        }
      } catch (_) {
        // Permissions API unavailable — let user retry
        statusEl.textContent = '❌ Permission denied. Please try again.';
        allowBtn.disabled = false;
      }
    } else if (error.name === 'NotFoundError') {
      statusEl.textContent = '❌ No microphone found.';
      allowBtn.disabled = false;
    } else {
      statusEl.textContent = '❌ Error: ' + error.message;
      allowBtn.disabled = false;
    }
  }
});
