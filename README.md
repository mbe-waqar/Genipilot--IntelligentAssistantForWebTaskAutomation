# FYP Auto - Browser Automation Agent with Orchestrator Pattern

An intelligent browser automation system powered by OpenAI Agent SDK and browser-use, featuring real-time streaming and step-by-step execution visualization.

## Features

- 🤖 **Orchestrator Agent Pattern**: Uses OpenAI Agent SDK for intelligent task coordination
- 🌐 **Browser Automation**: Powered by browser-use for reliable web automation
- ⚡ **Real-time Streaming**: WebSocket-based streaming for live progress updates
- 📊 **Step-by-step Visualization**: See exactly what the agent is doing at each step
- 🔍 **Detailed History Tracking**: Complete execution history with URLs, actions, and results
- 🎯 **Browser Extension Interface**: Chrome extension with beautiful UI
- 🔐 **Authentication System**: Secure user authentication with MongoDB

## Architecture

### Orchestrator Agent Structure

The system uses a two-level agent architecture:

1. **Orchestrator Agent** (OpenAI Agent SDK)
   - Handles user communication
   - Decides when to use automation tools
   - Provides intelligent responses

2. **Browser Automation Agent** (browser-use)
   - Executes browser automation tasks
   - Navigates websites, clicks, fills forms
   - Extracts information

### How It Works

```
User Input → Orchestrator Agent → Automation Tool → Browser Agent → Browser Actions
                ↓                                                           ↓
           Real-time Streaming ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←
```

## Installation

### Prerequisites

- Python 3.11+
- Node.js (for extension development)
- MongoDB
- Chrome/Chromium browser
- OpenAI API Key

### Step 1: Clone and Setup

```bash
cd FYPAuto
```

### Step 2: Install Dependencies

Using uv (recommended):
```bash
uv sync
```

Or using pip:
```bash
pip install openai-agents
pip install -r requirements.txt
```

**Important**: Make sure to install `openai-agents` (not just `agents`):
```bash
pip install openai-agents
```

### Step 3: Configure Environment

Create a `.env` file:

```env
# OpenAI API
OPENAI_API_KEY=your_openai_api_key_here

# MongoDB
MONGODB_URL=mongodb://localhost:27017/
DATABASE_NAME=fypauto

# Session
SECRET_KEY=your_secret_key_here

# Email (optional for verification)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_app_password

# Google OAuth (optional)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

### Step 4: Start Chrome with Remote Debugging

Windows:
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
```

Mac:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Linux:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

### Step 5: Start the Servers

Terminal 1 - Main Backend (Auth & Web):
```bash
python main.py
# Runs on http://localhost:8000
```

Terminal 2 - Agent Server (Automation):
```bash
python agent_server.py
# Runs on http://localhost:5005
# WebSocket on ws://localhost:5005/ws/chat/{session_id}
```

### Step 6: Load Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `extension` folder from this project
5. The extension icon should appear in your toolbar

## Usage

### 1. Sign Up / Login

- Click the extension icon
- Sign up with email or Google OAuth
- Verify your email (if email verification is enabled)

### 2. Use the Chat Interface

Once logged in, you'll see the chat interface. Simply type what you want to automate:

**Examples:**
- "Go to Google and search for Python tutorials"
- "Open Amazon and find laptops under $1000"
- "Fill out the contact form on example.com with my details"
- "Extract all article titles from news.ycombinator.com"

### 3. View Real-time Progress

As the agent works, you'll see:
- **Task Summary**: Overall progress and status
- **Step-by-step Breakdown**: Each action the agent takes
- **Collapsible Details**: Click any step to see:
  - Tool arguments used
  - URLs visited
  - Actions performed
  - Extracted content
  - Errors (if any)
  - Execution time

### 4. Understand the Steps

Each step shows:
- 🚀 **Agent Started**: Agent begins processing
- 🤔 **Agent Thinking**: Agent is planning the next action
- 🔧 **Tool Call**: Agent is calling the automation tool
- ✅ **Tool Result**: Results from automation
- 🎉 **Task Completed**: Final success message

## API Endpoints

### Agent Server (Port 5005)

#### POST `/chat`
Legacy non-streaming endpoint.

**Request:**
```json
{
  "message": "Go to Google and search for AI",
  "session_id": "optional_session_id"
}
```

**Response:**
```json
{
  "reply": "Task completed successfully",
  "actions": [],
  "session_id": "session_123"
}
```

#### WebSocket `/ws/chat/{session_id}`
Real-time streaming endpoint.

**Send:**
```json
{
  "message": "Your automation request"
}
```

**Receive Events:**

1. **Start Event**
```json
{
  "type": "start",
  "timestamp": "2025-12-27T10:00:00",
  "message": "Starting automation task..."
}
```

2. **Step Event**
```json
{
  "type": "step",
  "step_number": 1,
  "step_type": "tool_start",
  "title": "Tool Call: Automation",
  "content": "Calling Automation with arguments",
  "tool_name": "Automation",
  "tool_args": {"task": "Go to Google"},
  "timestamp": "2025-12-27T10:00:01"
}
```

3. **Complete Event**
```json
{
  "type": "complete",
  "timestamp": "2025-12-27T10:00:30",
  "message": "Automation task completed"
}
```

4. **Error Event**
```json
{
  "type": "error",
  "error": "Error message",
  "timestamp": "2025-12-27T10:00:15"
}
```

#### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "browser_connected": true,
  "active_sessions": 3
}
```

## History API

The automation tool returns comprehensive history data:

```python
{
  "status": "completed",
  "successful": true,
  "final_result": "Task completed",
  "urls": ["https://google.com", "https://example.com"],
  "screenshot_paths": ["/path/to/screenshot1.png"],
  "action_names": ["navigate", "click", "type", "extract"],
  "extracted_content": ["Content 1", "Content 2"],
  "errors": [],
  "has_errors": false,
  "number_of_steps": 5,
  "total_duration_seconds": 12.5,
  "model_thoughts": ["Planning...", "Executing..."],
  "action_history": [...]
}
```

## Frontend Architecture

The extension uses WebSocket for real-time communication:

```javascript
// Connection
websocket = new WebSocket(`ws://localhost:5005/ws/chat/${SESSION_ID}`);

// Send message
websocket.send(JSON.stringify({ message: "Your task" }));

// Receive events
websocket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Handle different event types
};
```

### Step Display Components

1. **Task Container**: Wraps entire task execution
2. **Task Summary**: Shows overall status and progress
3. **Step Items**: Individual steps with collapsible details
4. **Step Content**: Detailed information for each step

## Configuration

### Agent Instructions

Modify the orchestrator agent instructions in `agent_server.py`:

```python
def create_orchestrator_agent():
    agent = OpenAIAgent(
        name="Automation Orchestrator",
        instructions="""Your custom instructions here...""",
        tools=[Automation],
        model="gpt-4.1-mini",
    )
    return agent
```

### Browser Configuration

Modify browser settings in `agent_server.py`:

```python
browser = Browser(
    cdp_url="http://localhost:9222",
    headless=False,  # Set to True for headless mode
    keep_alive=True,
)
```

### Custom Tools

Add custom tools to the browser agent:

```python
@tools.action("Description of your tool")
def my_custom_tool(browser_session: BrowserSession) -> ActionResult:
    # Your tool logic
    return ActionResult(extracted_content="Result")
```

## Troubleshooting

### WebSocket Connection Failed
- Ensure agent server is running on port 5005
- Check browser console for error messages
- Verify no firewall blocking WebSocket connections

### Browser Automation Not Working
- Confirm Chrome is running with `--remote-debugging-port=9222`
- Check if CDP URL is correct in `agent_server.py`
- Verify Playwright is installed: `playwright install chromium`

### Agent Not Responding
- Check OpenAI API key is set correctly
- Verify you have API credits
- Check terminal logs for error messages

### Extension Not Loading
- Ensure you loaded the extension in developer mode
- Check for errors in `chrome://extensions/`
- Verify all files are present in the extension folder

## Development

### Project Structure

```
FYPAuto/
├── agent_server.py          # Orchestrator agent & WebSocket server
├── main.py                  # Main backend (auth, web routes)
├── requirements.txt         # Python dependencies
├── pyproject.toml          # Project configuration
├── extension/              # Chrome extension
│   ├── manifest.json       # Extension manifest
│   ├── sidebar.html        # Chat UI
│   ├── sidebar.js          # Chat logic & WebSocket
│   ├── login.html          # Login page
│   └── login.js            # Login logic
└── templates/              # Web templates
    └── ...
```

### Adding New Features

1. **New Agent Tool**: Add to `agent_server.py` as a `@function_tool`
2. **New WebSocket Event**: Add handler in `sidebar.js`
3. **New UI Component**: Add to `sidebar.html` and style in `sidebar.js`

## Contributing

Contributions are welcome! Please ensure:
- Code follows existing style
- Add comments for complex logic
- Test thoroughly before submitting

## License

[Your License Here]

## Support

For issues and questions:
- Create an issue on GitHub
- Check existing documentation
- Review terminal logs for errors
