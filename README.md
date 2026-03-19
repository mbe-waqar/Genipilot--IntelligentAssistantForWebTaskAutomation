# GeniPilot -- AI-Powered Browser Automation Platform

An intelligent browser automation platform that combines AI agents with real-time browser control, featuring human-in-the-loop safety, voice commands, image-based automation, task scheduling, and a Chrome extension interface.

Built as a Final Year Project (FYP) demonstrating the integration of large language models with browser automation for practical, real-world web task execution.

![Python](https://img.shields.io/badge/Python-3.11+-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.121+-green)
![MongoDB](https://img.shields.io/badge/MongoDB-Async-brightgreen)
![OpenAI](https://img.shields.io/badge/OpenAI-Agents_SDK-orange)
![Chrome](https://img.shields.io/badge/Chrome-Extension_MV3-yellow)

---

## Overview

GeniPilot allows users to automate web tasks by describing them in natural language. The platform uses a two-level AI agent architecture: an **Orchestrator Agent** (GPT-4.1-mini) that interprets user intent and routes tasks, and a **Browser Automation Agent** (GPT-4o-mini via browser-use) that executes step-by-step actions in a real Chrome browser through the Chrome DevTools Protocol (CDP).

What sets GeniPilot apart is its **Human-in-the-Loop (HITL)** safety system -- the agent proactively asks the user for sensitive information (OTPs, passwords, credit card details) rather than attempting to guess or bypass them. Combined with real-time WebSocket streaming, users can watch every action the agent takes and intervene at any point.

The platform supports multiple interaction modes: a **web dashboard** for management and analytics, a **Chrome extension** side panel for quick chat-based automation, **voice commands** via the Web Speech API, and **image-assisted automation** where users can upload screenshots for context-aware task execution.

---

## Key Features

### AI and Automation
- Two-level agent architecture (Orchestrator + Browser Agent)
- Real-time step-by-step execution streaming via WebSocket
- Human-in-the-loop safety for sensitive data (2FA, OTP, passwords)
- Conversation memory across sessions
- Task cancellation mid-execution

### Web Dashboard
- Statistics overview (total tasks, success rate, scheduled count)
- Interactive charts (task timeline, status distribution)
- Automation history with search, filter, rerun, and detailed view
- Scheduled task management with full CRUD
- PDF, CSV, and JSON report export
- Daily usage monitoring with plan limits

### Browser Extension (Chrome)
- Manifest V3 side panel chat interface
- Real-time streaming of agent actions
- Image attachment for context-aware automation
- Quick-access automation templates
- Auto-reconnect on extension reload

### Vision Module
- Image upload and clipboard paste support (PNG, JPEG, WebP)
- GPT-4o vision analysis for OCR and UI element detection
- Image context automatically enriches automation prompts

### Voice Assistant
- Browser Web Speech API for voice command recognition
- Audio feedback and transcription display
- Voice command history tracking

### Task Scheduling
- Multiple frequencies: once, hourly, daily, weekly, monthly
- APScheduler-based background execution
- Run-now, pause, resume, and delete controls
- Execution status tracking with last/next run times

### Subscription Plans
- Three tiers: Free, Pro ($9.99/mo), Enterprise ($29.99/mo)
- Daily task limits and scheduled task caps
- Feature gating (image module, voice, email alerts, API access)
- Automatic daily counter reset

### Email Notifications
- Task completion and failure alerts
- HTML-formatted email templates
- Per-user notification preferences

### Authentication and User Management
- Email/password registration with Argon2 hashing
- Email verification with 6-digit codes
- Google OAuth 2.0 (web and extension)
- Session-based authentication
- Profile management with picture upload and crop

---

## System Architecture

```
+-------------------+         WebSocket          +-------------------+
|  Chrome Extension | <========================> |   Agent Server    |
|  (Side Panel UI)  |    ws://localhost:5005     |   (Port 5005)     |
+-------------------+                            +--------+----------+
                                                          |
                                                          | Orchestrator Agent
                                                          | (GPT-4.1-mini)
                                                          |
                                                          v
+-------------------+         HTTP/WS            +-------------------+
|   Web Dashboard   | <========================> |   Main Server     |
|  (Browser UI)     |    http://localhost:8000   |   (Port 8000)     |
+-------------------+                            +--------+----------+
                                                          |
                                                          |
                     +------------------------------------+----+
                     |                                         |
                     v                                         v
            +----------------+                        +-----------------+
            |    MongoDB     |                        | Chrome Browser  |
            | (Users, Tasks, |                        | (CDP Port 9222) |
            |  History, etc) |                        +-----------------+
            +----------------+
```

The system runs two servers:
- **Main Server** (port 8000): Handles authentication, web pages, dashboard APIs, user management, plan logic, and serves the web UI.
- **Agent Server** (port 5005): Manages AI agent orchestration, browser automation, WebSocket chat, scheduled task execution, and HITL interactions.

Both servers share the same MongoDB database for users, automation history, and scheduled tasks.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend Framework | FastAPI, Uvicorn |
| Language | Python 3.11+ |
| Database | MongoDB (Motor async driver, PyMongo sync) |
| AI / LLM | OpenAI Agents SDK, GPT-4.1-mini, GPT-4o, GPT-4o-mini |
| Browser Automation | browser-use, Playwright, Chrome DevTools Protocol |
| LLM Framework | LangChain (OpenAI + Anthropic integrations) |
| Frontend | HTML, CSS, JavaScript, Bootstrap 5, Chart.js, Cropper.js |
| Chrome Extension | Manifest V3, Side Panel API, Chrome APIs |
| Task Scheduling | APScheduler |
| Authentication | Argon2-cffi, Google OAuth 2.0, Session middleware |
| Email | SMTP (Gmail), aiosmtplib |
| Real-time | WebSocket (native) |
| PDF Generation | fpdf2 |

---

## Prerequisites

- Python 3.11 or higher
- MongoDB (local installation or MongoDB Atlas)
- Google Chrome browser
- OpenAI API key (with access to GPT-4.1-mini and GPT-4o)
- Google OAuth 2.0 credentials (optional, for social login)
- Gmail app password (optional, for email verification and notifications)

---

## Installation and Setup

### Step 1: Clone the Repository

```bash
git clone <repository-url>
cd FYPAuto
```

### Step 2: Install Dependencies

Using uv (recommended):
```bash
uv sync
```

Using pip:
```bash
pip install -r requirements.txt
pip install openai-agents
playwright install chromium
```

### Step 3: Configure Environment Variables

Create a `.env` file in the project root:

```env
# OpenAI API Key (required)
OPENAI_API_KEY=your_openai_api_key

# MongoDB Connection (required)
MONGODB_URL=mongodb://localhost:27017/
DATABASE_NAME=myapp

# Session Secret (required)
SECRET_KEY=your_random_secret_key

# Email / SMTP (optional -- for email verification and notifications)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_gmail_app_password

# Google OAuth (optional -- for Google sign-in)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
```

### Step 4: Start Chrome with Remote Debugging

Windows:
```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug"
```

macOS:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

Linux:
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

### Step 5: Start the Servers

Terminal 1 -- Main Server (Auth, Dashboard, Web Pages):
```bash
python main.py
# Runs on http://localhost:8000
```

Terminal 2 -- Agent Server (AI Agents, Automation, WebSocket):
```bash
python agent_server.py
# Runs on http://localhost:5005
```

### Step 6: Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project
5. The GeniPilot icon will appear in the toolbar
6. Click the icon to open the side panel

---

## Usage Guide

### Web Dashboard

1. Navigate to `http://localhost:8000` and sign up or log in
2. The dashboard shows stats, charts, task history, and scheduled tasks
3. Use the **Automation History** section to view, search, filter, rerun, or export tasks
4. Use the **Scheduled Tasks** section to create and manage automated schedules
5. Download a **PDF Report** from the Export dropdown in the history section

### Chrome Extension

1. Click the GeniPilot extension icon to open the side panel
2. Log in with your credentials or Google account
3. Type an automation command (e.g., "Go to Amazon and search for laptops under $500")
4. Watch the agent execute step-by-step in real time
5. Respond to HITL prompts when the agent asks for sensitive information

### Voice Commands

1. Go to the **Voice Assistant** section in the dashboard
2. Toggle the voice assistant ON
3. Click the orb or say your command
4. The agent processes and executes the voice command

### Image-Assisted Automation

1. In the extension sidebar, click the image attachment button or paste with Ctrl+V
2. Add a text instruction describing what to do with the image context
3. The vision module analyzes the image and enriches the automation prompt

### Scheduled Tasks

1. Go to **Scheduled Tasks** in the dashboard
2. Enter the automation prompt and select a frequency
3. Set the desired time and click **Schedule Task**
4. Tasks run automatically in the background at the scheduled times

---

## API Reference

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| GET | `/signup` | Signup page |
| POST | `/signup` | Register new user |
| POST | `/api/signup` | Register via JSON API |
| GET | `/login` | Login page |
| POST | `/login` | Login via form |
| POST | `/api/login` | Login via JSON API |
| POST | `/api/verify-email` | Verify email code |
| POST | `/api/resend-verification` | Resend verification code |
| POST | `/api/auth/google` | Google OAuth login |
| POST | `/api/auth/google/signup` | Google OAuth signup |
| GET | `/logout` | Logout and clear session |

### Dashboard and Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Dashboard page (requires auth) |
| GET | `/api/dashboard/stats` | User statistics |
| GET | `/api/automation/history` | Automation history list |
| GET | `/api/automation/history/{id}` | Single history detail |
| DELETE | `/api/automation/history` | Clear all history |

### Scheduled Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/scheduled-tasks` | List scheduled tasks |
| POST | `/api/scheduled-tasks` | Create scheduled task |
| PUT | `/api/scheduled-tasks/{id}` | Update scheduled task |
| DELETE | `/api/scheduled-tasks/{id}` | Delete scheduled task |
| POST | `/api/scheduled-tasks/{id}/run` | Run task immediately |

### User Profile and Settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/user/profile` | Get profile data |
| PUT | `/api/user/profile` | Update profile |
| POST | `/api/user/profile-picture` | Upload profile picture |
| DELETE | `/api/user/profile-picture` | Remove profile picture |
| GET | `/api/user/settings` | Get notification settings |
| PUT | `/api/user/settings` | Update notification settings |

### Export and Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/history/export` | Export history (CSV/JSON) |
| GET | `/api/export-pdf-report` | Download PDF report |
| POST | `/api/rerun` | Re-run a previous task |

### Plan Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plan-info` | Get current plan info |
| POST | `/api/upgrade` | Upgrade plan |
| POST | `/api/downgrade` | Downgrade to free |

### Extension APIs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/ext/login` | Extension login |
| POST | `/ext/signup` | Extension signup |
| GET | `/ext/logout` | Extension logout |

### WebSocket Endpoints (Agent Server -- Port 5005)

| Endpoint | Description |
|----------|-------------|
| `ws://localhost:5005/ws/chat/{email}` | Extension chat with streaming |
| `ws://localhost:5005/ws/dashboard/{email}` | Dashboard real-time updates |

### Health Check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Main server health |
| GET | `localhost:5005/health` | Agent server health |

---

## Project Structure

```
FYPAuto/
├── main.py                 # Main server (auth, dashboard, APIs, web routes)
├── agent_server.py         # Agent server (AI orchestration, browser automation, WebSocket)
├── models.py               # Pydantic models and MongoDB operations
├── plan_module.py          # Subscription plan logic and limits
├── vision_module.py        # Image analysis with GPT-4o vision
├── task_scheduler.py       # APScheduler task execution
├── mongodb_session.py      # MongoDB session handling
├── custom_loader.js        # Custom page loader script
├── requirements.txt        # Python dependencies
├── pyproject.toml          # Project configuration (uv)
├── .env                    # Environment variables (not in repo)
├── extension/              # Chrome Extension (Manifest V3)
│   ├── manifest.json       # Extension manifest
│   ├── sidebar.html        # Side panel chat UI
│   ├── sidebar.js          # Chat logic, WebSocket, streaming
│   ├── sidebar.css         # Sidebar styles
│   ├── login.html          # Extension login page
│   ├── login.js            # Extension login logic
│   └── login.css           # Login styles
├── templates/              # Web UI templates (Jinja2)
│   ├── index.html          # Landing page
│   ├── dashboard.html      # User dashboard
│   ├── login.html          # Web login page
│   ├── signup.html         # Web signup page
│   ├── pricing.html        # Pricing plans page
│   ├── automation.html     # Automation info page
│   ├── about-us.html       # About page
│   ├── contact.html        # Contact page
│   ├── faqs.html           # FAQs page
│   ├── auth.css            # Auth page styles
│   ├── auth.js             # Auth page scripts
│   └── assets/             # Static assets (CSS, JS, images, fonts)
│       ├── css/style.css   # Dashboard component styles
│       ├── js/dashboard.js # Dashboard logic (stats, history, charts)
│       └── img/            # Images and logos
└── use-case/               # Example automation use-case prompts
```

---

## Troubleshooting

### WebSocket Connection Failed
- Ensure the agent server is running on port 5005
- Check browser console for connection errors
- Verify no firewall is blocking WebSocket connections

### Browser Automation Not Working
- Confirm Chrome is running with `--remote-debugging-port=9222`
- Visit `http://localhost:9222/json` to verify CDP is accessible
- Run `playwright install chromium` if Playwright browsers are missing

### Agent Not Responding
- Verify `OPENAI_API_KEY` is set correctly in `.env`
- Check you have sufficient API credits
- Review terminal logs for error details

### Extension Not Loading
- Ensure Developer mode is enabled in `chrome://extensions/`
- Check for errors on the extension card
- Verify all files are present in the `extension/` folder

### Email Verification Not Working
- Confirm SMTP credentials in `.env` are correct
- For Gmail, use an App Password (not your regular password)
- Check spam folder for verification emails

### MongoDB Connection Issues
- Ensure MongoDB is running (`mongod` or MongoDB service)
- Verify `MONGODB_URL` in `.env` points to the correct instance
- For Atlas, ensure your IP is whitelisted

---

## License

MIT License

---

## Acknowledgments

Built with FastAPI, OpenAI Agents SDK, browser-use, MongoDB, and Playwright.
