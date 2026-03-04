// Background Service Worker for AI Chat Assistant Extension

console.log('AI Chat Assistant background service worker loaded');

// Set side panel behavior to open on action click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Error setting panel behavior:', error));

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Extension installed - Welcome!');

    // Clear any existing auth data on fresh install
    chrome.storage.local.clear();

    // Set default side panel to login page
    chrome.sidePanel.setOptions({
      path: 'login.html',
      enabled: true
    });

    console.log('Extension will show login page on first open');
  } else if (details.reason === 'update') {
    console.log('Extension updated to version:', chrome.runtime.getManifest().version);
  }
});

// Listen for messages from extension pages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request);

  if (request.action === 'checkAuth') {
    // Check authentication status
    chrome.storage.local.get(['isAuthenticated', 'userEmail', 'username'], (result) => {
      sendResponse({
        isAuthenticated: result.isAuthenticated || false,
        userEmail: result.userEmail || null,
        username: result.username || null
      });
    });
    return true; // Will respond asynchronously
  }

  if (request.action === 'logout') {
    // Handle logout - clear storage and reset to login page
    chrome.storage.local.clear(() => {
      console.log('User logged out, storage cleared');

      // Reset side panel to login page
      chrome.sidePanel.setOptions({
        path: 'login.html'
      }).then(() => {
        console.log('Side panel reset to login.html');
        sendResponse({ success: true });
      }).catch((error) => {
        console.error('Error resetting side panel:', error);
        sendResponse({ success: false, error: error.message });
      });
    });
    return true;
  }

  if (request.action === 'loginSuccess') {
    // Update side panel to show sidebar after successful login
    chrome.sidePanel.setOptions({
      path: 'sidebar.html'
    }).then(() => {
      console.log('Side panel updated to sidebar.html');
      sendResponse({ success: true });
    }).catch((error) => {
      console.error('Error updating side panel:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
});

// Monitor storage changes for debugging
chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log('Storage changed in', namespace, ':', changes);
});
