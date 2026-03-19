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
    case 'voice_command':
      console.log('🎙️ Handling voice_command from website');
      handleVoiceCommand(data);
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
    case 'plan_limit':
      console.log('Plan limit reached:', data);
      handlePlanLimit(data);
      break;
    case 'image_processing':
      console.log('Image processing:', data);
      showStatusToast(data.message || 'Processing image...', 'info');
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

  // Speak the completion result
  const spokenMessage = data.final_output || data.message || 'Your task is complete.';
  speakText(spokenMessage);
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

  // Speak the error message
  const spokenMessage = data.error || 'An error occurred during the task.';
  speakText(spokenMessage);
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

  // Speak the actual cancellation message from the backend
  const spokenMessage = data.message || 'The task has been cancelled.';
  speakText(spokenMessage);
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

// Check for pending re-run task from dashboard (backend relay)
let _pendingRerunChecking = false;
async function checkPendingRerun(messageInput, sendMessageFn) {
  if (_pendingRerunChecking || isAutomationRunning) return;
  _pendingRerunChecking = true;
  try {
    const user = await chrome.storage.local.get(['userEmail']);
    if (!user.userEmail) return;
    const resp = await fetch(`${API_BASE_URL}/api/pending-rerun?email=${encodeURIComponent(user.userEmail)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.pending && data.task_description) {
      // Populate input and auto-send
      messageInput.value = data.task_description;
      messageInput.style.height = 'auto';
      messageInput.style.height = messageInput.scrollHeight + 'px';
      // Auto-send after a brief delay so WebSocket is ready
      setTimeout(() => {
        if (messageInput.value.trim()) {
          sendMessageFn();
        }
      }, 500);
    }
  } catch (e) {
    // Silently ignore — network errors are expected when server is down
  } finally {
    _pendingRerunChecking = false;
  }
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

    // Add user message to chat (with image thumbnail if attached)
    const attachedImage = _getAttachedImage();
    addMessageToChat('user', message, attachedImage ? attachedImage.thumbnail : null);

    // Clear input and image
    messageInput.value = '';
    messageInput.style.height = 'auto';
    const imageData = attachedImage ? attachedImage.full : null;
    _clearAttachedImage();

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
      // Get the active tab URL and title for "this page" context
      let currentTabUrl = '';
      let currentTabTitle = '';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          currentTabUrl = tab.url;
          currentTabTitle = tab.title || '';
        }
      } catch (e) {
        console.log('Could not get active tab:', e);
      }

      // Build payload — include image and current tab info if available
      const payload = { message: message };
      if (currentTabUrl) {
        payload.current_tab_url = currentTabUrl;
        payload.current_tab_title = currentTabTitle;
      }
      if (imageData) {
        payload.image = imageData;
        console.log('Sending message with image attachment');
      }

      // Send message via WebSocket
      console.log('Sending message via WebSocket:', message);
      websocket.send(JSON.stringify(payload));
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

  // Check for pending re-run tasks from dashboard (via backend relay)
  checkPendingRerun(messageInput, sendMessage);

  // Poll for pending re-run tasks periodically and on sidebar focus
  setInterval(() => checkPendingRerun(messageInput, sendMessage), 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkPendingRerun(messageInput, sendMessage);
    }
  });

}

// Add message to chat (optional imageSrc for image thumbnail display)
function addMessageToChat(role, content, imageSrc) {
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

  // Show image thumbnail if provided
  if (imageSrc) {
    const img = document.createElement('img');
    img.src = imageSrc;
    img.className = 'message-image-thumb';
    img.alt = 'Attached image';
    img.addEventListener('click', () => {
      const lightbox = document.createElement('div');
      lightbox.className = 'image-lightbox';
      lightbox.innerHTML = `<img src="${imageSrc}" alt="Full image">`;
      lightbox.addEventListener('click', () => lightbox.remove());
      document.body.appendChild(lightbox);
    });
    contentDiv.appendChild(img);
  }

  const textNode = document.createElement('div');
  textNode.textContent = content;
  contentDiv.appendChild(textNode);

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

// ============================================================================
// Voice Command Handler (from Website Voice Assistant)
// ============================================================================

function handleVoiceCommand(data) {
  const command = data.message;
  if (!command) return;

  // Display the voice command as a user message in the chat
  addMessageToChat('user', command);
  showTypingIndicator();

  // Set automation state
  isAutomationRunning = true;
  updateStopButtonVisibility();

  // Send the command to the server as a regular chat message
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ message: command }));
  } else {
    showStatusToast('Not connected to server', 'error');
    isAutomationRunning = false;
    updateStopButtonVisibility();
  }
}

// ============================================================================
// Text-to-Speech Module
// ============================================================================

let currentUtterance = null;
let isSpeaking = false;

function initTTS() {
  // Load voices
  if (window.speechSynthesis) {
    if (speechSynthesis.getVoices().length === 0) {
      speechSynthesis.addEventListener('voiceschanged', () => {
        console.log('TTS voices loaded:', speechSynthesis.getVoices().length);
      });
    }
  }

  // Bind speaker toggle button
  const speakerBtn = document.getElementById('speakerToggleBtn');
  if (speakerBtn) {
    speakerBtn.addEventListener('click', toggleAudio);
  }
}

function speakText(text) {
  if (!window.speechSynthesis || !text) return;

  // Cancel any current speech first
  speechSynthesis.cancel();

  // Chrome has a known bug where speak() silently fails if called
  // immediately after cancel(). A short delay fixes this reliably.
  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1;   // Slightly slower for natural cadence
    utterance.pitch = 1.05;  // Slightly higher pitch for female voice
    utterance.volume = 1.0;

    // Select a high-quality female English voice with ranked fallback chain
    let voices = speechSynthesis.getVoices();

    // If voices aren't loaded yet, wait for them and retry
    if (voices.length === 0) {
      speechSynthesis.addEventListener('voiceschanged', function onVoices() {
        speechSynthesis.removeEventListener('voiceschanged', onVoices);
        speakText(text); // retry once voices are loaded
      });
      return;
    }

    // Female voice preference list — ranked from most natural to acceptable fallback
    const femaleVoicePrefs = [
      'Google UK English Female',          // Chrome — natural and clear
      'Google US English',                 // Chrome — female variant
      'Microsoft Zira',                    // Edge/Windows — high-quality female
      'Microsoft Jenny Online (Natural)',  // Edge — neural female
      'Microsoft Aria Online (Natural)',   // Edge — neural female
      'Samantha',                          // macOS — default female
      'Karen',                             // macOS — Australian female
      'Victoria',                          // macOS — US female
    ];

    let selectedVoice = null;

    // Try exact name matches first (highest quality)
    for (const pref of femaleVoicePrefs) {
      selectedVoice = voices.find(v => v.name.includes(pref));
      if (selectedVoice) break;
    }

    // Fallback: any English female-sounding voice (names often contain Female/Woman)
    if (!selectedVoice) {
      selectedVoice = voices.find(v =>
        v.lang.startsWith('en') && /female|woman|zira|jenny|aria|samantha|karen/i.test(v.name)
      );
    }

    // Last resort: any English voice
    if (!selectedVoice) {
      selectedVoice = voices.find(v => v.lang.startsWith('en'));
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    utterance.onstart = () => {
      isSpeaking = true;
      updateSpeakerIcon();
    };

    utterance.onend = () => {
      isSpeaking = false;
      updateSpeakerIcon();
    };

    utterance.onerror = (e) => {
      console.error('TTS error:', e.error);
      isSpeaking = false;
      updateSpeakerIcon();
    };

    currentUtterance = utterance;
    speechSynthesis.speak(utterance);
  }, 150); // 150ms delay after cancel() to avoid Chrome bug
}

function stopSpeaking() {
  if (window.speechSynthesis) {
    speechSynthesis.cancel();
  }
  isSpeaking = false;
  updateSpeakerIcon();
}

function toggleAudio() {
  // Clicking the speaker while audio is playing stops it and hides the icon
  stopSpeaking();
}

function updateSpeakerIcon() {
  const btn = document.getElementById('speakerToggleBtn');
  if (!btn) return;

  if (isSpeaking) {
    // Show the speaker icon only while audio is playing
    btn.style.display = 'flex';
    btn.classList.add('speaking');
  } else {
    // Hide the speaker icon when audio is not playing
    btn.style.display = 'none';
    btn.classList.remove('speaking');
  }
}

// ========================================
// IMAGE ATTACH MODULE
// ========================================

let _attachedImageData = null; // { full: dataURI, thumbnail: dataURI }

function _getAttachedImage() {
  return _attachedImageData;
}

function _clearAttachedImage() {
  _attachedImageData = null;
  const preview = document.getElementById('imagePreview');
  const btn = document.getElementById('imageAttachBtn');
  if (preview) preview.style.display = 'none';
  if (btn) btn.classList.remove('has-image');
}

function _showImagePreview(dataURI) {
  const preview = document.getElementById('imagePreview');
  const img = document.getElementById('imagePreviewImg');
  const btn = document.getElementById('imageAttachBtn');
  if (preview && img) {
    img.src = dataURI;
    preview.style.display = 'flex';
  }
  if (btn) btn.classList.add('has-image');
}

function _handleImageFile(file) {
  if (!file) return;

  // Validate type
  const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    showStatusToast('Unsupported image format. Use PNG, JPEG, or WebP.', 'error');
    return;
  }

  // Validate size (5MB max)
  if (file.size > 5 * 1024 * 1024) {
    showStatusToast('Image too large. Maximum size is 5MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURI = e.target.result;
    _attachedImageData = { full: dataURI, thumbnail: dataURI };
    _showImagePreview(dataURI);
  };
  reader.readAsDataURL(file);
}

function initImageAttach() {
  const attachBtn = document.getElementById('imageAttachBtn');
  const fileInput = document.getElementById('imageFileInput');
  const removeBtn = document.getElementById('removeImageBtn');
  const chatArea = document.getElementById('chatArea');

  if (!attachBtn || !fileInput) return;

  // Click attach button -> open file picker
  attachBtn.addEventListener('click', () => fileInput.click());

  // File selected
  fileInput.addEventListener('change', (e) => {
    _handleImageFile(e.target.files[0]);
    fileInput.value = ''; // Reset so same file can be re-selected
  });

  // Remove image
  if (removeBtn) {
    removeBtn.addEventListener('click', _clearAttachedImage);
  }

  // Paste from clipboard (Ctrl+V)
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        _handleImageFile(item.getAsFile());
        return;
      }
    }
  });

  // Drag and drop
  if (chatArea) {
    chatArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatArea.style.outline = '2px dashed var(--color-primary)';
    });
    chatArea.addEventListener('dragleave', () => {
      chatArea.style.outline = '';
    });
    chatArea.addEventListener('drop', (e) => {
      e.preventDefault();
      chatArea.style.outline = '';
      const file = e.dataTransfer?.files[0];
      if (file && file.type.startsWith('image/')) {
        _handleImageFile(file);
      }
    });
  }
}

// ========================================
// TEMPLATES MODULE
// ========================================

const AUTOMATION_TEMPLATES = [
  { icon: "&#x2709;", name: "Check my emails", desc: "Open Gmail and summarize unread", prompt: "Open Gmail and summarize my unread emails", premium: false },
  { icon: "&#x1F4F0;", name: "What's trending?", desc: "See trending topics on X/Twitter", prompt: "Open Twitter and tell me what's trending right now", premium: false },
  { icon: "&#x1F4C5;", name: "Check my calendar", desc: "Open Google Calendar events", prompt: "Open Google Calendar and show me today's events", premium: false },
  { icon: "&#x1F4DD;", name: "Summarize this page", desc: "Extract and summarize page content", prompt: "Summarize the content of the current page", premium: false },
  { icon: "&#x2708;", name: "Find cheapest flight", desc: "Search Google Flights for deals", prompt: "Open Google Flights and find the cheapest flight", premium: true },
  { icon: "&#x1F4E6;", name: "Track package", desc: "Open tracking page for your order", prompt: "Track my package", premium: true },
  { icon: "&#x1F6D2;", name: "Compare prices", desc: "Find product across shopping sites", prompt: "Compare prices for this product across Amazon and other sites", premium: true },
  { icon: "&#x1F4CA;", name: "Stock prices", desc: "Check current stock market prices", prompt: "Open Google Finance and show me today's market summary", premium: false },
];

function initTemplates() {
  const templatesBtn = document.getElementById('templatesBtn');
  const templatesPanel = document.getElementById('templatesPanel');
  if (!templatesBtn || !templatesPanel) return;

  // Build the templates panel content
  function renderTemplates() {
    let html = '<div class="templates-panel-title">Quick Actions</div>';
    AUTOMATION_TEMPLATES.forEach((t, i) => {
      html += `
        <div class="template-item" data-index="${i}">
          <span class="template-icon">${t.icon}</span>
          <div class="template-info">
            <div class="template-name">${t.name}</div>
            <div class="template-desc">${t.desc}</div>
          </div>
          ${t.premium ? '<span class="template-badge">PRO</span>' : ''}
        </div>`;
    });
    templatesPanel.innerHTML = html;

    // Attach click handlers
    templatesPanel.querySelectorAll('.template-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        const template = AUTOMATION_TEMPLATES[idx];
        const input = document.getElementById('messageInput');
        if (input) {
          input.value = template.prompt;
          input.focus();
          input.style.height = 'auto';
          input.style.height = input.scrollHeight + 'px';
        }
        templatesPanel.style.display = 'none';
      });
    });
  }

  renderTemplates();

  // Toggle panel
  templatesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = templatesPanel.style.display !== 'none';
    templatesPanel.style.display = isVisible ? 'none' : 'block';
  });

  // Close panel on outside click
  document.addEventListener('click', (e) => {
    if (!templatesPanel.contains(e.target) && e.target !== templatesBtn) {
      templatesPanel.style.display = 'none';
    }
  });
}

// ========================================
// PLAN BADGE MODULE
// ========================================

async function initPlanBadge() {
  try {
    const user = await chrome.storage.local.get(['userEmail']);
    if (!user.userEmail) return;

    const response = await fetch(`${API_BASE_URL}/api/plan-info?email=${encodeURIComponent(user.userEmail)}`);
    if (!response.ok) return;

    const planInfo = await response.json();
    const header = document.querySelector('.panel-header');
    if (!header) return;

    // Remove old badge if exists
    const oldBadge = header.querySelector('.plan-badge');
    if (oldBadge) oldBadge.remove();

    const badge = document.createElement('span');
    badge.className = `plan-badge ${planInfo.plan || 'free'}`;
    badge.textContent = (planInfo.display_name || 'Free').toUpperCase();

    const title = header.querySelector('.panel-title');
    if (title) {
      title.appendChild(badge);
    }
  } catch (e) {
    console.log('Could not load plan badge:', e.message);
  }
}

// ========================================
// PLAN LIMIT HANDLER
// ========================================

function handlePlanLimit(data) {
  removeTypingIndicator();

  const chatArea = document.getElementById('chatArea');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant-message';

  msgDiv.innerHTML = `
    <div class="message-content">
      <div class="plan-limit-message">
        <strong>${data.message || 'Daily task limit reached.'}</strong>
        <a class="upgrade-link" href="${data.upgrade_url || '#'}" target="_blank">Upgrade your plan</a>
      </div>
    </div>
  `;

  chatArea.appendChild(msgDiv);
  chatArea.scrollTop = chatArea.scrollHeight;

  // Reset automation state
  isAutomationRunning = false;
  updateStopButtonVisibility();
}

// ========================================
// ONBOARDING TOUR (Extension)
// ========================================

function initOnboardingTour() {
  const tourKey = 'genipilot-tour-completed';
  if (localStorage.getItem(tourKey)) return;

  const steps = [
    { target: '#messageInput', text: 'Type any automation task here — like "open YouTube and play a song"', position: 'top' },
    { target: '#imageAttachBtn', text: 'Attach images for visual tasks (Pro plan)', position: 'top' },
    { target: '#templatesBtn', text: 'Quick actions — common automations with one click', position: 'top' },
    { target: '#sendBtn', text: 'Hit send or press Enter to start the automation. Audio responses will play through the speaker button when available.', position: 'top' },
  ];

  let currentStep = 0;

  // Track highlighted elements so we can reset them
  let highlightedEls = [];

  function cleanupTour() {
    document.querySelectorAll('.tour-overlay, .tour-tooltip').forEach(el => el.remove());
    highlightedEls.forEach(el => { el.style.zIndex = ''; });
    highlightedEls = [];
  }

  function showStep(idx) {
    cleanupTour();

    if (idx >= steps.length) {
      localStorage.setItem(tourKey, 'true');
      return;
    }

    const step = steps[idx];
    const target = document.querySelector(step.target);
    const rect = target ? target.getBoundingClientRect() : null;

    // Skip if target missing or hidden (zero dimensions)
    if (!target || (rect.width === 0 && rect.height === 0)) {
      showStep(idx + 1);
      return;
    }

    // Dark overlay
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;';
    overlay.addEventListener('click', () => { showStep(idx + 1); });

    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tour-tooltip';
    tooltip.style.cssText = `
      position:fixed;z-index:10000;background:white;color:#1a1a1a;padding:16px 20px;
      border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.2);max-width:260px;
      font-family:var(--font-body);font-size:14px;line-height:1.5;
    `;

    // Position tooltip above the target, clamped within viewport
    const tooltipLeft = Math.min(Math.max(10, rect.left), window.innerWidth - 270);
    tooltip.style.left = tooltipLeft + 'px';
    tooltip.style.bottom = (window.innerHeight - rect.top + 12) + 'px';

    const isLast = idx === steps.length - 1;
    tooltip.innerHTML = `
      <div style="margin-bottom:10px">${step.text}</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="color:#718096;font-size:12px">${idx + 1}/${steps.length}</span>
        <button style="background:#016B61;color:white;border:none;padding:6px 16px;border-radius:8px;cursor:pointer;font-weight:600">
          ${isLast ? 'Done' : 'Next'}
        </button>
      </div>
    `;

    tooltip.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isLast) {
        cleanupTour();
        localStorage.setItem(tourKey, 'true');
      } else {
        showStep(idx + 1);
      }
    });

    // Highlight target
    target.style.position = 'relative';
    target.style.zIndex = '10000';
    highlightedEls.push(target);

    document.body.appendChild(overlay);
    document.body.appendChild(tooltip);
  }

  // Delay tour start so user sees the interface first
  setTimeout(() => showStep(0), 1500);
}

// ========================================
// INITIALIZATION — Add new modules
// ========================================

// Initialize on page load
initTTS();
initSidebar();
initImageAttach();
initTemplates();
initPlanBadge();
initOnboardingTour();
