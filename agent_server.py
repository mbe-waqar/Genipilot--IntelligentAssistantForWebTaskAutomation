import os
import asyncio
import json
import threading
import logging
import re
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from browser_use import Browser, Agent as BrowserAgent, ChatOpenAI, Tools, ActionResult, BrowserSession
import uvicorn
import aiohttp
from dotenv import load_dotenv
from typing import Optional

# OpenAI Agent SDK (orchestrator pattern)
from agents import Agent as OpenAIAgent, Runner, ItemHelpers
from agents.tool import function_tool
from openai.types.responses import ResponseTextDeltaEvent

# MongoDB Session for conversation memory
from mongodb_session import MongoDBSession, create_session_for_user

# Database models for tracking automation history
from models import AutomationHistoryDB, AutomationHistory, TaskStatus, get_database

# Task scheduler
from task_scheduler import initialize_scheduler, shutdown_scheduler, get_scheduler

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

load_dotenv()

# Email configuration (same env vars as main.py)
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)


async def get_user_settings(user_email: str) -> dict:
    """
    Fetch user notification settings from MongoDB.
    Returns defaults if settings are not found.
    """
    defaults = {
        "email_notifications": False,
        "task_notifications": False,
        "error_alerts": False
    }
    try:
        db = get_database()
        user_doc = await db["users"].find_one({"email": user_email})
        if user_doc and "settings" in user_doc:
            settings = user_doc["settings"]
            return {
                "email_notifications": settings.get("email_notifications", False),
                "task_notifications": settings.get("task_notifications", False),
                "error_alerts": settings.get("error_alerts", False)
            }
        return defaults
    except Exception as e:
        print(f"⚠️ Could not fetch user settings for {user_email}: {e}")
        return defaults


def send_task_notification_email(to_email: str, task_name: str, status: str,
                                  duration: str, result_summary: str = "") -> bool:
    """
    Send a task completion/failure notification email.
    Returns True if sent successfully, False otherwise.
    """
    if not SMTP_USER or not SMTP_PASSWORD:
        print("⚠️ SMTP not configured, skipping notification email")
        return False

    try:
        subject = f"Task {status.capitalize()}: {task_name[:60]}"
        status_color = "#28a745" if status == "success" else "#dc3545"
        status_label = "Completed Successfully" if status == "success" else "Failed"

        html = f"""
        <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 5px;">
              <h2 style="color: #2c3e50;">Task Notification</h2>
              <div style="background-color: {status_color}; color: white; padding: 10px 15px; border-radius: 5px; margin-bottom: 15px;">
                <strong>{status_label}</strong>
              </div>
              <p><strong>Task:</strong> {task_name}</p>
              <p><strong>Duration:</strong> {duration}</p>
              {f'<p><strong>Result:</strong> {result_summary[:500]}</p>' if result_summary else ''}
              <hr style="border: none; border-top: 1px solid #ddd;">
              <p style="color: #999; font-size: 12px;">You can disable these notifications in your Dashboard Settings.</p>
            </div>
          </body>
        </html>
        """

        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = SMTP_FROM
        msg['To'] = to_email
        msg.attach(MIMEText(html, 'html'))

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)

        print(f"✅ Task notification email sent to {to_email}")
        return True
    except Exception as e:
        print(f"⚠️ Failed to send task notification email: {e}")
        return False


def send_error_alert_email(to_email: str, task_name: str, errors: list) -> bool:
    """
    Send an error alert email when automation encounters errors.
    Returns True if sent successfully, False otherwise.
    """
    if not SMTP_USER or not SMTP_PASSWORD:
        print("⚠️ SMTP not configured, skipping error alert email")
        return False

    try:
        subject = f"Error Alert: {task_name[:60]}"
        error_items = "".join(f"<li>{e}</li>" for e in errors[:5])

        html = f"""
        <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 5px;">
              <h2 style="color: #dc3545;">Error Alert</h2>
              <p>An automation task encountered errors:</p>
              <p><strong>Task:</strong> {task_name}</p>
              <div style="background-color: #f8d7da; padding: 10px 15px; border-radius: 5px;">
                <strong>Errors:</strong>
                <ul>{error_items}</ul>
              </div>
              <hr style="border: none; border-top: 1px solid #ddd;">
              <p style="color: #999; font-size: 12px;">You can disable error alerts in your Dashboard Settings.</p>
            </div>
          </body>
        </html>
        """

        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = SMTP_FROM
        msg['To'] = to_email
        msg.attach(MIMEText(html, 'html'))

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)

        print(f"✅ Error alert email sent to {to_email}")
        return True
    except Exception as e:
        print(f"⚠️ Failed to send error alert email: {e}")
        return False


# Custom logging handler to send agent steps to WebSocket in real-time
class WebSocketLogHandler(logging.Handler):
    """Captures browser-use agent logs and sends them to WebSocket."""

    def __init__(self):
        super().__init__()
        self.current_step = 0
        self.current_websocket = None
        self.current_user_email = None

    def set_websocket(self, websocket, user_email):
        """Set the active WebSocket for this automation session."""
        self.current_websocket = websocket
        self.current_user_email = user_email
        self.current_step = 0

    def clear_websocket(self):
        """Clear the WebSocket after automation completes."""
        self.current_websocket = None
        self.current_user_email = None
        self.current_step = 0

    def emit(self, record):
        """Send log records to WebSocket if they contain step information."""
        if not self.current_websocket:
            return

        try:
            msg = record.getMessage()

            # Check if this is a step log from browser-use agent
            # Format: "📍 Step X:"
            step_match = re.search(r'📍 Step (\d+):', msg)
            if step_match:
                self.current_step = int(step_match.group(1))
                print(f"🔍 Captured Step {self.current_step}")  # Debug
                return  # Wait for the details in next log lines

            # Extract goal: "🎯 Next goal: ..."
            goal_match = re.search(r'🎯 Next goal: (.+)', msg)
            if goal_match and self.current_step > 0:
                goal = goal_match.group(1).strip()
                print(f"🔍 Captured Goal: {goal}")  # Debug

                # Send step to WebSocket
                self._schedule_send({
                    "type": "automation_step_realtime",
                    "step_number": self.current_step,
                    "goal": goal,
                    "timestamp": datetime.now().isoformat()
                })

            # Extract evaluation: "👍 Eval: ..."
            eval_match = re.search(r'👍 Eval: (.+)', msg)
            if eval_match and self.current_step > 0:
                evaluation = eval_match.group(1).strip()
                print(f"🔍 Captured Eval: {evaluation[:50]}...")  # Debug

                # Send evaluation update
                self._schedule_send({
                    "type": "automation_step_update",
                    "step_number": self.current_step,
                    "evaluation": evaluation,
                    "timestamp": datetime.now().isoformat()
                })

            # Extract action: "▶️   action_name: ..."
            action_match = re.search(r'▶️\s+(\w+):', msg)
            if action_match and self.current_step > 0:
                action = action_match.group(1).strip()
                print(f"🔍 Captured Action: {action}")  # Debug

                # Send action update
                self._schedule_send({
                    "type": "automation_step_update",
                    "step_number": self.current_step,
                    "action": action,
                    "timestamp": datetime.now().isoformat()
                })

            # Extract memory: "🧠 Memory: ..."
            memory_match = re.search(r'🧠 Memory: (.+)', msg)
            if memory_match and self.current_step > 0:
                memory = memory_match.group(1).strip()
                print(f"🔍 Captured Memory: {memory[:50]}...")  # Debug

                # Send memory update
                self._schedule_send({
                    "type": "automation_step_update",
                    "step_number": self.current_step,
                    "memory": memory,
                    "timestamp": datetime.now().isoformat()
                })

        except Exception as e:
            # Don't let logging errors crash the handler
            pass

    def _schedule_send(self, data: dict):
        """Schedule an async send task from sync context."""
        if not self.current_websocket:
            return

        try:
            # Get the event loop (the main FastAPI/uvicorn loop)
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                # If no running loop, get the default loop
                loop = asyncio.get_event_loop()

            # Schedule the coroutine to run in the event loop thread-safely
            future = asyncio.run_coroutine_threadsafe(
                safe_send_json(self.current_websocket, data),
                loop
            )

            # Optional: wait a tiny bit to ensure it's scheduled (non-blocking)
            # Don't wait for completion to avoid blocking the logger
            print(f"📤 Scheduled WebSocket send: {data.get('type')}")  # Debug

        except Exception as e:
            print(f"⚠️ Failed to schedule WebSocket message: {e}")
            import traceback
            traceback.print_exc()


# Global WebSocket log handler
websocket_log_handler = WebSocketLogHandler()

# Configure browser-use agent loggers to use our handler
# Try multiple logger names to ensure we catch all agent logs
for logger_name in ['browser_use', 'Agent', 'agent', 'BrowserAgent']:
    logger = logging.getLogger(logger_name)
    logger.addHandler(websocket_log_handler)
    logger.setLevel(logging.INFO)

# Also attach to root logger as fallback
root_logger = logging.getLogger()
root_logger.addHandler(websocket_log_handler)


# Lifespan context manager for startup and shutdown events
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown events"""
    # Startup
    print("🚀 Starting agent server...")
    try:
        # Clean up any orphaned tasks from previous sessions
        await cleanup_orphaned_tasks()

        # Initialize task scheduler
        await initialize_scheduler(browser, llm, tools, automation_func=execute_automation_task)
        print("✅ Task scheduler initialized with shared automation API")
    except Exception as e:
        print(f"⚠️ Failed to initialize task scheduler: {e}")

    yield

    # Shutdown
    try:
        shutdown_scheduler()
        print("✅ Task scheduler shutdown")
    except Exception as e:
        print(f"⚠️ Error shutting down scheduler: {e}")


app = FastAPI(lifespan=lifespan)

# Allow extension → backend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------
# CONNECT TO CHROME VIA CDP
# ---------------------------
# IMPORTANT: This connects to Chrome running with --remote-debugging-port=9222
# All automation will happen in THIS Chrome instance, NOT in the extension

_browser_disconnected = False  # Set True when CDP WebSocket drops

def _make_browser() -> Browser:
    """Create a new Browser instance pointed at the local Chrome CDP endpoint."""
    return Browser(
        cdp_url="http://localhost:9222",
        headless=False,
        keep_alive=True,
        disable_security=False,
        permissions=['clipboardReadWrite', 'notifications', 'audioCapture'],
    )

browser = _make_browser()
print("[Browser] Connecting to Chrome at http://localhost:9222")

async def _chrome_health_check() -> bool:
    """Return True if Chrome's CDP endpoint is reachable, False otherwise."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get("http://localhost:9222/json/version", timeout=aiohttp.ClientTimeout(total=3)) as resp:
                return resp.status == 200
    except Exception:
        return False

async def recreate_browser():
    """Recreate the global browser object after a CDP disconnect."""
    global browser, _browser_disconnected
    print("[Browser] Recreating browser connection...")
    browser = _make_browser()
    _browser_disconnected = False
    print("[Browser] Browser connection recreated.")

# JavaScript to replace browser-use loading logo with custom logo
CUSTOM_LOADING_SCRIPT = """
(function() {
    // Function to replace the browser-use logo
    function replaceBrowserUseLogo() {
        const loadingDiv = document.getElementById('pretty-loading-animation');
        if (loadingDiv) {
            const img = loadingDiv.querySelector('img');
            if (img && img.src.includes('browser-use.com')) {
                // Replace with custom logo (served from FastAPI)
                img.src = 'http://127.0.0.1:5005/static/whitelogo.png';
                img.style.width = '250px';
                img.style.height = 'auto';
                console.log('✅ Replaced browser-use logo with custom logo');
            }
        }
    }

    // Try to replace immediately
    replaceBrowserUseLogo();

    // Also watch for DOM changes in case logo is added later
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                replaceBrowserUseLogo();
            }
        }
    });

    // Start observing
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Stop observing after 5 seconds (logo should be loaded by then)
    setTimeout(() => {
        observer.disconnect();
    }, 5000);
})();
"""

# LLM
llm = ChatOpenAI(model="gpt-4.1-mini")

# Async loop running in background thread
loop = asyncio.new_event_loop()
threading.Thread(target=loop.run_forever, daemon=True).start()

# Browser automation tools
tools = Tools()

async def ask_user_input_via_websocket(question: str, user_email: str, timeout: int = 120) -> str:
    """
    Request user input through the WebSocket connection.

    Args:
        question: The question to ask the user
        user_email: User's email to identify the WebSocket
        timeout: Timeout in seconds (default 120s = 2 minutes)

    Returns:
        str: User's response
    """
    import uuid

    # Generate unique request ID
    request_id = str(uuid.uuid4())

    # Create event to wait for response
    response_event = asyncio.Event()

    # Store the request
    pending_input_requests[request_id] = {
        "question": question,
        "event": response_event,
        "response": None,
        "user_email": user_email
    }

    # Get the user's active WebSocket
    websocket = active_websockets.get(user_email)

    if not websocket:
        # Fallback to terminal if no WebSocket connection
        print(f"⚠️ No WebSocket for {user_email}, using terminal input")
        answer = input(f'{question} > ')
        del pending_input_requests[request_id]
        return answer

    try:
        # Send input request to client
        await safe_send_json(websocket, {
            "type": "input_request",
            "request_id": request_id,
            "question": question,
            "timestamp": datetime.now().isoformat()
        })

        # Wait for response with timeout
        try:
            await asyncio.wait_for(response_event.wait(), timeout=timeout)

            # Get the response
            response = pending_input_requests[request_id]["response"]

            # Clean up
            del pending_input_requests[request_id]

            return response or ""

        except asyncio.TimeoutError:
            # Clean up
            del pending_input_requests[request_id]

            # Send timeout notification
            await safe_send_json(websocket, {
                "type": "input_timeout",
                "request_id": request_id,
                "message": "Input request timed out",
                "timestamp": datetime.now().isoformat()
            })

            return ""  # Return empty string on timeout

    except Exception as e:
        # Clean up on error
        if request_id in pending_input_requests:
            del pending_input_requests[request_id]
        print(f"Error requesting user input: {e}")
        return ""


@tools.action("Use this tool to ask the human for any required information needed to complete the task.")
async def ask_human(question: str, browser_session: BrowserSession) -> ActionResult:
    """Ask user for input through the extension frontend."""
    # Use global user email from current automation context
    global _current_automation_user
    user_email = _current_automation_user

    if not user_email or user_email not in active_websockets:
        # Fallback to terminal if no WebSocket
        print(f"⚠️ No WebSocket for {user_email}, using terminal input")
        answer = input(f'{question} > ')
    else:
        # Request input through WebSocket
        print(f"✅ Requesting input from extension for {user_email}")
        answer = await ask_user_input_via_websocket(question, user_email)

    return ActionResult(
        extracted_content=f'The human responded with: {answer}',
        long_term_memory=f'The human responded with: {answer}'
    )


@tools.action("Wait for the human to scan or enter code from 2FA device")
async def wait_for_2fa(browser_session: BrowserSession) -> ActionResult:
    """Wait for user to complete 2FA through the extension frontend."""
    user_email = getattr(browser_session, '_user_email', None)

    if not user_email:
        # Fallback to terminal
        input("Please complete the 2FA process and press Enter to continue...")
    else:
        # Request 2FA completion through WebSocket
        await ask_user_input_via_websocket(
            "Please complete the 2FA process in your browser, then click 'Done' here.",
            user_email
        )

    return ActionResult(output="2FA process completed by human.")


# Store active sessions and their histories
active_sessions = {}

# Store pending input requests (for ask_human tool)
# Format: {request_id: {"question": str, "event": asyncio.Event(), "response": str}}
pending_input_requests = {}

# Store active WebSocket connections per user
# Format: {user_email: WebSocket}
active_websockets = {}

# Store dashboard WebSocket connections per user (for real-time notifications)
# Format: {user_email: WebSocket}
dashboard_websockets = {}

# Store cancellation flags per user
# Format: {user_email: bool}
cancellation_flags = {}

# Store currently running task IDs per user
# Format: {user_email: history_id}
running_tasks = {}

# Store currently running BrowserAgent instances per user
# Format: {user_email: BrowserAgent}
# Used to call agent.stop() for real mid-execution cancellation
running_agents = {}


# Request body model
class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    user_email: Optional[str] = None  # User email from authentication


# Global variable to store current user email for automation context
_current_automation_user = None


async def inject_logo_script_on_all_pages(browser_instance):
    """
    Inject custom logo replacement script on all new pages.
    This ensures the browser-use loading logo is replaced with our custom logo.
    """
    try:
        # Get the current browser context
        if hasattr(browser_instance, 'context') and browser_instance.context:
            context = browser_instance.context

            # Try to add initialization script
            if hasattr(context, 'add_init_script'):
                await context.add_init_script(CUSTOM_LOADING_SCRIPT)
                print("✅ Added custom logo script via add_init_script")
            else:
                print("⚠️ add_init_script not available, will inject per-page")
        else:
            print("⚠️ Browser context not available yet")
    except Exception as e:
        print(f"⚠️ Could not inject logo script: {e}")
        import traceback
        traceback.print_exc()


# ──────────────────────────────────────────────────────────────────────────────
# TAB SELECTION — ensures automation ALWAYS runs in a real browser tab,
# never inside the extension UI (chrome-extension:// pages).
# ──────────────────────────────────────────────────────────────────────────────

# URL scheme prefixes that belong to extension / devtools pages — never automate these.
_EXTENSION_URL_SCHEMES = (
    "chrome-extension://",
    "chrome://",
    "devtools://",
    "chrome-devtools://",
)

# URLs that belong to our own dashboard — never automate these tabs.
_DASHBOARD_URL_PREFIXES = (
    "http://localhost:8000",
    "http://127.0.0.1:8000",
)

# Safety rule prepended to every automation task (Layer 3 — prompt-level guard).
_TAB_SAFETY_RULE = (
    "[SYSTEM RULE] You must ONLY operate inside real browser tabs. "
    "If your current page URL starts with 'chrome-extension://', immediately "
    "open a new tab (navigate to about:blank, then to your destination) and "
    "continue the task there. Never interact with or automate any page whose "
    "URL starts with 'chrome-extension://'.\n\n"
)

# HITL safety rule — forces the agent to ask the human for sensitive information
# instead of guessing or inserting placeholder values.
_HITL_SAFETY_RULE = (
    "[CRITICAL RULE — HUMAN INPUT REQUIRED] "
    "You must NEVER guess, fabricate, or auto-fill sensitive information. "
    "This includes: email addresses, usernames, passwords, phone numbers, "
    "OTP codes, verification codes, 2FA codes, credit card numbers, "
    "addresses, security answers, or any personal credentials.\n"
    "When you encounter a form field that requires ANY of the above:\n"
    "1. STOP immediately — do NOT type anything into the field.\n"
    "2. Use the 'ask_human' tool to ask the user for the required information.\n"
    "3. WAIT for the human to respond before continuing.\n"
    "4. Only after receiving the actual value from the human, type it into the field.\n"
    "You must NEVER insert placeholder text like 'email@example.com', 'password123', "
    "'test@test.com', 'user@email.com', or any made-up value.\n"
    "If you are unsure whether a field requires sensitive data, use 'ask_human' to ask.\n\n"
)

# Common website keywords → expected domain fragment for tab matching.
_DOMAIN_KEYWORDS = {
    "youtube":       "youtube.com",
    "gmail":         "mail.google.com",
    "google":        "google.com",
    "amazon":        "amazon.com",
    "instagram":     "instagram.com",
    "facebook":      "facebook.com",
    "twitter":       "twitter.com",
    "whatsapp":      "web.whatsapp.com",
    "linkedin":      "linkedin.com",
    "reddit":        "reddit.com",
    "github":        "github.com",
    "netflix":       "netflix.com",
    "spotify":       "spotify.com",
    "yelp":          "yelp.com",
    "ebay":          "ebay.com",
    "wikipedia":     "wikipedia.org",
    "stackoverflow": "stackoverflow.com",
    "chatgpt":       "chatgpt.com",
    "x.com":         "x.com",
}

# Phrases that signal the user explicitly wants a brand-new tab.
_NEW_TAB_PHRASES = [
    "new tab", "in a new tab", "open new tab", "open a new tab",
    "new window", "in a new window",
]


async def _get_valid_browser_tabs() -> list:
    """
    Hit the CDP JSON endpoint and return only real browser tabs.
    Filters out chrome-extension://, chrome://, devtools:// pages.
    """
    try:
        async with aiohttp.ClientSession() as http:
            async with http.get(
                "http://localhost:9222/json",
                timeout=aiohttp.ClientTimeout(total=3)
            ) as resp:
                if resp.status != 200:
                    return []
                targets = await resp.json()

        return [
            t for t in targets
            if t.get("type") == "page"
            and not any(
                t.get("url", "").startswith(scheme)
                for scheme in _EXTENSION_URL_SCHEMES
            )
            and not any(
                t.get("url", "").startswith(prefix)
                for prefix in _DASHBOARD_URL_PREFIXES
            )
        ]
    except Exception as e:
        print(f"⚠️ [TabSelect] Could not enumerate CDP targets: {e}")
        return []


def _find_relevant_tab(task: str, valid_tabs: list) -> dict:
    """
    Given the task text and a list of valid tabs, return the best matching
    open tab (or None if no match found).
    Matches are based on domain keywords and explicit URLs found in the task.
    """
    if not valid_tabs:
        return None

    task_lower = task.lower()
    target_domains = set()

    # 1. Explicit https?:// URLs mentioned in the task.
    for match in re.findall(r'https?://([a-zA-Z0-9.\-]+)', task_lower):
        target_domains.add(match)

    # 2. Keyword → domain lookup.
    for keyword, domain in _DOMAIN_KEYWORDS.items():
        if keyword in task_lower:
            target_domains.add(domain)

    if not target_domains:
        return None

    for tab in valid_tabs:
        tab_url = tab.get("url", "").lower()
        for domain in target_domains:
            if domain in tab_url:
                return tab

    return None


async def _activate_existing_tab(target_id: str) -> bool:
    """Activate an existing Chrome tab using the CDP HTTP API."""
    try:
        async with aiohttp.ClientSession() as http:
            async with http.put(
                f"http://localhost:9222/json/activate/{target_id}",
                timeout=aiohttp.ClientTimeout(total=3)
            ) as resp:
                if resp.status == 200:
                    print(f"✅ [TabSelect] Activated existing tab: {target_id}")
                    return True
    except Exception as e:
        print(f"⚠️ [TabSelect] Failed to activate tab {target_id}: {e}")
    return False


async def _create_new_browser_tab() -> str:
    """Create a new blank Chrome tab via the CDP HTTP API. Returns targetId or None."""
    try:
        async with aiohttp.ClientSession() as http:
            async with http.get(
                "http://localhost:9222/json/new",
                timeout=aiohttp.ClientTimeout(total=3)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    target_id = data.get("id")
                    print(f"✅ [TabSelect] Created new browser tab: {target_id}")
                    return target_id
    except Exception as e:
        print(f"⚠️ [TabSelect] Failed to create new tab: {e}")
    return None


async def select_automation_tab(task: str) -> str:
    """
    Select the correct Chrome tab for the automation task and activate it.

    Rules (in priority order):
      1. Task explicitly says "new tab" → force-create a new tab.
      2. A relevant tab matching the task domain is already open → reuse it.
      3. No relevant tab found → create a new tab.

    Returns the CDP targetId of the selected tab, or None on failure.
    """
    # Rule 1 — force new tab when explicitly requested.
    if any(phrase in task.lower() for phrase in _NEW_TAB_PHRASES):
        print("📋 [TabSelect] Task requests a new tab — force-creating one.")
        return await _create_new_browser_tab()

    # Enumerate all real browser tabs (extension pages excluded).
    valid_tabs = await _get_valid_browser_tabs()
    print(f"📋 [TabSelect] Valid browser tabs: {len(valid_tabs)}")
    for t in valid_tabs:
        print(f"   → {t.get('url', '')[:90]}")

    # Rule 2 — reuse an existing relevant tab.
    relevant_tab = _find_relevant_tab(task, valid_tabs)
    if relevant_tab:
        print(f"📋 [TabSelect] Reusing existing tab: {relevant_tab.get('url', '')[:70]}")
        await _activate_existing_tab(relevant_tab["id"])
        return relevant_tab["id"]

    # Rule 3 — no relevant tab, open a new one.
    print("📋 [TabSelect] No relevant tab found — creating a new tab.")
    return await _create_new_browser_tab()


# ──────────────────────────────────────────────────────────────────────────────

# Automation tool for orchestrator agent (following user's pattern)
async def execute_automation_task(task: str, user_email: str = None) -> str:
    """
    Core automation execution logic shared by both the Automation tool and scheduler.

    Args:
        task: The automation task to perform
        user_email: Email of the user running the task (optional, defaults to _current_automation_user)

    Returns:
        str: Result of the automation task
    """
    global _current_automation_user

    # Use provided user_email or fall back to global
    if user_email:
        _current_automation_user = user_email

    actual_user_email = _current_automation_user or "anonymous"

    # Track start time
    start_time = datetime.now()
    history_id = None

    try:
        # Create automation history record in database
        automation_record = AutomationHistory(
            user_email=actual_user_email,
            task_name=task[:100],  # Truncate task name
            task_description=task,
            status=TaskStatus.RUNNING,
            start_time=start_time
        )
        history_id = await AutomationHistoryDB.create(automation_record)
        print(f"✅ Created automation history record: {history_id}")

        # Track this running task for the user
        if actual_user_email:
            running_tasks[actual_user_email] = history_id

    except Exception as e:
        print(f"⚠️ Could not create automation history record: {e}")

    # Modify task if it contains "wait for instructions" to avoid agent getting stuck
    processed_task = task
    if "wait for" in task.lower() and "instruction" in task.lower():
        # Extract the part before "wait for instructions"
        import re
        match = re.search(r'(.*?)\s+(?:and\s+)?wait\s+for\s+(?:further\s+)?instruction', task, re.IGNORECASE)
        if match:
            base_task = match.group(1).strip()
            processed_task = f"{base_task}. When complete, use the 'done' action to signal completion."
            print(f"📝 Modified task to avoid waiting loop: {processed_task}")

    # ── Pre-task Chrome health check ────────────────────────────────────────────
    global browser, _browser_disconnected
    if _browser_disconnected:
        print("[Browser] Disconnect flag set — attempting reconnect before task...")
        if await _chrome_health_check():
            await recreate_browser()
        else:
            return "Chrome is not running or unreachable. Please start Chrome with --remote-debugging-port=9222."

    if not await _chrome_health_check():
        print("[Browser] Health check: FAIL — Chrome not reachable at http://localhost:9222")
        return "Chrome is not running or unreachable. Please start Chrome with --remote-debugging-port=9222."

    print("[Browser] Health check: OK")

    # ── LAYER 1: Select the correct Chrome tab BEFORE creating the agent ───────
    # This ensures the browser agent never attaches to the extension UI.
    chosen_target_id = await select_automation_tab(task)
    if chosen_target_id:
        print(f"✅ [TabSelect] Tab ready for automation: {chosen_target_id}")
        # Give Chrome 800 ms to register the activation / creation event.
        await asyncio.sleep(0.8)
    else:
        print("⚠️ [TabSelect] Tab selection failed — browser-use will use its default.")

    # ── LAYER 3: Prepend safety rules to the task prompt ─────────────────────
    # Tab safety: self-correct if the agent lands on an extension page.
    # HITL safety: never guess credentials, always ask the human.
    processed_task = _TAB_SAFETY_RULE + _HITL_SAFETY_RULE + processed_task

    # Create agent directly (user's working pattern - NO use_own_browser_context)
    agent = BrowserAgent(
        task=processed_task,
        browser=browser,
        llm=llm,
        tools=tools,
        reset=True,
        keep_open=True,
        max_actions_per_step=10,  # Limit actions per step to prevent infinite loops
        # Direct connection - no separate context
    )

    # ── Register CDP disconnect handler (browser-use lazily connects on first use) ──
    # We attach it to the underlying Playwright browser object if available.
    # On disconnect we set a flag so the next task can detect and recover.
    try:
        _pw_browser = (
            getattr(browser, '_browser', None)
            or getattr(browser, 'browser', None)
            or getattr(browser, '_playwright_browser', None)
        )
        if _pw_browser and not getattr(_pw_browser, '_disconnect_handler_registered', False):
            def _on_browser_disconnect():
                global _browser_disconnected
                _browser_disconnected = True
                print("🔴 [Browser] CDP disconnected! Chrome WebSocket lost. Next task will reconnect.")
            _pw_browser.on('disconnected', _on_browser_disconnect)
            _pw_browser._disconnect_handler_registered = True
            print("[Browser] Disconnect handler registered")
    except Exception as _dh_err:
        print(f"[Browser] Could not register disconnect handler (non-critical): {_dh_err}")

    # Store user email in browser session context for ask_human tool
    # This is a workaround to pass user_email to the ask_human tool
    if hasattr(agent, 'browser_context') and _current_automation_user:
        if hasattr(agent.browser_context, 'session'):
            agent.browser_context.session._user_email = _current_automation_user

    # Inject custom logo script AFTER agent is created
    # This ensures the browser context is available
    await inject_logo_script_on_all_pages(browser)

    # ── LAYER 4: Post-creation page URL check ─────────────────────────────────
    # Verify the agent isn't attached to an extension page after creation.
    # If it is, navigate to about:blank to escape before running the task.
    try:
        valid_tabs = await _get_valid_browser_tabs()
        if valid_tabs:
            # Check if the current/active page is an extension page via CDP
            async with aiohttp.ClientSession() as _http:
                async with _http.get(
                    "http://localhost:9222/json",
                    timeout=aiohttp.ClientTimeout(total=3)
                ) as _resp:
                    if _resp.status == 200:
                        all_targets = await _resp.json()
                        # Find the first page-type target that is an extension page
                        for target in all_targets:
                            if (target.get("type") == "page"
                                    and any(target.get("url", "").startswith(s) for s in _EXTENSION_URL_SCHEMES)):
                                # If this extension page was the last focused, force switch
                                if not chosen_target_id:
                                    new_tab = await _create_new_browser_tab()
                                    if new_tab:
                                        await asyncio.sleep(0.5)
                                        print("✅ [TabSelect] Post-check: escaped extension page → new tab")
                                break
    except Exception as _pc_err:
        print(f"⚠️ [TabSelect] Post-creation check (non-critical): {_pc_err}")

    # Get the WebSocket connection for real-time updates
    websocket = active_websockets.get(_current_automation_user)

    # Enable real-time step logging to WebSocket
    global websocket_log_handler
    if websocket:
        websocket_log_handler.set_websocket(websocket, _current_automation_user)

    history = None
    final_status = TaskStatus.FAILED
    error_list = []

    # Store agent instance so cancel/pause can call agent.stop() for real mid-step cancellation
    running_agents[actual_user_email] = agent

    try:
        # Run the agent - steps will be sent in real-time via logging handler
        history = await agent.run()

        # Check if agent was stopped (via agent.stop()) or cancellation flag
        if agent.state.stopped or (actual_user_email in cancellation_flags and cancellation_flags[actual_user_email]):
            print(f"⚠️ Task was cancelled/stopped by user: {actual_user_email}")
            final_status = TaskStatus.CANCELED
            error_list.append("Task cancelled by user")
        else:
            final_status = TaskStatus.SUCCESS

    except InterruptedError:
        # browser-use raises InterruptedError when agent.stop() is called
        print(f"⚠️ Task interrupted (stopped) for user: {actual_user_email}")
        final_status = TaskStatus.CANCELED
        error_list.append("Task stopped by user")

    except Exception as e:
        import traceback
        print(f"❌ Automation failed: {e}")
        print(f"❌ Full traceback:\n{traceback.format_exc()}")
        error_list.append(str(e))

        # Specific recovery for CDP disconnection errors
        if "no close frame" in str(e).lower() or "target closed" in str(e).lower():
            print("🔴 [Recovery] CDP connection lost — browser may have crashed or tab was destroyed.")
            print("🔴 [Recovery] Next task will reinitialize the browser session automatically (reset=True).")

        # Check if it was a cancellation
        if agent.state.stopped or (actual_user_email in cancellation_flags and cancellation_flags[actual_user_email]):
            final_status = TaskStatus.CANCELED
        else:
            final_status = TaskStatus.FAILED

    finally:
        # Remove agent instance from tracking
        if actual_user_email in running_agents:
            del running_agents[actual_user_email]

        # Remove from running tasks
        if actual_user_email in running_tasks:
            del running_tasks[actual_user_email]
        # Clear the WebSocket handler after automation completes
        websocket_log_handler.clear_websocket()

        # Track end time and duration
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()

        # Update automation history in database
        if history_id:
            try:
                final_result = history.final_result() if history else None
                urls = history.urls() if history else []
                errors = history.errors() if history else error_list

                # Combine errors
                all_errors = error_list + ([e for e in errors if e] if errors else [])

                await AutomationHistoryDB.update_status(
                    history_id=history_id,
                    status=final_status,
                    end_time=end_time,
                    duration_seconds=duration,
                    final_result=final_result,
                    errors=all_errors[:10]  # Limit to 10 errors
                )

                # Also update steps count and URLs
                from bson import ObjectId
                db = get_database()
                await db["automation_history"].update_one(
                    {"_id": ObjectId(history_id)},
                    {"$set": {
                        "steps_count": history.number_of_steps() if history else 0,
                        "urls_visited": urls[:20] if urls else []  # Limit to 20 URLs
                    }}
                )

                print(f"✅ Updated automation history record: {history_id}")

                # --- Notification logic based on user settings ---
                try:
                    settings = await get_user_settings(actual_user_email)
                    print(f"📋 User settings for {actual_user_email}: {settings}")

                    task_name_short = task[:100]
                    duration_str = f"{duration:.1f}s"

                    # 1. Email Notifications: send task completion email if enabled
                    if settings["email_notifications"]:
                        status_str = final_status.value if hasattr(final_status, 'value') else str(final_status)
                        send_task_notification_email(
                            to_email=actual_user_email,
                            task_name=task_name_short,
                            status=status_str,
                            duration=duration_str,
                            result_summary=final_result or ""
                        )
                        print(f"📧 Email notification sent (email_notifications=True)")
                    else:
                        print(f"📧 Email notification SKIPPED (email_notifications=False)")

                    # 2. Task Notifications: send WebSocket push if enabled
                    ws = active_websockets.get(actual_user_email)
                    if settings["task_notifications"] and ws:
                        status_str = final_status.value if hasattr(final_status, 'value') else str(final_status)
                        await safe_send_json(ws, {
                            "type": "task_notification",
                            "task_name": task_name_short,
                            "status": status_str,
                            "duration": duration_str,
                            "message": f"Task '{task_name_short}' {status_str}",
                            "timestamp": datetime.now().isoformat()
                        })
                        print(f"🔔 Task notification sent via WebSocket (task_notifications=True)")
                    else:
                        print(f"🔔 Task notification SKIPPED (task_notifications={settings['task_notifications']}, ws={'connected' if ws else 'none'})")

                    # 3. Error Alerts: send error email if enabled AND there are errors
                    if settings["error_alerts"] and all_errors:
                        send_error_alert_email(
                            to_email=actual_user_email,
                            task_name=task_name_short,
                            errors=all_errors
                        )
                        print(f"🚨 Error alert email sent (error_alerts=True, errors={len(all_errors)})")
                    elif all_errors:
                        print(f"🚨 Error alert email SKIPPED (error_alerts=False, errors={len(all_errors)})")

                except Exception as notif_error:
                    print(f"⚠️ Error sending notifications: {notif_error}")

            except Exception as e:
                print(f"⚠️ Could not update automation history: {e}")

    # Build result summary
    if history:
        result_summary = f"Task completed successfully!\n\n"
        result_summary += f"Final result: {history.final_result()}\n"
        result_summary += f"Steps executed: {history.number_of_steps()}\n"
        result_summary += f"Duration: {duration:.1f}s\n"

        if history.urls():
            result_summary += f"\nURLs visited:\n"
            for url in history.urls()[:3]:
                result_summary += f"  - {url}\n"

        if history.errors():
            result_summary += f"\nErrors encountered:\n"
            for error in history.errors():
                if error:
                    result_summary += f"  - {error}\n"
    else:
        result_summary = f"Task failed after {duration:.1f}s\n"
        if error_list:
            result_summary += f"\nErrors:\n"
            for error in error_list:
                result_summary += f"  - {error}\n"

    return result_summary


@function_tool
async def Automation(task: str) -> str:
    """
    Execute browser automation task.

    Args:
        task: The automation task to perform

    Returns:
        str: Result of the automation task
    """
    # Use the shared automation execution logic
    return await execute_automation_task(task)


# Create orchestrator agent
def create_orchestrator_agent():
    """Create the orchestrator agent with automation capabilities."""
    agent = OpenAIAgent(
        name="Automation Agent",
        instructions="""You are a helpful assistant that can perform automated tasks.

When a user asks you to do something that requires browser automation:
1. Always use the Automation tool to execute the task
2. Don't say things like "I can't do that" or "that's not possible" - try to help using the Automation tool
3. After receiving results from the Automation tool, provide a clear summary to the user
4. If there are errors, explain them clearly

You have access to browser automation that can:
- Navigate to websites
- Click buttons and links
- Fill out forms
- Extract information
- Take screenshots
- And much more

Always be helpful and proactive in using your automation capabilities.""",
        tools=[Automation],
    )
    return agent


@app.post("/chat")
async def chat(data: ChatRequest):
    """Non-streaming chat endpoint with orchestrator agent and MongoDB session memory"""
    user_msg = data.message
    user_email = data.user_email or "anonymous"

    # Create orchestrator agent
    agent = create_orchestrator_agent()

    # Create MongoDB session for this user
    session = create_session_for_user(user_email)

    try:
        # Run the orchestrator agent with session memory
        result = await Runner.run(agent, user_msg, session=session)

        return {
            "reply": result.final_output,
            "actions": [],
            "session_id": user_email,
            "user_email": user_email
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "reply": f"Error: {str(e)}",
            "actions": [],
            "session_id": user_email
        }
    finally:
        # Close the session connection
        await session.close()


async def safe_send_json(websocket: WebSocket, data: dict) -> bool:
    """
    Safely send JSON data through WebSocket with connection checking.

    Returns:
        bool: True if sent successfully, False if connection is closed
    """
    try:
        # Check if client is still connected
        if websocket.client_state.value == 1:  # CONNECTED state
            await websocket.send_json(data)
            print(f"✅ Sent WebSocket message: {data.get('type')} (step: {data.get('step_number', 'N/A')})")
            return True
        else:
            print(f"❌ WebSocket not connected (state: {websocket.client_state.value})")
            return False
    except Exception as e:
        # Connection closed or other error
        print(f"❌ Failed to send WebSocket message: {e}")
        return False


@app.websocket("/ws/chat/{user_email}")
async def websocket_chat(websocket: WebSocket, user_email: str):
    """
    WebSocket endpoint for streaming chat with orchestrator agent and MongoDB session memory.

    The user_email in the URL is used to identify and persist the conversation history.

    Streams real-time updates as the agent processes the task:
    - Agent thoughts and reasoning
    - Tool calls (Automation) and their results
    - Step-by-step progress
    - Final results
    """
    await websocket.accept()

    # Close stale WebSocket for this user if one exists (prevents collision
    # between sidebar and offscreen connections competing for the same slot).
    old_ws = active_websockets.get(user_email)
    if old_ws and old_ws != websocket:
        try:
            await old_ws.close()
            print(f"🔄 Closed stale WebSocket for {user_email}")
        except Exception:
            pass  # Already closed

    # Register this WebSocket for user input requests
    active_websockets[user_email] = websocket

    # Create MongoDB session for this user (persists across messages)
    session = None

    try:
        session = create_session_for_user(user_email)

        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message_data = json.loads(data)

            message_type = message_data.get("type", "message")

            # Handle different message types
            if message_type == "input_response":
                # User responded to an input request
                request_id = message_data.get("request_id")
                user_response = message_data.get("response", "")

                if request_id in pending_input_requests:
                    # Store the response
                    pending_input_requests[request_id]["response"] = user_response
                    # Signal that response is ready
                    pending_input_requests[request_id]["event"].set()

                continue  # Don't process as a regular message

            elif message_type == "cancel":
                # User requested to cancel the running automation
                cancellation_flags[user_email] = True

                # Call agent.stop() to halt execution before the next step
                agent_instance = running_agents.get(user_email)
                if agent_instance:
                    agent_instance.stop()
                    print(f"🛑 Agent.stop() called via WebSocket for user: {user_email}")

                # Send cancellation acknowledgment
                await safe_send_json(websocket, {
                    "type": "cancelled",
                    "message": "Cancellation requested - stopping automation...",
                    "timestamp": datetime.now().isoformat()
                })

                print(f"⚠️ User {user_email} requested cancellation")
                continue  # Don't process as a regular message

            user_message = message_data.get("message", "")

            if not user_message:
                continue

            # Set global user email for automation context
            global _current_automation_user
            _current_automation_user = user_email

            # Reset cancellation flag for this user
            cancellation_flags[user_email] = False

            # Create orchestrator agent
            agent = create_orchestrator_agent()

            # Send initial acknowledgment
            if not await safe_send_json(websocket, {
                "type": "start",
                "timestamp": datetime.now().isoformat(),
                "message": "Starting automation task...",
                "user_email": user_email
            }):
                break  # Client disconnected

            try:
                # Stream the agent execution
                step_number = 0
                current_tool_name = None
                message_buffer = ""
                final_output = None

                # --- Concurrent cancel listener ---
                # Listens for WebSocket messages (cancel, input_response) while streaming
                cancel_listener_active = True

                async def listen_for_cancel():
                    """Read WebSocket messages concurrently during streaming."""
                    nonlocal cancel_listener_active
                    try:
                        while cancel_listener_active:
                            data = await websocket.receive_text()
                            msg = json.loads(data)
                            msg_type = msg.get("type", "")

                            if msg_type == "cancel":
                                cancellation_flags[user_email] = True
                                agent_inst = running_agents.get(user_email)
                                if agent_inst:
                                    agent_inst.stop()
                                    print(f"🛑 Agent.stop() called via cancel listener for: {user_email}")
                                await safe_send_json(websocket, {
                                    "type": "cancelled",
                                    "message": "Cancellation requested - stopping automation...",
                                    "timestamp": datetime.now().isoformat()
                                })
                                print(f"⚠️ User {user_email} requested cancellation (during stream)")
                                break

                            elif msg_type == "input_response":
                                request_id = msg.get("request_id")
                                user_response = msg.get("response", "")
                                if request_id in pending_input_requests:
                                    pending_input_requests[request_id]["response"] = user_response
                                    pending_input_requests[request_id]["event"].set()

                    except Exception:
                        pass  # WebSocket closed or stream ended

                cancel_task = asyncio.create_task(listen_for_cancel())

                # Use Runner.run_streamed for streaming WITH SESSION MEMORY
                result = Runner.run_streamed(agent, user_message, session=session)

                async for event in result.stream_events():
                    # Check if client is still connected
                    if websocket.client_state.value != 1:
                        print(f"Client disconnected during streaming for {user_email}")
                        break

                    event_type = event.type

                    # Raw response events (text deltas - agent thinking)
                    if event_type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
                        delta_text = event.data.delta
                        message_buffer += delta_text

                        # Send thinking updates (streaming text, not as steps)
                        if not await safe_send_json(websocket, {
                            "type": "step",
                            "step_number": step_number if step_number > 0 else 1,
                            "step_type": "thinking",
                            "title": "Agent Thinking",
                            "content": message_buffer,
                            "delta": delta_text,
                            "timestamp": datetime.now().isoformat()
                        }):
                            break  # Client disconnected

                    # Run item stream events (higher level events)
                    elif event_type == "run_item_stream_event":
                        # Tool call started (Automation tool)
                        if event.item.type == "tool_call_item":
                            # Don't show "tool_start" - we'll show actual automation steps instead
                            # Just track that automation started
                            current_tool_name = getattr(event.item, 'name', None) or \
                                               getattr(event.item, 'function_name', None) or \
                                               'Automation'

                            # Send a simple notification that automation started
                            await safe_send_json(websocket, {
                                "type": "automation_started",
                                "timestamp": datetime.now().isoformat(),
                                "message": "Starting browser automation..."
                            })

                        # Tool call result - DON'T show generic result, automation steps will be sent separately
                        elif event.item.type == "tool_call_output_item":
                            # Automation completed - steps were already sent in real-time
                            # Just send completion notification
                            pass

                        # Final message output
                        elif event.item.type == "message_output_item":
                            step_number += 1
                            final_output = ItemHelpers.text_message_output(event.item)

                            if not await safe_send_json(websocket, {
                                "type": "step",
                                "step_number": step_number,
                                "step_type": "agent_finish",
                                "title": "Task Completed",
                                "content": final_output,
                                "timestamp": datetime.now().isoformat()
                            }):
                                break  # Client disconnected

                    # Agent updated event
                    elif event_type == "agent_updated_stream_event":
                        await safe_send_json(websocket, {
                            "type": "debug",
                            "event_type": "agent_updated",
                            "agent_name": event.new_agent.name,
                            "timestamp": datetime.now().isoformat()
                        })

                # Stop the cancel listener now that streaming is done
                cancel_listener_active = False
                cancel_task.cancel()

                # Send completion or cancellation message with the final output
                if not cancellation_flags.get(user_email):
                    await safe_send_json(websocket, {
                        "type": "complete",
                        "timestamp": datetime.now().isoformat(),
                        "message": "Automation task completed",
                        "final_output": final_output or message_buffer
                    })

                    # Check task_notifications setting for completion toast
                    try:
                        ws_settings = await get_user_settings(user_email)
                        if ws_settings["task_notifications"]:
                            await safe_send_json(websocket, {
                                "type": "task_notification",
                                "task_name": user_message[:100],
                                "status": "success",
                                "message": "Task completed successfully",
                                "timestamp": datetime.now().isoformat()
                            })
                    except Exception:
                        pass  # Don't break flow for notification settings
                else:
                    # Task was cancelled — send the final output so the extension
                    # can display it and trigger TTS with the actual agent message
                    cancelled_output = final_output or message_buffer
                    await safe_send_json(websocket, {
                        "type": "cancelled",
                        "timestamp": datetime.now().isoformat(),
                        "message": cancelled_output or "Task was cancelled."
                    })

            except Exception as e:
                # Stop the cancel listener on error too
                cancel_listener_active = False
                cancel_task.cancel()
                import traceback
                traceback.print_exc()

                # Send error message (only if still connected)
                await safe_send_json(websocket, {
                    "type": "error",
                    "error": str(e),
                    "timestamp": datetime.now().isoformat()
                })

                # Check error_alerts setting for error notification
                try:
                    ws_settings = await get_user_settings(user_email)
                    if ws_settings["error_alerts"]:
                        await safe_send_json(websocket, {
                            "type": "error_alert",
                            "task_name": user_message[:100],
                            "error": str(e),
                            "message": f"Error in task: {str(e)[:200]}",
                            "timestamp": datetime.now().isoformat()
                        })
                except Exception:
                    pass  # Don't break flow for notification settings

    except WebSocketDisconnect:
        print(f"WebSocket disconnected for user: {user_email}")
    except Exception as e:
        print(f"WebSocket error: {e}")
        import traceback
        traceback.print_exc()
        # Don't try to send on closed connection
    finally:
        # Mark any running task as cancelled when user disconnects
        if user_email in running_tasks:
            task_id = running_tasks[user_email]
            try:
                # Mark task as cancelled in database
                await AutomationHistoryDB.update_status(
                    history_id=task_id,
                    status=TaskStatus.CANCELED,
                    end_time=datetime.now(),
                    duration_seconds=(datetime.now() - datetime.now()).total_seconds(),
                    final_result="Task cancelled - user disconnected",
                    errors=["User closed browser or disconnected"]
                )
                print(f"✅ Marked task {task_id} as cancelled (user disconnected)")
            except Exception as e:
                print(f"⚠️ Error marking task as cancelled: {e}")

        # Remove WebSocket from active connections
        if user_email in active_websockets:
            del active_websockets[user_email]

        # Clean up cancellation flag
        if user_email in cancellation_flags:
            del cancellation_flags[user_email]

        # Clean up running tasks tracking
        if user_email in running_tasks:
            del running_tasks[user_email]

        # Close the session connection (only if it was created)
        if session:
            try:
                await session.close()
            except Exception as e:
                print(f"Error closing session: {e}")


@app.websocket("/ws/dashboard/{user_email}")
async def websocket_dashboard(websocket: WebSocket, user_email: str):
    """
    Lightweight WebSocket for dashboard real-time notifications.
    Receives scheduled task start/complete events pushed from the scheduler.
    """
    await websocket.accept()
    dashboard_websockets[user_email] = websocket
    print(f"📡 Dashboard WebSocket connected for: {user_email}")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get("type", "")

                if msg_type == "voice_command":
                    command = msg.get("command", "")
                    if command:
                        # Forward to the chat WebSocket for this user
                        chat_ws = active_websockets.get(user_email)
                        if chat_ws:
                            await safe_send_json(chat_ws, {
                                "type": "voice_command",
                                "message": command,
                                "source": "website_voice_assistant",
                                "timestamp": datetime.now().isoformat()
                            })
                            await safe_send_json(websocket, {
                                "type": "voice_command_status",
                                "status": "sent",
                                "message": "Command sent to extension"
                            })
                        else:
                            await safe_send_json(websocket, {
                                "type": "voice_command_status",
                                "status": "error",
                                "message": "Extension not connected. Please open the Chrome extension."
                            })
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        print(f"📡 Dashboard WebSocket disconnected for: {user_email}")
    except Exception as e:
        print(f"📡 Dashboard WebSocket error for {user_email}: {e}")
    finally:
        if user_email in dashboard_websockets:
            del dashboard_websockets[user_email]


@app.get("/static/whitelogo.png")
async def serve_logo():
    """Serve custom logo for browser automation loading screen"""
    logo_path = os.path.join(os.path.dirname(__file__), "whitelogo.png")
    if os.path.exists(logo_path):
        return FileResponse(logo_path)
    else:
        return {"error": "Logo file not found"}


@app.get("/health")
async def health_check():
    """Comprehensive health check endpoint for dashboard"""
    # Check browser connection
    browser_connected = False
    browser_status = "disconnected"

    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.get("http://localhost:9222/json/version", timeout=aiohttp.ClientTimeout(total=2)) as response:
                if response.status == 200:
                    browser_connected = True
                    browser_status = "connected"
    except Exception as e:
        browser_status = f"error: {str(e)}"

    # Check scheduler status
    scheduler = get_scheduler()
    scheduler_status = {
        "initialized": scheduler is not None,
        "running": scheduler.scheduler.running if scheduler else False,
        "active_jobs": len(scheduler.get_active_jobs()) if scheduler else 0
    }

    return {
        "status": "healthy" if browser_connected and scheduler_status["initialized"] else "degraded",
        "browser": {
            "connected": browser_connected,
            "status": browser_status,
            "cdp_url": "http://localhost:9222"
        },
        "scheduler": scheduler_status,
        "active_sessions": len(active_sessions),
        "ready_for_automation": browser_connected and scheduler_status["initialized"]
    }


@app.get("/browser/status")
async def browser_status():
    """Check browser CDP connection status"""
    try:
        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.get("http://localhost:9222/json/version") as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        "status": "connected",
                        "browser": data.get("Browser", "Unknown"),
                        "webSocketDebuggerUrl": data.get("webSocketDebuggerUrl", ""),
                        "message": "Browser is properly connected via CDP"
                    }
                else:
                    return {
                        "status": "error",
                        "message": f"CDP endpoint returned status {response.status}"
                    }
    except Exception as e:
        return {
            "status": "disconnected",
            "error": str(e),
            "message": "Cannot connect to Chrome CDP. Make sure Chrome is running with --remote-debugging-port=9222"
        }


@app.post("/api/scheduler/run-now")
async def run_task_now(request: Request):
    """Execute a scheduled task immediately via the scheduler's execute path (with WS notifications)"""
    try:
        data = await request.json()
        task_id = data.get("task_id")
        user_email = data.get("user_email")
        task_name = data.get("task_name", "Manual Run")
        automation_prompt = data.get("automation_prompt")
        frequency = data.get("frequency")

        if not automation_prompt:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "automation_prompt is required"}
            )

        print(f"🚀 Running scheduled task via scheduler: {task_name} for {user_email}")

        scheduler = get_scheduler()
        if scheduler:
            # Use scheduler's execute_scheduled_task which sends WS notifications
            asyncio.create_task(scheduler.execute_scheduled_task(
                task_id=task_id,
                user_email=user_email,
                task_name=task_name,
                automation_prompt=automation_prompt,
                frequency=frequency
            ))
        else:
            # Fallback: run directly if scheduler not available
            asyncio.create_task(execute_automation_task(automation_prompt, user_email=user_email))

        return JSONResponse(content={
            "success": True,
            "message": f"Task '{task_name}' started"
        })

    except Exception as e:
        print(f"❌ Error running task now: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/scheduler/remove")
async def remove_scheduler_task(request: Request):
    """Remove a task from the running scheduler (e.g., on delete or pause)"""
    try:
        data = await request.json()
        task_id = data.get("task_id")

        if not task_id:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "task_id is required"}
            )

        scheduler = get_scheduler()
        if not scheduler:
            return JSONResponse(
                status_code=503,
                content={"success": False, "error": "Scheduler not initialized"}
            )

        await scheduler.remove_scheduled_task(task_id)
        return JSONResponse(content={
            "success": True,
            "message": f"Task {task_id} removed from scheduler"
        })

    except Exception as e:
        print(f"Error removing task from scheduler: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/scheduler/cancel")
async def cancel_running_task(request: Request):
    """Cancel a currently running automation task by stopping the agent mid-execution"""
    try:
        data = await request.json()
        user_email = data.get("user_email")

        if not user_email:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "user_email is required"}
            )

        cancellation_flags[user_email] = True

        # Call agent.stop() to halt execution before the next step
        agent = running_agents.get(user_email)
        if agent:
            agent.stop()
            print(f"🛑 Agent.stop() called for user: {user_email} — execution will halt before next step")
        else:
            print(f"🛑 Cancellation flag set for user: {user_email} (no active agent found)")

        return JSONResponse(content={
            "success": True,
            "message": f"Cancellation requested for {user_email}"
        })

    except Exception as e:
        print(f"Error setting cancellation flag: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/scheduler/clear-cancel")
async def clear_cancellation_flag(request: Request):
    """Clear cancellation flag for a user (e.g., on resume)"""
    try:
        data = await request.json()
        user_email = data.get("user_email")

        if not user_email:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "user_email is required"}
            )

        if user_email in cancellation_flags:
            del cancellation_flags[user_email]
        print(f"✅ Cancellation flag cleared for user: {user_email}")

        return JSONResponse(content={
            "success": True,
            "message": f"Cancellation flag cleared for {user_email}"
        })

    except Exception as e:
        print(f"Error clearing cancellation flag: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/scheduler/reload")
async def reload_scheduler_task(request: Request):
    """Reload a specific task or all tasks in the scheduler"""
    try:
        data = await request.json()
        task_id = data.get("task_id")

        scheduler = get_scheduler()
        if not scheduler:
            return JSONResponse(
                status_code=503,
                content={"success": False, "error": "Scheduler not initialized"}
            )

        if task_id:
            # Load specific task
            from models import ScheduledTaskDB
            task = await ScheduledTaskDB.get_by_id(task_id)

            if task and task.get("is_active"):
                await scheduler.add_scheduled_task(task)
                return JSONResponse(content={
                    "success": True,
                    "message": f"Task {task_id} added to scheduler"
                })
            else:
                return JSONResponse(
                    status_code=404,
                    content={"success": False, "error": "Task not found or inactive"}
                )
        else:
            # Reload all tasks
            await scheduler.load_all_scheduled_tasks()
            return JSONResponse(content={
                "success": True,
                "message": "All scheduled tasks reloaded"
            })

    except Exception as e:
        print(f"Error reloading scheduler: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/voice-command")
async def handle_voice_command(request: Request):
    """Handle voice command from website dashboard - runs as automation task"""
    try:
        body = await request.json()
        user_email = body.get("user_email", "")
        command_text = body.get("command", "")

        if not user_email or not command_text:
            return JSONResponse(status_code=400, content={"error": "Missing user_email or command"})

        # Check if user already has a running task
        if user_email in running_tasks:
            return JSONResponse(status_code=409, content={"error": "A task is already running"})

        # Send the command to the extension via the chat WebSocket
        ws = active_websockets.get(user_email)
        if not ws:
            return JSONResponse(status_code=503, content={"error": "Extension not connected"})

        # Send as a regular chat message through the WebSocket
        # The extension's WebSocket handler will process it
        await safe_send_json(ws, {
            "type": "voice_command",
            "message": command_text,
            "source": "website_voice_assistant",
            "timestamp": datetime.now().isoformat()
        })

        return JSONResponse(content={"success": True, "message": "Voice command sent to extension"})

    except Exception as e:
        print(f"Error handling voice command: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})


async def cleanup_orphaned_tasks():
    """
    Clean up any tasks that were left in 'running' state due to crashes or unexpected shutdowns.
    These tasks should be marked as 'canceled' since they didn't complete normally.
    """
    try:
        from models import get_database
        from bson import ObjectId

        db = get_database()

        # Find all tasks still marked as "running"
        result = await db["automation_history"].update_many(
            {"status": TaskStatus.RUNNING},
            {"$set": {
                "status": TaskStatus.CANCELED,
                "end_time": datetime.now(),
                "final_result": "Task cancelled - server restarted or browser closed"
            }}
        )

        if result.modified_count > 0:
            print(f"✅ Cleaned up {result.modified_count} orphaned running tasks")

    except Exception as e:
        print(f"⚠️ Error cleaning up orphaned tasks: {e}")


if __name__ == "__main__":
    os.environ["BROWSER_USE_TELEMETRY"] = "0"

    # FastAPI server with auto-reload (pass as import string for reload to work)
    uvicorn.run("agent_server:app", host="127.0.0.1", port=5005, reload=True)
