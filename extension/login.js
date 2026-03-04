// Extension Login JavaScript
const API_BASE_URL = 'http://localhost:8000';

// DOM Elements
const loginForm = document.getElementById('loginFormElement');
const signupFormElement = document.getElementById('signupFormElement');
const loginTab = document.getElementById('loginTab');
const signupTab = document.getElementById('signupTab');
const loginFormContainer = document.getElementById('loginForm');
const signupFormContainer = document.getElementById('signupForm');
const switchToSignup = document.getElementById('switchToSignup');
const switchToLogin = document.getElementById('switchToLogin');
const googleLoginBtn = document.getElementById('googleLoginBtn');
const googleSignupBtn = document.getElementById('googleSignupBtn');

// Toast notification function
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Check if user is already logged in
async function checkAuthStatus() {
  const result = await chrome.storage.local.get(['isAuthenticated', 'userEmail']);
  if (result.isAuthenticated) {
    // User is already logged in, redirect to sidebar
    window.location.href = 'sidebar.html';
  }
}

// Handle Login Form Submission
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showToast('Please fill in all fields', 'error');
    return;
  }

  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';

  try {
    const response = await fetch(`${API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // Important for cookies/session
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      // Save auth state to chrome storage
      await chrome.storage.local.set({
        isAuthenticated: true,
        userEmail: email,
        username: data.user?.username || email,
        firstName: data.user?.firstName || email.split('@')[0]
      });

      showToast('Login successful! Redirecting...', 'success');

      // Notify background script about successful login
      chrome.runtime.sendMessage({ action: 'loginSuccess' }, (response) => {
        console.log('Background notified of login:', response);
      });

      // Redirect to sidebar
      setTimeout(() => {
        window.location.href = 'sidebar.html';
      }, 1000);

    } else {
      showToast(data.error || 'Login failed. Please check your credentials.', 'error');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }

  } catch (error) {
    console.error('Login error:', error);
    showToast('Connection error. Make sure the backend server is running.', 'error');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
  }
});

// Handle Signup Button - Redirect to Website
signupFormElement.addEventListener('submit', (e) => {
  e.preventDefault();

  // Open the website signup page in a new tab
  chrome.tabs.create({
    url: `${API_BASE_URL}/signup`
  });

  showToast('Opening signup page in browser...', 'info');
});

// Handle "Sign Up" link click - Redirect to website
switchToSignup.addEventListener('click', (e) => {
  e.preventDefault();

  // Open the website signup page in a new tab
  chrome.tabs.create({
    url: `${API_BASE_URL}/signup`
  });

  showToast('Opening signup page in browser...', 'info');
});

// Handle Google Login - Use Web Auth Flow (works for all users)
googleLoginBtn.addEventListener('click', async (e) => {
  e.preventDefault();

  googleLoginBtn.disabled = true;
  showToast('Opening Google sign-in...', 'info');

  try {
    console.log('Step 1: Initiating Google OAuth flow...');

    // Google OAuth configuration
    const clientId = '265869413628-8a9rlgem2m7p8qlith3d9bel2vkru8vu.apps.googleusercontent.com';
    const redirectUri = chrome.identity.getRedirectURL();
    const scopes = ['email', 'profile'];

    console.log('Redirect URI:', redirectUri);

    // Build OAuth URL
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scopes.join(' '));

    console.log('Step 2: Launching auth flow...');
    console.log('Auth URL:', authUrl.toString());

    // Launch web auth flow
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl.toString(),
        interactive: true
      },
      async (redirectUrl) => {
        if (chrome.runtime.lastError) {
          console.error('Web auth flow error:');
          console.error('Error message:', chrome.runtime.lastError.message);
          console.error('Full error:', JSON.stringify(chrome.runtime.lastError));
          showToast(`Google auth error: ${chrome.runtime.lastError.message}`, 'error');
          googleLoginBtn.disabled = false;
          return;
        }

        if (!redirectUrl) {
          console.error('No redirect URL received');
          showToast('Google authentication was cancelled', 'error');
          googleLoginBtn.disabled = false;
          return;
        }

        console.log('Step 3: Auth flow completed, processing response...');

        try {
          // Extract access token from redirect URL
          const url = new URL(redirectUrl);
          const hash = url.hash.substring(1);
          const params = new URLSearchParams(hash);
          const accessToken = params.get('access_token');

          if (!accessToken) {
            console.error('No access token in redirect URL');
            showToast('Failed to get authentication token', 'error');
            googleLoginBtn.disabled = false;
            return;
          }

          console.log('Step 4: Access token received, fetching user info...');

          // Fetch user info from Google API
          const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
              'Authorization': `Bearer ${accessToken}`
            }
          });

          if (!userInfoResponse.ok) {
            console.error('Google API error:', userInfoResponse.status);
            showToast('Failed to fetch user info from Google', 'error');
            googleLoginBtn.disabled = false;
            return;
          }

          const userInfo = await userInfoResponse.json();
          console.log('Step 5: User info received:', userInfo);

          // Send user info to backend
          console.log('Step 6: Sending user info to backend...');
          const response = await fetch(`${API_BASE_URL}/api/auth/google/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
              email: userInfo.email,
              name: userInfo.name,
              google_id: userInfo.id,
              picture: userInfo.picture
            })
          });

          const data = await response.json();
          console.log('Step 7: Backend response:', data);

          if (response.ok && data.success) {
            // Save auth state to chrome storage
            await chrome.storage.local.set({
              isAuthenticated: true,
              userEmail: userInfo.email,
              username: data.user?.username || userInfo.name
            });

            console.log('Step 8: Authentication successful, redirecting...');
            showToast('Google login successful! Redirecting...', 'success');

            // Notify background script
            chrome.runtime.sendMessage({ action: 'loginSuccess' }, (response) => {
              console.log('Background notified of Google login:', response);
            });

            // Redirect to sidebar
            setTimeout(() => {
              window.location.href = 'sidebar.html';
            }, 1000);

          } else {
            console.error('Backend authentication failed:', data);

            // Check if user needs to signup first
            if (data.redirect_to_signup) {
              showToast('Account not found. Redirecting to signup...', 'error');

              // Open signup page in new tab
              setTimeout(() => {
                chrome.tabs.create({
                  url: `${API_BASE_URL}/signup`
                });
              }, 1500);
            } else {
              showToast(data.error || 'Google authentication failed.', 'error');
            }

            googleLoginBtn.disabled = false;
          }

        } catch (error) {
          console.error('Error processing auth response:', error);
          showToast(`Authentication error: ${error.message}`, 'error');
          googleLoginBtn.disabled = false;
        }
      }
    );

  } catch (error) {
    console.error('Google login error:', error);
    showToast(`Login error: ${error.message}`, 'error');
    googleLoginBtn.disabled = false;
  }
});

// Handle Google Signup - Redirect to website
googleSignupBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showToast('Opening signup page in browser...', 'info');
  chrome.tabs.create({
    url: `${API_BASE_URL}/signup`
  });
});

// Tab switching
loginTab.addEventListener('click', () => {
  loginTab.classList.add('active');
  signupTab.classList.remove('active');
  loginFormContainer.classList.remove('hidden');
  signupFormContainer.classList.add('hidden');
});

// Signup tab - redirect to website instead of showing form
signupTab.addEventListener('click', (e) => {
  e.preventDefault();

  // Open website signup page in new tab
  chrome.tabs.create({
    url: `${API_BASE_URL}/signup`
  });

  showToast('Opening signup page in browser...', 'info');

  // Keep login tab active (don't switch to signup)
  loginTab.classList.add('active');
  signupTab.classList.remove('active');
});

switchToLogin.addEventListener('click', (e) => {
  e.preventDefault();
  loginTab.click();
});

// Check auth status on page load
checkAuthStatus();
