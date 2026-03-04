// Extension Sidebar JavaScript - Chat Interface with WebSocket Streaming
const API_BASE_URL = 'http://localhost:8000';
const AGENT_API_URL = 'http://localhost:5005';
const WS_URL = 'ws://localhost:5005';

// Generate unique session ID
const SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// WebSocket connection
let websocket = null;
let isConnecting = false;

// Store current task steps
let currentTaskSteps = [];
let currentStepContainer = null;

// Automation state tracking
let isAutomationRunning = false;

// Check authentication on load
async function checkAuth() {
  const result = await chrome.storage.local.get(['isAuthenticated', 'userEmail', 'username', 'firstName']);

  if (!result.isAuthenticated) {
    // Not logged in, redirect to login
    window.location.href = 'login.html';
    return null;
  }

  return result;
}

// Initialize the sidebar
async function initSidebar() {
  const user = await checkAuth();
  if (!user) return;

  // Update welcome message with first name
  const welcomeMessage = document.querySelector('.welcome-message');
  if (welcomeMessage) {
    const welcomeTitle = welcomeMessage.querySelector('h2');
    if (welcomeTitle) {
      // Use first name if available, otherwise extract from username
      const firstName = user.firstName || (user.username ? user.username.split(' ')[0] : 'User');
      welcomeTitle.textContent = `Welcome, ${firstName}!`;
    }
  }

  // Add logout button to header
  addLogoutButton();

  // Initialize chat functionality
  initChat();

  // Initialize inline voice input
  initInlineVoice();

  // Initialize WebSocket connection
  initWebSocket();
}

// Add logout button to header
function addLogoutButton() {
  const header = document.querySelector('.panel-header');

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'logout-btn';
  logoutBtn.title = 'Logout';
  logoutBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
      <line x1="12" y1="2" x2="12" y2="12"></line>
    </svg>
  `;
  logoutBtn.style.cssText = `
    position: absolute;
    right: 15px;
    top: 15px;
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: white;
    padding: 8px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    width: 36px;
    height: 36px;
  `;

  logoutBtn.addEventListener('mouseenter', () => {
    logoutBtn.style.background = 'rgba(255, 77, 77, 0.3)';
    logoutBtn.style.transform = 'scale(1.1)';
  });

  logoutBtn.addEventListener('mouseleave', () => {
    logoutBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    logoutBtn.style.transform = 'scale(1)';
  });

  logoutBtn.addEventListener('click', logout);

  header.appendChild(logoutBtn);
}

// Logout function
async function logout() {
  try {
    // Call backend logout
    await fetch(`${API_BASE_URL}/ext/logout`, {
      method: 'GET',
      credentials: 'include'
    });
  } catch (error) {
    console.error('Logout error:', error);
  }

  // Close WebSocket if connected
  if (websocket) {
    websocket.close();
  }

  // Clear local storage
  await chrome.storage.local.clear();

  // Redirect to login
  window.location.href = 'login.html';
}

// Initialize WebSocket connection
async function initWebSocket() {
  if (isConnecting || (websocket && websocket.readyState === WebSocket.OPEN)) {
    console.log('WebSocket already connecting or connected');
    return;
  }

  // Get user email from storage for session persistence
  const user = await chrome.storage.local.get(['userEmail']);
  const userEmail = user.userEmail || 'anonymous';

  isConnecting = true;
  const wsUrl = `${WS_URL}/ws/chat/${encodeURIComponent(userEmail)}`;

  console.log('🔄 Connecting to WebSocket:', wsUrl, 'for user:', userEmail);

  try {
    websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('✅ WebSocket connected successfully!');
      isConnecting = false;
    };

    websocket.onmessage = (event) => {
      console.log('📨 RAW WebSocket message received:', event.data);
      try {
        const data = JSON.parse(event.data);
        console.log('📨 Parsed message:', data.type, data);
        handleWebSocketMessage(data);
      } catch (error) {
        console.error('❌ Failed to parse WebSocket message:', error);
      }
    };

    websocket.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      console.error('WebSocket URL:', wsUrl);
      console.error('Make sure agent_server.py is running on port 5005');
      isConnecting = false;
    };

    websocket.onclose = (event) => {
      console.log('🔴 WebSocket disconnected. Code:', event.code, 'Reason:', event.reason);
      isConnecting = false;
      websocket = null;

      // Try to reconnect after 3 seconds
      console.log('🔄 Will retry connection in 3 seconds...');
      setTimeout(() => {
        initWebSocket();
      }, 3000);
    };
  } catch (error) {
    console.error('❌ Failed to create WebSocket:', error);
    isConnecting = false;
  }
}

// Show/hide stop button based on automation state
function updateStopButtonVisibility() {
  const stopBtn = document.getElementById('stopBtn');
  const sendBtn = document.getElementById('sendBtn');

  if (isAutomationRunning) {
    stopBtn.style.display = 'flex';
    sendBtn.style.display = 'none';
  } else {
    stopBtn.style.display = 'none';
    sendBtn.style.display = 'flex';
  }
}

// Send cancel request to server
function stopAutomation() {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    showStatusToast('Not connected to server', 'error');
    return;
  }

  // Send cancel message
  try {
    websocket.send(JSON.stringify({ type: 'cancel' }));
    showStatusToast('Stopping automation...', 'warning');
  } catch (error) {
    console.error('Failed to send cancel request:', error);
    showStatusToast('Failed to stop automation', 'error');
  }
}

// Handle WebSocket messages
function handleWebSocketMessage(data) {
  console.log('📨 handleWebSocketMessage called with type:', data.type);

  switch (data.type) {
    case 'start':
      console.log('🎬 Handling start');
      handleTaskStart(data);
      break;
    case 'automation_started':
      console.log('🤖 Handling automation_started');
      handleAutomationStarted(data);
      break;
    case 'automation_step_realtime':
      console.log('⚡ Handling automation_step_realtime', data);
      handleAutomationStepRealtime(data);
      break;
    case 'automation_step_update':
      console.log('📊 Handling automation_step_update', data);
      handleAutomationStepUpdate(data);
      break;
    case 'automation_step':
      console.log('🔧 Handling automation_step');
      handleAutomationStep(data);
      break;
    case 'step':
      console.log('👣 Handling step');
      handleTaskStep(data);
      break;
    case 'complete':
      console.log('✅ Handling complete');
      handleTaskComplete(data);
      break;
    case 'error':
      console.log('❌ Handling error');
      handleTaskError(data);
      break;
    case 'input_request':
      console.log('🎯 Handling input_request', data);
      handleInputRequest(data);
      break;
    case 'input_timeout':
      console.log('⏱️ Handling input_timeout');
      handleInputTimeout(data);
      break;
    case 'cancelled':
      console.log('🛑 Handling cancelled');
      handleCancelled(data);
      break;
    case 'scheduled_task_started':
      console.log('📅 Handling scheduled_task_started');
      handleTaskStart({
        ...data,
        message: data.message || `Scheduled task '${data.task_name}' starting...`
      });
      break;
    case 'scheduled_task_completed':
      console.log('📅 Handling scheduled_task_completed');
      if (data.status === 'success') {
        handleTaskComplete({
          ...data,
          final_output: data.message || `Scheduled task '${data.task_name}' completed.`
        });
      } else {
        handleTaskError({
          ...data,
          error: data.message || `Scheduled task '${data.task_name}' failed.`
        });
      }
      break;
    case 'task_notification':
      console.log('🔔 Handling task_notification');
      showStatusToast(data.message || 'Task update', data.status === 'success' ? 'success' : 'warning');
      break;
    case 'debug':
      console.log('Debug event:', data);
      break;
  }
}

// Handle task start
function handleTaskStart(data) {
  // Remove typing indicator if exists
  removeTypingIndicator();

  // Reset streaming message for new conversation
  streamingMessageElement = null;

  // Reset task container and steps
  currentTaskSteps = [];
  currentStepContainer = null; // Don't create container until we have automation steps

  // Set automation state to running
  isAutomationRunning = true;
  updateStopButtonVisibility();
}

// Handle automation started
function handleAutomationStarted(data) {
  // Create automation container if it doesn't exist
  if (!currentStepContainer) {
    currentStepContainer = createAutomationContainer();
    const chatArea = document.getElementById('chatArea');
    chatArea.appendChild(currentStepContainer);
  }

  // Auto-scroll to bottom
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Handle real-time automation step (as it happens)
function handleAutomationStepRealtime(data) {
  console.log('🎯 handleAutomationStepRealtime CALLED!', data);

  // Create automation container if it doesn't exist
  if (!currentStepContainer) {
    console.log('📦 Creating automation container...');
    currentStepContainer = createAutomationContainer();
    const chatArea = document.getElementById('chatArea');
    chatArea.appendChild(currentStepContainer);
    console.log('📦 Container added to chatArea');
  }

  // Create initial step element with goal
  console.log('⚡ Creating step element...');
  const step = createRealtimeStepElement(data);
  console.log('⚡ Step element created:', step);

  // Store in array with step number as key for easy updates
  if (!window.automationSteps) {
    window.automationSteps = {};
  }
  window.automationSteps[data.step_number] = step;

  const stepsContainer = currentStepContainer.querySelector('.automation-steps');
  console.log('📂 stepsContainer:', stepsContainer);

  if (stepsContainer) {
    stepsContainer.appendChild(step);
    console.log('✅ Step appended to container!');
  } else {
    console.error('❌ No .automation-steps container found!');
  }

  currentTaskSteps.push(step);

  // Update summary
  updateAutomationSummary();

  // Auto-scroll to bottom
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
  console.log('✅ handleAutomationStepRealtime COMPLETE');
}

// Handle step updates (action, evaluation, memory added incrementally)
function handleAutomationStepUpdate(data) {
  console.log('📊 handleAutomationStepUpdate CALLED!', data);

  if (!window.automationSteps || !window.automationSteps[data.step_number]) {
    console.warn('⚠️ Step not found for update:', data.step_number);
    return;
  }

  console.log('📊 Updating step', data.step_number);

  const stepElement = window.automationSteps[data.step_number];
  const contentDiv = stepElement.querySelector('.automation-step-content');

  // Update action if provided
  if (data.action) {
    const headerDiv = stepElement.querySelector('.automation-step-header');
    const actionSpan = headerDiv.querySelector('.automation-step-action');
    if (actionSpan) {
      actionSpan.textContent = data.action;
    }

    // Update icon
    const iconSpan = headerDiv.querySelector('.automation-step-icon');
    if (iconSpan) {
      iconSpan.textContent = getAutomationStepIcon(data.action);
    }
  }

  // Add evaluation if provided
  if (data.evaluation) {
    let evalDiv = contentDiv.querySelector('.automation-step-eval');
    if (!evalDiv) {
      evalDiv = document.createElement('div');
      evalDiv.className = 'automation-step-eval';
      contentDiv.appendChild(evalDiv);
    }
    evalDiv.textContent = `📊 ${data.evaluation}`;
  }

  // Add memory if provided
  if (data.memory) {
    let memoryDiv = contentDiv.querySelector('.automation-step-memory');
    if (!memoryDiv) {
      memoryDiv = document.createElement('div');
      memoryDiv.className = 'automation-step-memory';
      contentDiv.appendChild(memoryDiv);
    }
    memoryDiv.textContent = `💭 ${data.memory}`;
  }

  // Auto-scroll to bottom
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Handle individual automation step (fallback for post-completion steps)
function handleAutomationStep(data) {
  // Create automation container if it doesn't exist
  if (!currentStepContainer) {
    currentStepContainer = createAutomationContainer();
    const chatArea = document.getElementById('chatArea');
    chatArea.appendChild(currentStepContainer);
  }

  // Create step element
  const step = createAutomationStepElement(data);
  currentTaskSteps.push(step);

  const stepsContainer = currentStepContainer.querySelector('.automation-steps');
  stepsContainer.appendChild(step);

  // Update summary
  updateAutomationSummary();

  // Auto-scroll to bottom
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Handle task step
function handleTaskStep(data) {
  // Handle thinking and final message as streaming text, not steps
  if (data.step_type === 'thinking' || data.step_type === 'agent_finish') {
    handleThinkingStep(data);
    return;
  }

  // For tool calls and results, create the task container and steps
  if (!currentStepContainer) {
    currentStepContainer = createTaskContainer();
    const chatArea = document.getElementById('chatArea');
    chatArea.appendChild(currentStepContainer);
  }

  const step = createStepElement(data);
  currentTaskSteps.push(step);

  const stepsContainer = currentStepContainer.querySelector('.task-steps');
  stepsContainer.appendChild(step);

  // Auto-scroll to bottom
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;

  // Update summary
  updateTaskSummary();
}

// Handle thinking step (streaming text)
let streamingMessageElement = null;

function handleThinkingStep(data) {
  const chatArea = document.getElementById('chatArea');

  // Create or update streaming message
  if (!streamingMessageElement) {
    streamingMessageElement = createStreamingMessage();
    chatArea.appendChild(streamingMessageElement);
  }

  // Update the content with the latest text
  const contentDiv = streamingMessageElement.querySelector('.message-content');
  if (contentDiv) {
    contentDiv.textContent = data.content;
  }

  // Auto-scroll to bottom
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Create a streaming message element
function createStreamingMessage() {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message assistant-message';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  const gradId = 'aiGrad' + Math.random().toString(36).substr(2, 9);
  avatar.innerHTML = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#a855f7;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#ec4899;stop-opacity:1" />
      </linearGradient>
    </defs>
    <circle cx="16" cy="16" r="16" fill="url(#${gradId})"/>
    <path d="M12 8h8v2h-8V8zm0 4h8v2h-8v-2zm0 4h5v2h-5v-2z" fill="white" transform="translate(0, 2)"/>
    <circle cx="10" cy="13" r="1.5" fill="white"/>
    <circle cx="22" cy="13" r="1.5" fill="white"/>
  </svg>`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = '';

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(contentDiv);

  return messageDiv;
}

// Handle task complete
function handleTaskComplete(data) {
  // Reset streaming message
  streamingMessageElement = null;

  if (currentStepContainer) {
    // Check if it's an automation container
    if (currentStepContainer.classList.contains('automation-container')) {
      const statusElement = currentStepContainer.querySelector('.automation-status');
      statusElement.className = 'automation-status success';
      statusElement.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        <span class="automation-title">✅ Automation Completed</span>
      `;

      const summaryElement = currentStepContainer.querySelector('.automation-summary');
      summaryElement.textContent = `Successfully completed ${currentTaskSteps.length} automation steps`;
    } else {
      // Legacy task container
      const summaryElement = currentStepContainer.querySelector('.task-summary');
      summaryElement.innerHTML = `
        <div class="summary-status success">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          Task Completed Successfully
        </div>
        <div class="summary-details">
          ${currentTaskSteps.length} steps executed
        </div>
      `;
    }
  }

  currentStepContainer = null;
  currentTaskSteps = [];

  // Clear automation steps tracking
  if (window.automationSteps) {
    window.automationSteps = {};
  }

  // Reset automation state
  isAutomationRunning = false;
  updateStopButtonVisibility();
}

// Handle task error
function handleTaskError(data) {
  removeTypingIndicator();

  // Reset streaming message
  streamingMessageElement = null;

  if (currentStepContainer) {
    const summaryElement = currentStepContainer.querySelector('.task-summary');
    summaryElement.innerHTML = `
      <div class="summary-status error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        Task Failed
      </div>
      <div class="summary-details error-details">
        ${data.error || 'Unknown error occurred'}
      </div>
    `;
  } else {
    addMessageToChat('assistant', `Error: ${data.error || 'Unknown error occurred'}`);
  }

  currentStepContainer = null;
  currentTaskSteps = [];

  // Reset automation state
  isAutomationRunning = false;
  updateStopButtonVisibility();
}

// Handle input request from server (e.g., ask for credentials)
function handleInputRequest(data) {
  const { request_id, question } = data;

  // Create input modal
  const modal = document.createElement('div');
  modal.className = 'input-modal';
  modal.innerHTML = `
    <div class="input-modal-content">
      <div class="input-modal-header">
        <h3>🤖 Agent Needs Information</h3>
      </div>
      <div class="input-modal-body">
        <p class="input-question">${question}</p>
        <textarea
          id="userInputField"
          class="input-field"
          placeholder="Type your response here..."
          rows="4"
        ></textarea>
      </div>
      <div class="input-modal-footer">
        <button id="submitInputBtn" class="input-submit-btn">Submit</button>
        <button id="cancelInputBtn" class="input-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  // Add to document
  document.body.appendChild(modal);

  // Focus on input field
  setTimeout(() => {
    document.getElementById('userInputField').focus();
  }, 100);

  // Handle submit
  document.getElementById('submitInputBtn').addEventListener('click', () => {
    const userResponse = document.getElementById('userInputField').value.trim();
    sendInputResponse(request_id, userResponse);
    document.body.removeChild(modal);
  });

  // Handle cancel
  document.getElementById('cancelInputBtn').addEventListener('click', () => {
    sendInputResponse(request_id, '');  // Send empty response
    document.body.removeChild(modal);
  });

  // Handle Enter key to submit (Ctrl+Enter for multiline)
  document.getElementById('userInputField').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      document.getElementById('submitInputBtn').click();
    }
  });
}

// Send input response back to server
function sendInputResponse(request_id, response) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({
      type: 'input_response',
      request_id: request_id,
      response: response
    }));
  }
}

// Handle input timeout
function handleInputTimeout(data) {
  showStatusToast('Input request timed out', 'warning');
}

// Handle cancellation acknowledgment
function handleCancelled(data) {
  removeTypingIndicator();

  // Update automation container status if it exists
  if (currentStepContainer && currentStepContainer.classList.contains('automation-container')) {
    const statusElement = currentStepContainer.querySelector('.automation-status');
    statusElement.className = 'automation-status error';
    statusElement.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
      <span class="automation-title">⊗ Automation Cancelled</span>
    `;

    const summaryElement = currentStepContainer.querySelector('.automation-summary');
    summaryElement.textContent = data.message || 'Automation cancelled by user';
  }

  // Reset automation state
  isAutomationRunning = false;
  updateStopButtonVisibility();

  // Show toast notification
  showStatusToast('Automation cancelled', 'warning');
}

// Create automation container (for real-time automation steps)
function createAutomationContainer() {
  const container = document.createElement('div');
  container.className = 'automation-container';
  container.innerHTML = `
    <div class="automation-header">
      <div class="automation-status running">
        <div class="spinner"></div>
        <span class="automation-title">🤖 Browser Automation Running</span>
      </div>
      <div class="automation-summary">Starting automation...</div>
    </div>
    <div class="automation-steps"></div>
  `;
  return container;
}

// Create real-time step element (starts with goal, updates incrementally)
function createRealtimeStepElement(stepData) {
  const step = document.createElement('div');
  step.className = 'automation-step-item';

  step.innerHTML = `
    <div class="automation-step-header">
      <span class="automation-step-icon">⚡</span>
      <span class="automation-step-number">Step ${stepData.step_number}</span>
      <span class="automation-step-action">processing...</span>
    </div>
    <div class="automation-step-content">
      ${stepData.goal ? `<div class="automation-step-goal">🎯 ${stepData.goal}</div>` : ''}
    </div>
  `;

  return step;
}

// Create automation step element (complete step data at once)
function createAutomationStepElement(stepData) {
  const step = document.createElement('div');
  step.className = 'automation-step-item';

  const stepIcon = getAutomationStepIcon(stepData.action);

  step.innerHTML = `
    <div class="automation-step-header">
      <span class="automation-step-icon">${stepIcon}</span>
      <span class="automation-step-number">Step ${stepData.step_number}</span>
      <span class="automation-step-action">${stepData.action || 'processing'}</span>
    </div>
    <div class="automation-step-content">
      ${stepData.goal ? `<div class="automation-step-goal">🎯 ${stepData.goal}</div>` : ''}
      ${stepData.evaluation ? `<div class="automation-step-eval">📊 ${stepData.evaluation}</div>` : ''}
      ${stepData.memory ? `<div class="automation-step-memory">💭 ${stepData.memory}</div>` : ''}
    </div>
  `;

  return step;
}

// Get icon for automation action type
function getAutomationStepIcon(action) {
  const actionLower = (action || '').toLowerCase();

  if (actionLower.includes('click')) return '🖱️';
  if (actionLower.includes('navigate') || actionLower.includes('goto')) return '🔗';
  if (actionLower.includes('type') || actionLower.includes('input')) return '⌨️';
  if (actionLower.includes('scroll')) return '📜';
  if (actionLower.includes('extract') || actionLower.includes('get')) return '📄';
  if (actionLower.includes('wait')) return '⏱️';
  if (actionLower.includes('done') || actionLower.includes('complete')) return '✅';

  return '⚡'; // Default icon
}

// Update automation summary
function updateAutomationSummary() {
  if (!currentStepContainer) return;

  const summaryElement = currentStepContainer.querySelector('.automation-summary');
  summaryElement.textContent = `Completed ${currentTaskSteps.length} automation steps...`;
}

// Create task container (legacy - for non-automation tasks)
function createTaskContainer() {
  const container = document.createElement('div');
  container.className = 'task-container';
  container.innerHTML = `
    <div class="task-summary">
      <div class="summary-status running">
        <div class="spinner"></div>
        Task Running...
      </div>
      <div class="summary-details">Processing your request...</div>
    </div>
    <div class="task-steps"></div>
  `;
  return container;
}

// Create step element
function createStepElement(stepData) {
  const step = document.createElement('div');
  step.className = `step-item step-${stepData.step_type}`;
  step.dataset.stepNumber = stepData.step_number;

  // Get friendly step title
  let stepTitle = stepData.title || 'Processing';
  if (stepData.step_type === 'tool_start') {
    stepTitle = '🔧 Browser Automation Started';
  } else if (stepData.step_type === 'tool_result') {
    stepTitle = '✅ Automation Completed';
  } else if (stepData.step_type === 'automation_step') {
    stepTitle = stepData.action || 'Browser Action';
  }

  const stepHeader = document.createElement('div');
  stepHeader.className = 'step-header';
  stepHeader.innerHTML = `
    <div class="step-icon">${getStepIcon(stepData.step_type)}</div>
    <div class="step-title">
      <span class="step-number">Step ${stepData.step_number}</span>
      <span class="step-name">${stepTitle}</span>
    </div>
    <button class="step-toggle" aria-label="Toggle step details">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
  `;

  const stepContent = document.createElement('div');
  stepContent.className = 'step-content';
  stepContent.innerHTML = formatStepContent(stepData);

  step.appendChild(stepHeader);
  step.appendChild(stepContent);

  // Add toggle functionality
  stepHeader.querySelector('.step-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    step.classList.toggle('expanded');
  });

  // Click header to toggle
  stepHeader.addEventListener('click', () => {
    step.classList.toggle('expanded');
  });

  return step;
}

// Format step content based on step type
function formatStepContent(stepData) {
  let content = '';

  // Tool Start - Show what tool is being called
  if (stepData.step_type === 'tool_start') {
    content += `<div class="content-text">🔧 Executing browser automation...</div>`;

    if (stepData.tool_args && stepData.tool_args.task) {
      content += `
        <div class="content-section">
          <div class="section-title">Task:</div>
          <div class="task-description">${stepData.tool_args.task}</div>
        </div>
      `;
    }
  }

  // Tool Result - Show browser-use agent steps and results
  else if (stepData.step_type === 'tool_result' && stepData.result) {
    const result = stepData.result;

    // Show automation steps if available
    if (result.detailed_steps && result.detailed_steps.length > 0) {
      content += `
        <div class="content-section">
          <div class="section-title">Browser Automation Steps:</div>
          <div class="automation-steps">
      `;

      result.detailed_steps.forEach((step) => {
        content += `
          <div class="automation-step">
            <div class="automation-step-header">
              📍 Step ${step.step}: ${step.action}
            </div>
            ${step.goal ? `<div class="automation-step-goal">🎯 ${step.goal}</div>` : ''}
            ${step.memory ? `<div class="automation-step-detail">💭 ${step.memory}</div>` : ''}
          </div>
        `;
      });

      content += `</div></div>`;
    }

    // Show summary
    content += `<div class="content-section">
      <div class="section-title">Summary:</div>
    `;

    if (result.final_result) {
      content += `<div class="result-item"><strong>✅ Result:</strong> ${result.final_result}</div>`;
    }

    if (result.number_of_steps) {
      content += `<div class="result-item"><strong>Steps Executed:</strong> ${result.number_of_steps}</div>`;
    }

    if (result.total_duration_seconds) {
      content += `<div class="result-item"><strong>Duration:</strong> ${result.total_duration_seconds.toFixed(1)}s</div>`;
    }

    if (result.urls && result.urls.length > 0) {
      content += `
        <div class="result-item">
          <strong>URLs Visited:</strong>
          <ul>${result.urls.slice(0, 3).map(url => `<li>${url}</li>`).join('')}</ul>
          ${result.urls.length > 3 ? `<div class="more-items">...and ${result.urls.length - 3} more</div>` : ''}
        </div>
      `;
    }

    if (result.action_names && result.action_names.length > 0) {
      const uniqueActions = [...new Set(result.action_names)];
      content += `
        <div class="result-item">
          <strong>Actions:</strong> ${uniqueActions.join(', ')}
        </div>
      `;
    }

    if (result.errors && result.errors.length > 0) {
      content += `
        <div class="result-item error">
          <strong>⚠️ Errors:</strong>
          <ul>${result.errors.map(err => `<li>${err}</li>`).join('')}</ul>
        </div>
      `;
    }

    content += `</div>`;
  }

  // Automation Step - Individual browser action
  else if (stepData.step_type === 'automation_step') {
    content += `
      <div class="content-section">
        <div class="automation-step-single">
          ${stepData.action ? `<div class="automation-step-action">🔧 Action: ${stepData.action}</div>` : ''}
          ${stepData.goal ? `<div class="automation-step-goal">🎯 Goal: ${stepData.goal}</div>` : ''}
          ${stepData.url ? `<div class="automation-step-url">🔗 URL: ${stepData.url}</div>` : ''}
          ${stepData.memory ? `<div class="automation-step-memory">💭 Memory: ${stepData.memory}</div>` : ''}
        </div>
      </div>
    `;
  }

  // Other step types
  else {
    content += `<div class="content-text">${stepData.content || ''}</div>`;
  }

  content += `<div class="step-timestamp">${new Date(stepData.timestamp).toLocaleTimeString()}</div>`;

  return content;
}

// Get icon for step type
function getStepIcon(stepType) {
  const icons = {
    agent_start: '🚀',
    thinking: '🤔',
    tool_start: '🔧',
    tool_result: '✅',
    agent_finish: '🎉',
    automation_step: '⚡',
  };
  return icons[stepType] || '📝';
}

// Update task summary
function updateTaskSummary() {
  if (!currentStepContainer) return;

  const summaryElement = currentStepContainer.querySelector('.task-summary .summary-details');
  summaryElement.textContent = `${currentTaskSteps.length} steps completed...`;
}

// Initialize chat functionality
function initChat() {
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');

  // Send message function
  async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    // Add user message to chat
    addMessageToChat('user', message);

    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Show typing indicator
    showTypingIndicator();

    // Check WebSocket connection
    if (!websocket) {
      removeTypingIndicator();
      console.log('WebSocket is null, initializing...');
      addMessageToChat('assistant', 'Connecting to server... Please wait and try again.');
      initWebSocket();
      return;
    }

    // Log WebSocket state for debugging
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    console.log(`WebSocket state: ${states[websocket.readyState]} (${websocket.readyState})`);

    if (websocket.readyState === WebSocket.CONNECTING) {
      removeTypingIndicator();
      addMessageToChat('assistant', 'Still connecting to server... Please wait a moment and try again.');
      return;
    }

    if (websocket.readyState !== WebSocket.OPEN) {
      removeTypingIndicator();
      console.error('WebSocket not open. State:', states[websocket.readyState]);
      addMessageToChat('assistant', 'Connection lost. Reconnecting... Please try again in a moment.');
      initWebSocket();
      return;
    }

    try {
      // Send message via WebSocket
      console.log('Sending message via WebSocket:', message);
      websocket.send(JSON.stringify({ message: message }));
      console.log('Message sent successfully');
    } catch (error) {
      console.error('Failed to send message:', error);
      removeTypingIndicator();
      addMessageToChat('assistant', 'Failed to send message. Please try again.');
    }
  }

  // Send button click
  sendBtn.addEventListener('click', sendMessage);

  // Stop button click
  stopBtn.addEventListener('click', stopAutomation);

  // Enter key to send
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
  });

}

// ============================================================================
// Voice Input - Inline (Direct Web Speech API in Sidebar)
// ============================================================================

// Persistent recognition instance — reused across clicks to avoid hardware
// re-acquisition on every press (prevents transient not-allowed errors).
let voiceRecognition = null;
let isVoiceRecording = false;
let currentVoiceTranscript = '';
let voiceAutoSendTimer = null;
let _permissionRequestInProgress = false; // guard against concurrent popups

function initInlineVoice() {
  const voiceBtn = document.getElementById('voiceBtn');
  const voiceCancelBtn = document.getElementById('voiceCancelBtn');
  const micDeniedDismiss = document.getElementById('micDeniedDismiss');

  // Hide voice button if browser doesn't support Speech Recognition
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    if (voiceBtn) voiceBtn.style.display = 'none';
    return;
  }

  if (voiceBtn) {
    voiceBtn.addEventListener('click', toggleInlineVoice);
  }

  if (voiceCancelBtn) {
    voiceCancelBtn.addEventListener('click', cancelInlineRecording);
  }

  // Dismiss button hides the banner (button stays blocked until permission changes)
  if (micDeniedDismiss) {
    micDeniedDismiss.addEventListener('click', hideMicDeniedBanner);
  }

  // Check initial permission state and attach a live change listener so the UI
  // updates automatically if the user changes Chrome settings while open.
  navigator.permissions.query({ name: 'microphone' }).then((permStatus) => {
    console.log('[MIC] Initial permission state:', permStatus.state);
    if (permStatus.state === 'denied') {
      setMicDeniedState(true);
    }
    permStatus.onchange = () => {
      console.log('[MIC] Permission state changed to:', permStatus.state);
      if (permStatus.state === 'granted') {
        chrome.storage.local.set({ microphonePermissionGranted: true });
        setMicDeniedState(false);
        showStatusToast('Microphone access restored — voice input is ready.', 'success');
      } else if (permStatus.state === 'denied') {
        chrome.storage.local.remove('microphonePermissionGranted');
        setMicDeniedState(true);
      }
    };
  }).catch(() => {
    // Permissions API unavailable — silent, existing storage-flag fallback handles it
  });
}

async function toggleInlineVoice() {
  if (isVoiceRecording) {
    stopInlineRecording();
  } else {
    await startInlineRecording();
  }
}

// Query the real browser-level mic permission state.
// Returns 'granted', 'prompt', or 'denied'.
async function queryMicPermission() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    console.log('[MIC] Permission state:', result.state);
    return result.state;
  } catch (e) {
    // Permissions API not available — fall back to storage flag
    console.warn('[MIC] Permissions API unavailable, falling back to storage flag');
    return null;
  }
}

function requestMicPermissionViaPopup() {
  if (_permissionRequestInProgress) {
    console.log('[MIC] Popup already open, skipping duplicate request');
    return Promise.resolve(false);
  }
  _permissionRequestInProgress = true;

  return new Promise((resolve) => {
    const width = 480;
    const height = 420;
    const left = Math.round((screen.width - width) / 2);
    const top = Math.round((screen.height - height) / 2);

    console.log('[MIC] Popup opened');
    chrome.windows.create({
      url: chrome.runtime.getURL('permission.html'),
      type: 'popup',
      width, height, left, top
    }, (win) => {
      const checkClosed = setInterval(() => {
        chrome.windows.get(win.id, () => {
          if (chrome.runtime.lastError) {
            clearInterval(checkClosed);
            _permissionRequestInProgress = false;
            chrome.storage.local.get(['microphonePermissionGranted'], (result) => {
              const granted = !!result.microphonePermissionGranted;
              console.log('[MIC] Popup closed. granted=', granted);
              resolve(granted);
            });
          }
        });
      }, 500);
    });
  });
}

// Build (or reuse) the persistent SpeechRecognition instance.
function _ensureRecognitionInstance() {
  if (voiceRecognition) return; // reuse existing

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  voiceRecognition = new SpeechRecognition();
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = 'en-US';
  console.log('[MIC] Starting SpeechRecognition (reuse=false, new instance)');

  voiceRecognition.onstart = () => {
    console.log('[MIC] Recognition active');
    isVoiceRecording = true;
    setVoiceRecordingState(true);
  };

  voiceRecognition.onresult = (event) => {
    let finalText = '';
    let interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += t + ' ';
      } else {
        interimText += t;
      }
    }
    if (finalText) {
      currentVoiceTranscript += finalText;
      console.log('[MIC] Interim:', currentVoiceTranscript.length, 'chars');
    }
    updateVoiceLiveText(currentVoiceTranscript, interimText);
  };

  voiceRecognition.onerror = async (event) => {
    console.log('[MIC] onerror: code=' + event.error);
    isVoiceRecording = false;
    setVoiceRecordingState(false);
    hideVoiceTranscriptBar();

    if (event.error === 'not-allowed') {
      // Check REAL permission state — do not clear flag on transient errors.
      const realState = await queryMicPermission();
      console.log('[MIC] onerror: real-perm=' + realState);

      if (realState === 'denied') {
        // Real permanent denial — block button and show settings instructions.
        chrome.storage.local.remove('microphonePermissionGranted');
        voiceRecognition = null;
        setMicDeniedState(true);
      } else {
        // Transient error (audio hardware busy, context switch, etc.) —
        // do NOT clear the flag. The user did not deny anything.
        showStatusToast('Mic busy — click the mic button to try again.', 'warning');
        // Discard instance so a fresh one is built next click.
        voiceRecognition = null;
      }
    } else if (event.error === 'audio-capture') {
      showStatusToast('No microphone found. Please connect a microphone.', 'error');
      voiceRecognition = null;
    } else if (event.error === 'no-speech') {
      showStatusToast('No speech detected. Try again.', 'warning');
      // Don't discard instance for no-speech — just reset for next click.
    } else {
      showStatusToast('Voice error: ' + event.error, 'error');
      voiceRecognition = null;
    }
  };

  voiceRecognition.onend = () => {
    console.log('[MIC] Final transcript: "' + currentVoiceTranscript.trim() + '"');
    isVoiceRecording = false;
    setVoiceRecordingState(false);
    hideVoiceTranscriptBar();

    const transcript = currentVoiceTranscript.trim();
    if (transcript) {
      const messageInput = document.getElementById('messageInput');
      messageInput.value = transcript;
      messageInput.style.height = 'auto';
      messageInput.style.height = messageInput.scrollHeight + 'px';

      showStatusToast('Voice captured — sending in 1.5s…', 'info');

      voiceAutoSendTimer = setTimeout(() => {
        const currentValue = document.getElementById('messageInput').value.trim();
        if (currentValue && !isAutomationRunning) {
          document.getElementById('sendBtn').click();
        }
      }, 1500);
    }
  };
}

async function startInlineRecording() {
  console.log('[MIC] User clicked mic. isVoiceRecording=' + isVoiceRecording);

  // Block if automation is already running
  if (isAutomationRunning) {
    showStatusToast('A task is already running. Wait for it to finish.', 'warning');
    return;
  }

  // Clear any pending auto-send timer from a previous recording
  if (voiceAutoSendTimer) {
    clearTimeout(voiceAutoSendTimer);
    voiceAutoSendTimer = null;
  }

  // ── Permission check: use real Permissions API, fall back to storage flag ──
  const realState = await queryMicPermission();

  if (realState === 'denied') {
    // Browser has permanently denied mic — popup will always fail, don't open it.
    console.log('[MIC] Permanently blocked — guiding user to Chrome settings');
    setMicDeniedState(true);
    return;
  }

  if (realState === 'granted') {
    // Real grant confirmed — no popup needed, ensure storage flag is set.
    await chrome.storage.local.set({ microphonePermissionGranted: true });
  } else {
    // 'prompt' state, or Permissions API unavailable — check storage flag.
    const stored = await chrome.storage.local.get(['microphonePermissionGranted']);
    if (!stored.microphonePermissionGranted) {
      // Need to ask user via popup.
      console.log('[MIC] Popup: opening (reason=prompt)');
      const granted = await requestMicPermissionViaPopup();
      if (!granted) return; // user denied or closed popup
    }
  }

  // ── Start recognition ───────────────────────────────────────────────────────
  currentVoiceTranscript = '';
  _ensureRecognitionInstance();

  try {
    console.log('[MIC] Starting SpeechRecognition (reuse=' + (voiceRecognition !== null) + ')');
    voiceRecognition.start();
  } catch (error) {
    console.error('❌ Failed to start voice recognition:', error);
    // "already started" race — discard and let user retry.
    voiceRecognition = null;
    showStatusToast('Could not start voice input. Try again.', 'error');
    isVoiceRecording = false;
    setVoiceRecordingState(false);
  }
}

function stopInlineRecording() {
  if (voiceRecognition && isVoiceRecording) {
    voiceRecognition.stop();
  }
}

function cancelInlineRecording() {
  if (voiceAutoSendTimer) {
    clearTimeout(voiceAutoSendTimer);
    voiceAutoSendTimer = null;
  }
  if (voiceRecognition) {
    voiceRecognition.abort();
  }
  isVoiceRecording = false;
  currentVoiceTranscript = '';
  setVoiceRecordingState(false);
  hideVoiceTranscriptBar();
  // Clear textarea if it was populated by voice
  const messageInput = document.getElementById('messageInput');
  if (messageInput) {
    messageInput.value = '';
    messageInput.style.height = 'auto';
  }
}

function setVoiceRecordingState(recording) {
  const voiceBtn = document.getElementById('voiceBtn');
  if (!voiceBtn) return;
  if (recording) {
    voiceBtn.classList.add('recording');
    voiceBtn.setAttribute('aria-label', 'Click to stop recording');
    showVoiceTranscriptBar();
  } else {
    voiceBtn.classList.remove('recording');
    voiceBtn.setAttribute('aria-label', 'Toggle voice input');
  }
}

// ── Mic denied state helpers ─────────────────────────────────────────────────

function setMicDeniedState(denied) {
  const voiceBtn = document.getElementById('voiceBtn');
  if (!voiceBtn) return;
  if (denied) {
    voiceBtn.classList.add('mic-denied');
    voiceBtn.setAttribute('title', 'Microphone access blocked — see instructions below');
    voiceBtn.setAttribute('aria-label', 'Microphone access blocked');
    showMicDeniedBanner();
  } else {
    voiceBtn.classList.remove('mic-denied');
    voiceBtn.setAttribute('title', 'Click to use voice input');
    voiceBtn.setAttribute('aria-label', 'Toggle voice input');
    hideMicDeniedBanner();
  }
}

function showMicDeniedBanner() {
  const banner = document.getElementById('micDeniedBanner');
  if (banner) banner.style.display = 'flex';
}

function hideMicDeniedBanner() {
  const banner = document.getElementById('micDeniedBanner');
  if (banner) banner.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────

function showVoiceTranscriptBar() {
  const bar = document.getElementById('voiceTranscriptBar');
  if (bar) {
    bar.style.display = 'flex';
    updateVoiceLiveText('', '');
  }
}

function hideVoiceTranscriptBar() {
  const bar = document.getElementById('voiceTranscriptBar');
  if (bar) bar.style.display = 'none';
  const liveText = document.getElementById('voiceLiveText');
  if (liveText) liveText.textContent = '';
}

function updateVoiceLiveText(finalText, interimText) {
  const el = document.getElementById('voiceLiveText');
  if (!el) return;
  el.textContent = (finalText + interimText).trim();
}

// Add message to chat
function addMessageToChat(role, content) {
  const chatArea = document.getElementById('chatArea');

  // Remove welcome message if it exists
  const welcomeMsg = chatArea.querySelector('.welcome-message');
  if (welcomeMsg) {
    welcomeMsg.remove();
  }

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}-message`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  const gradId = (role === 'user' ? 'userGrad' : 'aiGrad') + Math.random().toString(36).substr(2, 9);
  avatar.innerHTML = role === 'user' ?
    `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
           <stop offset="0%" style="stop-color:#06b6d4;stop-opacity:1" />
           <stop offset="100%" style="stop-color:#3b82f6;stop-opacity:1" />
         </linearGradient>
       </defs>
       <circle cx="16" cy="16" r="16" fill="url(#${gradId})"/>
       <path d="M16 16c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="white" transform="translate(0, 2)"/>
     </svg>` :
    `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
           <stop offset="0%" style="stop-color:#a855f7;stop-opacity:1" />
           <stop offset="100%" style="stop-color:#ec4899;stop-opacity:1" />
         </linearGradient>
       </defs>
       <circle cx="16" cy="16" r="16" fill="url(#${gradId})"/>
       <path d="M12 8h8v2h-8V8zm0 4h8v2h-8v-2zm0 4h5v2h-5v-2z" fill="white" transform="translate(0, 2)"/>
       <circle cx="10" cy="13" r="1.5" fill="white"/>
       <circle cx="22" cy="13" r="1.5" fill="white"/>
     </svg>`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = content;

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(contentDiv);
  chatArea.appendChild(messageDiv);

  // Scroll to bottom
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Show typing indicator
function showTypingIndicator() {
  const chatArea = document.getElementById('chatArea');
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.id = 'typingIndicator';
  indicator.innerHTML = `
    <div class="typing-dots">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  chatArea.appendChild(indicator);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Remove typing indicator
function removeTypingIndicator() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) {
    indicator.remove();
  }
}

// Show status toast
function showStatusToast(message, type = 'info') {
  const toast = document.getElementById('statusToast');
  toast.textContent = message;
  toast.className = `status-toast ${type} show`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Initialize on page load
initSidebar();
