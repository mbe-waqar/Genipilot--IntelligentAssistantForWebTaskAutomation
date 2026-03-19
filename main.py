"""
FastAPI Backend with Session-Based Authentication
Supports both website (HTML) and browser extension (JSON API)
Uses pymongo (synchronous) for simplicity
"""

from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
import secrets
from contextlib import asynccontextmanager
from typing import Optional, List
import os
from dotenv import load_dotenv
import random
import string
from datetime import datetime, timedelta
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# Load environment variables
load_dotenv()


# Helper function to serialize datetime objects for JSON
def serialize_datetime(obj):
    """Convert datetime objects to ISO format strings for JSON serialization"""
    if isinstance(obj, datetime):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {key: serialize_datetime(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [serialize_datetime(item) for item in obj]
    return obj


# Lifespan context manager for startup and shutdown events
@asynccontextmanager
async def lifespan(app):
    """Handle startup and shutdown events"""
    # STARTUP
    global mongo_client, db
    try:
        mongo_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
        db = mongo_client[DATABASE_NAME]

        # Test connection
        mongo_client.server_info()

        # Create unique index on email field for users
        db[USERS_COLLECTION].create_index("email", unique=True)

        # Create index on email and expiration for verification codes
        db[VERIFICATION_CODES_COLLECTION].create_index("email")
        db[VERIFICATION_CODES_COLLECTION].create_index("expires_at", expireAfterSeconds=0)

        print(f"✓ Connected to MongoDB: {DATABASE_NAME}")

        # Print Google OAuth config for debugging
        if GOOGLE_CLIENT_ID:
            print(f"✓ Google OAuth configured: {GOOGLE_CLIENT_ID[:20]}...{GOOGLE_CLIENT_ID[-20:]}")
        else:
            print(f"⚠️ WARNING: GOOGLE_CLIENT_ID is not set in .env file")

    except Exception as e:
        print(f"✗ Failed to connect to MongoDB: {e}")
        print(f"  Make sure MongoDB is running at {MONGO_URL}")
        db = None

    yield  # App runs here

    # SHUTDOWN
    if mongo_client:
        mongo_client.close()
        print("✓ MongoDB connection closed")


# Initialize FastAPI app
app = FastAPI(title="MyApp - Authentication System", lifespan=lifespan)

# Add session middleware with a secure secret key
SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_urlsafe(32))
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)

# Email Configuration
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/api/auth/google/callback")


# ============================================================================
# Cache Control Middleware (Disable caching in development)
# ============================================================================

class NoCacheMiddleware(BaseHTTPMiddleware):
    """Middleware to disable caching for development"""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Add no-cache headers to prevent browser caching during development
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

# Add the no-cache middleware (COMMENT THIS OUT IN PRODUCTION!)
app.add_middleware(NoCacheMiddleware)

# Setup Jinja2 templates
templates = Jinja2Templates(directory="templates")

# MongoDB connection settings
MONGO_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017/")
DATABASE_NAME = os.getenv("DATABASE_NAME", "myapp")
USERS_COLLECTION = "users"
VERIFICATION_CODES_COLLECTION = "verification_codes"

# MongoDB client (synchronous)
mongo_client = None
db = None

# Password hasher using argon2
ph = PasswordHasher()


# ============================================================================
# Pydantic Models for Validation
# ============================================================================

class UserSignup(BaseModel):
    """User signup schema with validation"""
    username: str = Field(..., min_length=3, max_length=50, alias='name')
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)

    model_config = ConfigDict(populate_by_name=True)  # Allow both 'username' and 'name'

    @field_validator('username')
    @classmethod
    def username_alphanumeric(cls, v):
        """Ensure username contains only alphanumeric characters and underscores"""
        if not v.replace('_', '').replace('-', '').replace(' ', '').isalnum():
            raise ValueError('Username must contain only letters, numbers, underscores, and hyphens')
        return v

    @field_validator('password')
    @classmethod
    def password_strength(cls, v):
        """Validate password strength"""
        if len(v) < 8:
            raise ValueError('Password must be at least 8 characters long')
        # Relaxed validation - just check length
        return v


class UserLogin(BaseModel):
    """User login schema"""
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=128)


class EmailVerification(BaseModel):
    """Email verification schema"""
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)


class GoogleAuthRequest(BaseModel):
    """Google OAuth token schema"""
    credential: str  # JWT token from Google


# ============================================================================
# Database Connection Events
# ============================================================================



# ============================================================================
# Authentication Helper Functions
# ============================================================================

def get_current_user(request: Request) -> Optional[dict]:
    """Get current logged-in user from session"""
    user_email = request.session.get("user_email")
    if user_email:
        return {"email": user_email}
    return None


def hash_password(password: str) -> str:
    """Hash password using argon2"""
    return ph.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    """Verify password against hash"""
    try:
        ph.verify(hashed_password, password)
        return True
    except VerifyMismatchError:
        return False


def generate_verification_code() -> str:
    """Generate a 6-digit verification code"""
    return ''.join(random.choices(string.digits, k=6))


def send_verification_email(email: str, code: str) -> bool:
    """Send verification code via email"""
    try:
        # Create message
        msg = MIMEMultipart('alternative')
        msg['Subject'] = 'Email Verification Code'
        msg['From'] = SMTP_FROM
        msg['To'] = email

        # HTML email body
        html = f"""
        <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 5px;">
              <h2 style="color: #4285F4;">Email Verification</h2>
              <p>Thank you for signing up! Please use the following code to verify your email address:</p>
              <div style="background-color: #f4f4f4; padding: 15px; margin: 20px 0; text-align: center; border-radius: 5px;">
                <h1 style="color: #4285F4; margin: 0; font-size: 32px; letter-spacing: 5px;">{code}</h1>
              </div>
              <p>This code will expire in 10 minutes.</p>
              <p>If you didn't request this code, please ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
              <p style="color: #999; font-size: 12px;">This is an automated email. Please do not reply.</p>
            </div>
          </body>
        </html>
        """

        # Plain text alternative
        text = f"""
        Email Verification

        Thank you for signing up! Please use the following code to verify your email address:

        {code}

        This code will expire in 10 minutes.

        If you didn't request this code, please ignore this email.
        """

        # Attach both versions
        msg.attach(MIMEText(text, 'plain'))
        msg.attach(MIMEText(html, 'html'))

        # Send email - handle both SSL (465) and TLS (587) ports
        if SMTP_PORT == 465:
            # Use SSL for port 465
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            # Use STARTTLS for port 587
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)

        print(f"✓ Verification email sent to {email}")
        return True

    except Exception as e:
        print(f"✗ Failed to send email: {e}")
        return False


def store_verification_code(email: str, code: str):
    """Store verification code in database with expiration"""
    expires_at = datetime.utcnow() + timedelta(minutes=10)

    verification_doc = {
        "email": email,
        "code": code,
        "expires_at": expires_at,
        "created_at": datetime.utcnow(),
        "verified": False
    }

    # Delete any existing codes for this email
    db[VERIFICATION_CODES_COLLECTION].delete_many({"email": email})

    # Insert new code
    db[VERIFICATION_CODES_COLLECTION].insert_one(verification_doc)
    print(f"✓ Verification code stored for {email}")


def verify_code(email: str, code: str) -> bool:
    """Verify the code for given email"""
    verification = db[VERIFICATION_CODES_COLLECTION].find_one({
        "email": email,
        "code": code,
        "verified": False,
        "expires_at": {"$gt": datetime.utcnow()}
    })

    if verification:
        # Mark as verified
        db[VERIFICATION_CODES_COLLECTION].update_one(
            {"_id": verification["_id"]},
            {"$set": {"verified": True}}
        )
        return True

    return False


# ============================================================================
# Static File Routes (for auth.css and auth.js in templates root)
# ============================================================================

@app.get("/auth.css")
def serve_auth_css():
    """Serve auth.css from templates directory"""
    return FileResponse("templates/auth.css", media_type="text/css")


@app.get("/auth.js")
def serve_auth_js():
    """Serve auth.js from templates directory"""
    return FileResponse("templates/auth.js", media_type="application/javascript")


# ============================================================================
# Website Routes (HTML Responses)
# ============================================================================

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    """Render home/index page"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/index.html", response_class=HTMLResponse)
def index_html(request: Request):
    """Render index page (alternate route)"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/about-us", response_class=HTMLResponse)
@app.get("/about-us.html", response_class=HTMLResponse)
def about_us(request: Request):
    """Render about us page"""
    return templates.TemplateResponse("about-us.html", {"request": request})


@app.get("/automation", response_class=HTMLResponse)
@app.get("/automation.html", response_class=HTMLResponse)
@app.get("/services", response_class=HTMLResponse)  # Keep old route for backwards compatibility
@app.get("/services.html", response_class=HTMLResponse)  # Keep old route for backwards compatibility
def automation(request: Request):
    """Render automation page"""
    return templates.TemplateResponse("automation.html", {"request": request})


@app.get("/integrations", response_class=HTMLResponse)
@app.get("/integrations.html", response_class=HTMLResponse)
def integrations(request: Request):
    """Render integrations page"""
    return templates.TemplateResponse("integrations.html", {"request": request})


@app.get("/pricing", response_class=HTMLResponse)
@app.get("/pricing.html", response_class=HTMLResponse)
def pricing(request: Request):
    """Render pricing page"""
    return templates.TemplateResponse("pricing.html", {"request": request})


@app.get("/faqs", response_class=HTMLResponse)
@app.get("/faqs.html", response_class=HTMLResponse)
def faqs(request: Request):
    """Render FAQs page"""
    return templates.TemplateResponse("faqs.html", {"request": request})


@app.get("/contact", response_class=HTMLResponse)
@app.get("/contact.html", response_class=HTMLResponse)
def contact(request: Request):
    """Render contact page"""
    return templates.TemplateResponse("contact.html", {"request": request})


@app.get("/signup", response_class=HTMLResponse)
@app.get("/signup.html", response_class=HTMLResponse)
def signup_page(request: Request):
    """Render signup page"""
    # If user is already logged in, redirect to dashboard
    user = get_current_user(request)
    if user:
        return RedirectResponse(url="/dashboard", status_code=302)

    return templates.TemplateResponse("signup.html", {"request": request})


@app.post("/signup")
@app.post("/signup.html")
def signup_user(
    request: Request,
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...)
):
    """Handle user signup from website form - sends verification code"""
    print(f"DEBUG: Signup POST received - name={name}, email={email}")

    # Check if database is connected
    if db is None:
        print("ERROR: Database not connected")
        return templates.TemplateResponse(
            "signup.html",
            {"request": request, "error": "Database connection error. Please try again later."}
        )

    try:
        # Validate input using Pydantic model
        user_data = UserSignup(username=name, email=email, password=password)
        print(f"DEBUG: Validation passed for {email}")

        # Check if user already exists
        existing_user = db[USERS_COLLECTION].find_one({"email": user_data.email})
        if existing_user:
            print(f"DEBUG: User {email} already exists")
            return templates.TemplateResponse(
                "signup.html",
                {"request": request, "error": "Email already registered"}
            )

        # Hash the password
        hashed_pw = hash_password(user_data.password)
        print(f"DEBUG: Password hashed for {email}")

        # Create user document (unverified)
        user_doc = {
            "username": user_data.username,
            "email": user_data.email,
            "password": hashed_pw,
            "email_verified": False,
            "created_at": datetime.utcnow(),
            "settings": {
                "email_notifications": False,
                "task_notifications": False,
                "error_alerts": False
            }
        }

        # Insert user into database
        try:
            result = db[USERS_COLLECTION].insert_one(user_doc)

            if result.inserted_id:
                print(f"✓ User created (unverified): {user_data.email} (ID: {result.inserted_id})")

                # Email verification enabled
                SKIP_EMAIL_VERIFICATION = False  # Set to True to skip email verification

                if SKIP_EMAIL_VERIFICATION:
                    # Auto-verify user for development
                    db[USERS_COLLECTION].update_one(
                        {"_id": result.inserted_id},
                        {"$set": {"email_verified": True}}
                    )

                    # Log them in directly
                    request.session["user_email"] = user_data.email
                    request.session["username"] = user_data.username

                    print(f"⚠️ DEV MODE: User auto-verified (email verification skipped)")

                    # Redirect to dashboard
                    return RedirectResponse(url="/dashboard", status_code=303)
                else:
                    # Generate and send verification code
                    verification_code = generate_verification_code()
                    store_verification_code(user_data.email, verification_code)

                    # Send verification email
                    email_sent = send_verification_email(user_data.email, verification_code)

                    if email_sent:
                        # Store email in session for verification page
                        request.session["pending_verification_email"] = user_data.email

                        # Render signup page with success message (will trigger modal)
                        return templates.TemplateResponse(
                            "signup.html",
                            {
                                "request": request,
                                "verification_required": True,
                                "user_email": user_data.email
                            }
                        )
                    else:
                        # If email failed, delete the user and show error
                        db[USERS_COLLECTION].delete_one({"_id": result.inserted_id})
                        return templates.TemplateResponse(
                            "signup.html",
                            {"request": request, "error": "Failed to send verification email. Please check your email configuration."}
                        )
            else:
                print(f"ERROR: Failed to create user {email}")
                return templates.TemplateResponse(
                    "signup.html",
                    {"request": request, "error": "Failed to create user"}
                )
        except DuplicateKeyError:
            print(f"DEBUG: Duplicate key error for {email}")
            return templates.TemplateResponse(
                "signup.html",
                {"request": request, "error": "Email already registered"}
            )

    except ValueError as e:
        # Validation error
        print(f"ERROR: Validation error - {str(e)}")
        return templates.TemplateResponse(
            "signup.html",
            {"request": request, "error": str(e)}
        )
    except Exception as e:
        print(f"✗ Signup error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return templates.TemplateResponse(
            "signup.html",
            {"request": request, "error": f"An error occurred: {str(e)}"}
        )


@app.post("/api/signup")
async def api_signup_user(request: Request):
    """Handle user signup from API (JSON) - sends verification code"""
    # First, let's see what raw data we're receiving
    try:
        raw_body = await request.json()
        print(f"DEBUG: Raw JSON received: {raw_body}")
    except Exception as e:
        print(f"ERROR: Failed to parse JSON: {e}")
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Invalid JSON"}
        )

    # Now parse with Pydantic
    try:
        user_data = UserSignup(**raw_body)
        print(f"DEBUG: API Signup received - username={user_data.username}, email={user_data.email}")
    except Exception as e:
        print(f"ERROR: Validation failed: {e}")
        return JSONResponse(
            status_code=422,
            content={"success": False, "error": str(e)}
        )

    # Check if database is connected
    if db is None:
        print("ERROR: Database not connected")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        # Check if user already exists
        existing_user = db[USERS_COLLECTION].find_one({"email": user_data.email})
        if existing_user:
            print(f"DEBUG: User {user_data.email} already exists")
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email already registered"}
            )

        # Hash the password
        hashed_pw = hash_password(user_data.password)
        print(f"DEBUG: Password hashed for {user_data.email}")

        # Create user document (unverified)
        user_doc = {
            "username": user_data.username,
            "email": user_data.email,
            "password": hashed_pw,
            "email_verified": False,
            "created_at": datetime.utcnow(),
            "settings": {
                "email_notifications": False,
                "task_notifications": False,
                "error_alerts": False
            }
        }

        # Insert user into database
        try:
            result = db[USERS_COLLECTION].insert_one(user_doc)

            if result.inserted_id:
                print(f"✓ User created (unverified) via API: {user_data.email} (ID: {result.inserted_id})")

                # Generate and send verification code
                verification_code = generate_verification_code()
                store_verification_code(user_data.email, verification_code)

                # Email verification enabled
                SKIP_EMAIL_VERIFICATION = False  # Set to True to skip email verification

                if SKIP_EMAIL_VERIFICATION:
                    # Auto-verify user for development
                    db[USERS_COLLECTION].update_one(
                        {"_id": result.inserted_id},
                        {"$set": {"email_verified": True}}
                    )

                    # Log them in directly
                    request.session["user_email"] = user_data.email
                    request.session["username"] = user_data.username

                    print(f"⚠️ DEV MODE: User auto-verified (email verification skipped)")

                    return JSONResponse(
                        content={
                            "success": True,
                            "message": "Account created successfully",
                            "redirect": "/dashboard"
                        }
                    )
                else:
                    # Send verification email
                    email_sent = send_verification_email(user_data.email, verification_code)

                    if email_sent:
                        # Store email in session for verification
                        request.session["pending_verification_email"] = user_data.email

                        # Return success JSON with verification required flag
                        return JSONResponse(
                            content={
                                "success": True,
                                "message": "Verification code sent to your email",
                                "verification_required": True,
                                "email": user_data.email
                            }
                        )
                    else:
                        # If email failed, delete the user and show error
                        db[USERS_COLLECTION].delete_one({"_id": result.inserted_id})
                        return JSONResponse(
                            status_code=500,
                            content={"success": False, "error": "Failed to send verification email"}
                        )
            else:
                print(f"ERROR: Failed to create user {user_data.email}")
                return JSONResponse(
                    status_code=500,
                    content={"success": False, "error": "Failed to create user"}
                )
        except DuplicateKeyError:
            print(f"DEBUG: Duplicate key error for {user_data.email}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email already registered"}
            )

    except ValueError as e:
        print(f"ERROR: Validation error - {str(e)}")
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": str(e)}
        )
    except Exception as e:
        print(f"✗ API Signup error: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"An error occurred: {str(e)}"}
        )


@app.get("/login", response_class=HTMLResponse)
@app.get("/login.html", response_class=HTMLResponse)
def login_page(request: Request):
    """Render login page"""
    # If user is already logged in, redirect to dashboard
    user = get_current_user(request)
    if user:
        return RedirectResponse(url="/dashboard", status_code=302)

    return templates.TemplateResponse("login.html", {"request": request})


@app.post("/login")
@app.post("/login.html")
def login_user(
    request: Request,
    email: str = Form(...),
    password: str = Form(...)
):
    """Handle user login from website form"""
    print(f"DEBUG: Login POST received - email={email}")

    # Check if database is connected
    if db is None:
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": "Database connection error. Please try again later."}
        )

    try:
        # Validate input
        login_data = UserLogin(email=email, password=password)

        # Find user in database
        user = db[USERS_COLLECTION].find_one({"email": login_data.email})

        if not user:
            print(f"DEBUG: User {email} not found")
            return templates.TemplateResponse(
                "login.html",
                {"request": request, "error": "Invalid email or password"}
            )

        # Verify password
        is_valid = verify_password(login_data.password, user["password"])

        if not is_valid:
            print(f"DEBUG: Invalid password for {email}")
            return templates.TemplateResponse(
                "login.html",
                {"request": request, "error": "Invalid email or password"}
            )

        # Set session
        request.session["user_email"] = user["email"]
        request.session["username"] = user.get("username", "User")

        print(f"✓ User logged in: {user['email']}")

        # Redirect to dashboard
        return RedirectResponse(url="/dashboard", status_code=303)

    except Exception as e:
        print(f"✗ Login error: {e}")
        return templates.TemplateResponse(
            "login.html",
            {"request": request, "error": f"An error occurred: {str(e)}"}
        )


@app.post("/api/login")
def api_login_user(request: Request, credentials: UserLogin):
    """Handle user login from API (JSON)"""
    print(f"DEBUG: API Login received - email={credentials.email}")

    # Check if database is connected
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        # Validate input
        # Find user in database
        user = db[USERS_COLLECTION].find_one({"email": credentials.email})

        if not user:
            print(f"DEBUG: User {credentials.email} not found")
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Invalid email or password"}
            )

        # Verify password
        is_valid = verify_password(credentials.password, user["password"])

        if not is_valid:
            print(f"DEBUG: Invalid password for {credentials.email}")
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Invalid email or password"}
            )

        # Set session
        request.session["user_email"] = user["email"]
        request.session["username"] = user.get("username", "User")

        print(f"✓ User logged in via API: {user['email']}")

        # Extract first name from username
        username = user.get("username", "User")
        first_name = username.split()[0] if username else "User"

        # Return success JSON with user data
        return JSONResponse(
            content={
                "success": True,
                "message": "Login successful",
                "redirect": "/dashboard",
                "user": {
                    "email": user["email"],
                    "username": username,
                    "firstName": first_name
                }
            }
        )

    except Exception as e:
        print(f"✗ API Login error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"An error occurred: {str(e)}"}
        )


@app.post("/api/verify-email")
def verify_email(request: Request, verification: EmailVerification):
    """Verify email with code"""
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        # Verify the code
        is_valid = verify_code(verification.email, verification.code)

        if is_valid:
            # Update user as verified
            result = db[USERS_COLLECTION].update_one(
                {"email": verification.email},
                {"$set": {"email_verified": True}}
            )

            if result.modified_count > 0:
                # Get the user
                user = db[USERS_COLLECTION].find_one({"email": verification.email})

                # Set session
                request.session["user_email"] = user["email"]
                request.session["username"] = user.get("username", "User")

                # Clear pending verification
                request.session.pop("pending_verification_email", None)

                print(f"✓ Email verified for {verification.email}")

                return JSONResponse(
                    content={
                        "success": True,
                        "message": "Email verified successfully",
                        "redirect": "/dashboard"
                    }
                )
            else:
                return JSONResponse(
                    status_code=400,
                    content={"success": False, "error": "User not found"}
                )
        else:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Invalid or expired verification code"}
            )

    except Exception as e:
        print(f"✗ Verification error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"An error occurred: {str(e)}"}
        )


@app.post("/api/resend-verification")
def resend_verification(request: Request, email_data: dict):
    """Resend verification code"""
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        email = email_data.get("email")
        if not email:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email is required"}
            )

        # Check if user exists
        user = db[USERS_COLLECTION].find_one({"email": email})
        if not user:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "User not found"}
            )

        # Check if already verified
        if user.get("email_verified", False):
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email already verified"}
            )

        # Generate and send new code
        verification_code = generate_verification_code()
        store_verification_code(email, verification_code)

        email_sent = send_verification_email(email, verification_code)

        if email_sent:
            return JSONResponse(
                content={
                    "success": True,
                    "message": "Verification code resent successfully"
                }
            )
        else:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "Failed to send email"}
            )

    except Exception as e:
        print(f"✗ Resend verification error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"An error occurred: {str(e)}"}
        )


@app.post("/api/auth/google")
async def google_auth(request: Request, auth_request: GoogleAuthRequest):
    """Handle Google OAuth authentication"""
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        # Check if Google Client ID is configured
        if not GOOGLE_CLIENT_ID:
            print(f"✗ Google OAuth error: GOOGLE_CLIENT_ID not configured")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "Google OAuth not configured on server"}
            )

        print(f"DEBUG: Verifying Google token...")
        print(f"DEBUG: Client ID: {GOOGLE_CLIENT_ID[:20]}...{GOOGLE_CLIENT_ID[-20:]}")

        # Verify the Google token
        idinfo = id_token.verify_oauth2_token(
            auth_request.credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )

        print(f"✓ Google token verified successfully")

        # Get user info from Google
        google_user_id = idinfo['sub']
        email = idinfo['email']
        name = idinfo.get('name', email.split('@')[0])
        email_verified = idinfo.get('email_verified', False)

        print(f"DEBUG: Google auth - email={email}, verified={email_verified}")

        # Check if user already exists
        user = db[USERS_COLLECTION].find_one({"email": email})

        if user:
            # User exists, just log them in
            request.session["user_email"] = user["email"]
            request.session["username"] = user.get("username", name)

            print(f"✓ Google login: {email}")

            return JSONResponse(
                content={
                    "success": True,
                    "message": "Login successful",
                    "redirect": "/dashboard",
                    "user": {
                        "email": user["email"],
                        "username": user.get("username", name)
                    }
                }
            )
        else:
            # User doesn't exist - require signup first
            print(f"✗ Google login failed: Account not found for {email}")

            return JSONResponse(
                status_code=404,
                content={
                    "success": False,
                    "error": "Account not found. Please sign up first.",
                    "redirect": "/signup"
                }
            )

    except ValueError as e:
        # Invalid token
        error_msg = str(e)
        print(f"✗ Google auth ValueError: {error_msg}")

        # Provide more specific error messages
        if "Token used too late" in error_msg:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Google token expired. Please try again."}
            )
        elif "Wrong recipient" in error_msg or "audience" in error_msg.lower():
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Google Client ID mismatch. Please check configuration."}
            )
        else:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": f"Invalid Google token: {error_msg}"}
            )
    except Exception as e:
        print(f"✗ Google auth Exception: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Authentication error: {str(e)}"}
        )


@app.post("/api/auth/google/signup")
async def google_signup(request: Request, auth_request: GoogleAuthRequest):
    """Handle Google OAuth signup - creates new account"""
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        # Check if Google Client ID is configured
        if not GOOGLE_CLIENT_ID:
            print(f"✗ Google OAuth error: GOOGLE_CLIENT_ID not configured")
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "Google OAuth not configured on server"}
            )

        print(f"DEBUG: Verifying Google signup token...")

        # Verify the Google token
        idinfo = id_token.verify_oauth2_token(
            auth_request.credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID
        )

        print(f"✓ Google token verified successfully for signup")

        # Get user info from Google
        google_user_id = idinfo['sub']
        email = idinfo['email']
        name = idinfo.get('name', email.split('@')[0])
        email_verified = idinfo.get('email_verified', False)

        print(f"DEBUG: Google signup - email={email}, verified={email_verified}")

        # Check if user already exists
        user = db[USERS_COLLECTION].find_one({"email": email})

        if user:
            # User already exists
            print(f"✗ Google signup failed: Account already exists for {email}")
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "error": "Account already exists. Please login instead.",
                    "redirect": "/login"
                }
            )
        else:
            # Create new user
            user_doc = {
                "username": name,
                "email": email,
                "password": None,  # No password for OAuth users
                "email_verified": email_verified,
                "google_id": google_user_id,
                "auth_provider": "google",
                "created_at": datetime.utcnow(),
                "settings": {
                    "email_notifications": False,
                    "task_notifications": False,
                    "error_alerts": False
                }
            }

            result = db[USERS_COLLECTION].insert_one(user_doc)

            if result.inserted_id:
                # Log them in
                request.session["user_email"] = email
                request.session["username"] = name

                print(f"✓ New Google user created via signup: {email}")

                return JSONResponse(
                    content={
                        "success": True,
                        "message": "Account created successfully",
                        "redirect": "/dashboard",
                        "user": {
                            "email": email,
                            "username": name
                        }
                    }
                )
            else:
                return JSONResponse(
                    status_code=500,
                    content={"success": False, "error": "Failed to create user"}
                )

    except ValueError as e:
        # Invalid token
        error_msg = str(e)
        print(f"✗ Google signup ValueError: {error_msg}")

        if "Token used too late" in error_msg:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Google token expired. Please try again."}
            )
        else:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": f"Invalid Google token: {error_msg}"}
            )
    except Exception as e:
        print(f"✗ Google signup Exception: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Signup error: {str(e)}"}
        )


@app.post("/api/auth/google/token")
async def google_auth_token(request: Request, user_info: dict):
    """Handle Google OAuth from Chrome extension (receives user info directly)"""
    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        email = user_info.get('email')
        name = user_info.get('name', email.split('@')[0] if email else 'User')
        google_id = user_info.get('google_id')
        email_verified = user_info.get('email_verified', False)

        if not email:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email is required"}
            )

        print(f"DEBUG: Extension Google auth - email={email}, verified={email_verified}")

        # Check if user already exists
        user = db[USERS_COLLECTION].find_one({"email": email})

        if user:
            # User exists, just log them in
            request.session["user_email"] = user["email"]
            request.session["username"] = user.get("username", name)

            print(f"✓ Extension Google login: {email}")

            return JSONResponse(
                content={
                    "success": True,
                    "message": "Login successful",
                    "user": {
                        "email": user["email"],
                        "username": user.get("username", name)
                    }
                }
            )
        else:
            # User doesn't exist - require signup first
            print(f"✗ Extension Google login failed: Account not found for {email}")

            return JSONResponse(
                status_code=404,
                content={
                    "success": False,
                    "error": "Account not found. Please sign up first.",
                    "redirect_to_signup": True
                }
            )

    except Exception as e:
        print(f"✗ Extension Google auth error: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Authentication error: {str(e)}"}
        )


@app.get("/dashboard", response_class=HTMLResponse)
@app.get("/dashboard.html", response_class=HTMLResponse)
def dashboard(request: Request):
    """Render dashboard page (requires authentication)"""
    user = get_current_user(request)

    # If not logged in, redirect to signup
    if not user:
        return RedirectResponse(url="/signup", status_code=302)

    # Get username from session
    username = request.session.get("username", "User")

    return templates.TemplateResponse(
        "dashboard.html",
        {"request": request, "username": username, "email": user["email"]}
    )


@app.get("/logout")
def logout(request: Request):
    """Logout user and clear session"""
    request.session.clear()
    return RedirectResponse(url="/", status_code=302)


# ============================================================================
# Browser Extension API Routes (JSON Responses)
# ============================================================================

@app.post("/ext/login")
def ext_login(request: Request, credentials: UserLogin):
    """Extension login endpoint - accepts JSON"""

    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        user = db[USERS_COLLECTION].find_one({"email": credentials.email})

        if not user:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Invalid email or password"}
            )

        is_valid = verify_password(credentials.password, user["password"])

        if not is_valid:
            return JSONResponse(
                status_code=401,
                content={"success": False, "error": "Invalid email or password"}
            )

        request.session["user_email"] = user["email"]
        request.session["username"] = user.get("username", "User")

        return JSONResponse(
            content={
                "success": True,
                "message": "Login successful",
                "user": {
                    "email": user["email"],
                    "username": user.get("username", "User")
                }
            }
        )

    except Exception as e:
        print(f"✗ Extension login error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Server error: {str(e)}"}
        )


@app.get("/ext/chat")
def ext_chat(request: Request):
    """Extension chat endpoint - requires valid session"""
    user = get_current_user(request)

    if not user:
        return JSONResponse(
            status_code=401,
            content={"error": "Not logged in"}
        )

    return JSONResponse(
        content={
            "success": True,
            "message": "Chat endpoint accessed successfully",
            "user": user,
            "data": {
                "chats": [
                    {"id": 1, "message": "Welcome to the chat!", "timestamp": "2025-11-16 10:00"},
                    {"id": 2, "message": "How can I help you today?", "timestamp": "2025-11-16 10:01"}
                ]
            }
        }
    )


@app.post("/ext/signup")
def ext_signup(request: Request, user_data: UserSignup):
    """Extension signup endpoint - sends verification code"""

    if db is None:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Database connection error"}
        )

    try:
        existing_user = db[USERS_COLLECTION].find_one({"email": user_data.email})
        if existing_user:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Email already registered"}
            )

        hashed_pw = hash_password(user_data.password)

        user_doc = {
            "username": user_data.username,
            "email": user_data.email,
            "password": hashed_pw,
            "email_verified": False,
            "created_at": datetime.utcnow(),
            "settings": {
                "email_notifications": False,
                "task_notifications": False,
                "error_alerts": False
            }
        }

        result = db[USERS_COLLECTION].insert_one(user_doc)

        if result.inserted_id:
            # Email verification enabled
            SKIP_EMAIL_VERIFICATION = False  # Set to True to skip email verification

            if SKIP_EMAIL_VERIFICATION:
                # Auto-verify user for development
                db[USERS_COLLECTION].update_one(
                    {"_id": result.inserted_id},
                    {"$set": {"email_verified": True}}
                )

                # Log them in
                request.session["user_email"] = user_data.email
                request.session["username"] = user_data.username

                print(f"⚠️ DEV MODE: User auto-verified (email verification skipped)")

                return JSONResponse(
                    content={
                        "success": True,
                        "message": "Account created successfully",
                        "user": {
                            "email": user_data.email,
                            "username": user_data.username
                        }
                    }
                )
            else:
                # Generate and send verification code
                verification_code = generate_verification_code()
                store_verification_code(user_data.email, verification_code)

                email_sent = send_verification_email(user_data.email, verification_code)

                if email_sent:
                    request.session["pending_verification_email"] = user_data.email

                    return JSONResponse(
                        content={
                            "success": True,
                            "message": "Verification code sent to your email",
                            "verification_required": True,
                            "email": user_data.email
                        }
                    )
                else:
                    # If email failed, delete the user
                    db[USERS_COLLECTION].delete_one({"_id": result.inserted_id})
                    return JSONResponse(
                        status_code=500,
                        content={"success": False, "error": "Failed to send verification email"}
                    )
        else:
            return JSONResponse(
                status_code=500,
                content={"success": False, "error": "Failed to create user"}
            )

    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": str(e)}
        )
    except DuplicateKeyError:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Email already registered"}
        )
    except Exception as e:
        print(f"✗ Extension signup error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": f"Server error: {str(e)}"}
        )


@app.get("/ext/logout")
def ext_logout(request: Request):
    """Extension logout endpoint"""
    request.session.clear()
    return JSONResponse(content={"success": True, "message": "Logged out successfully"})


# ============================================================================
# Dashboard API Endpoints
# ============================================================================

from models import AutomationHistoryDB, ScheduledTaskDB, AutomationHistory, ScheduledTask, TaskStatus


@app.get("/api/dashboard/stats")
async def get_dashboard_stats(request: Request):
    """Get user dashboard statistics"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        # Get user stats from database
        stats = await AutomationHistoryDB.get_user_stats(user_email)

        return JSONResponse(content={
            "success": True,
            "data": {
                "total_tasks": stats.total_tasks,
                "successful_tasks": stats.successful_tasks,
                "failed_tasks": stats.failed_tasks,
                "pending_tasks": stats.pending_tasks,
                "success_rate": stats.success_rate,
                "last_task_date": stats.last_task_date.isoformat() if stats.last_task_date else None,
                "total_duration_seconds": stats.total_duration_seconds
            }
        })
    except Exception as e:
        print(f"Error fetching dashboard stats: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/automation/history")
async def get_automation_history(request: Request, limit: int = 50, skip: int = 0):
    """Get automation history for the current user"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        history = await AutomationHistoryDB.get_by_user(user_email, limit=limit, skip=skip)

        # Serialize datetime objects to strings
        serialized_history = serialize_datetime(history)

        return JSONResponse(content={
            "success": True,
            "data": serialized_history,
            "count": len(history)
        })
    except Exception as e:
        print(f"Error fetching automation history: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.delete("/api/automation/history")
async def delete_automation_history(request: Request):
    """Delete all automation history for the current user"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        deleted_count = await AutomationHistoryDB.delete_by_user(user_email)
        return JSONResponse(content={
            "success": True,
            "message": "History cleared",
            "deleted_count": deleted_count
        })
    except Exception as e:
        print(f"Error deleting automation history: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/automation/history/{history_id}")
async def get_automation_history_detail(request: Request, history_id: str):
    """Get detailed automation history for a specific task"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        history = await AutomationHistoryDB.get_by_id(history_id)

        if not history:
            raise HTTPException(status_code=404, detail="History not found")

        # Verify ownership
        if history.get("user_email") != user["email"]:
            raise HTTPException(status_code=403, detail="Unauthorized")

        # Serialize datetime objects to strings
        serialized_history = serialize_datetime(history)

        return JSONResponse(content={
            "success": True,
            "data": serialized_history
        })
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error fetching history detail: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/api/scheduled-tasks")
async def get_scheduled_tasks(request: Request, active_only: bool = False):
    """Get all scheduled tasks for the current user with execution status"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        tasks = await ScheduledTaskDB.get_by_user(user_email, active_only=active_only)

        # Enrich tasks with last execution status from automation history
        from models import get_database
        db = get_database()

        for task in tasks:
            # Find the most recent automation history entry for this task
            task_name = task.get("task_name", "")
            automation_prompt = task.get("automation_prompt", "")

            # Query by task name or automation prompt
            last_execution = await db["automation_history"].find_one(
                {
                    "user_email": user_email,
                    "$or": [
                        {"task_name": task_name},
                        {"task_description": automation_prompt}
                    ]
                },
                sort=[("start_time", -1)]  # Most recent first
            )

            # Derive execution status strictly from lifecycle:
            #   is_active=false always wins — user explicitly paused/stopped
            #   Then check running, then default to pending for active tasks
            task_doc_status = task.get("last_execution_status")
            is_active = task.get("is_active", True)
            frequency = task.get("frequency", "")

            if not is_active and frequency == "once" and last_execution:
                # One-time task that finished and was auto-deactivated — show actual result
                task["last_execution_status"] = last_execution.get("status", "unknown")
                task["last_execution_time"] = last_execution.get("end_time") or last_execution.get("start_time")
                task["last_execution_result"] = last_execution.get("final_result", "")
            elif not is_active:
                # User manually paused — always show paused, even if execution is still winding down
                task["last_execution_status"] = "paused"
                task["last_execution_time"] = last_execution.get("end_time") or last_execution.get("start_time") if last_execution else None
                task["last_execution_result"] = last_execution.get("final_result", "") if last_execution else None
            elif task_doc_status == "running":
                # Task is currently executing (set by scheduler at start)
                task["last_execution_status"] = "running"
                task["last_execution_time"] = None
                task["last_execution_result"] = None
            else:
                # Active task is always pending — it has a next scheduled run
                task["last_execution_status"] = "pending"
                task["last_execution_time"] = last_execution.get("end_time") or last_execution.get("start_time") if last_execution else None
                task["last_execution_result"] = last_execution.get("final_result", "") if last_execution else None

        # Serialize datetime objects to strings
        serialized_tasks = serialize_datetime(tasks)

        return JSONResponse(content={
            "success": True,
            "data": serialized_tasks,
            "count": len(tasks)
        })
    except Exception as e:
        print(f"Error fetching scheduled tasks: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


class CreateScheduledTaskRequest(BaseModel):
    task_name: str
    task_description: str
    automation_prompt: str
    frequency: str
    schedule_time: str


@app.post("/api/scheduled-tasks")
async def create_scheduled_task(request: Request, task_data: CreateScheduledTaskRequest):
    """Create a new scheduled task"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        # Create scheduled task
        from datetime import datetime
        task = ScheduledTask(
            user_email=user_email,
            task_name=task_data.task_name,
            task_description=task_data.task_description,
            automation_prompt=task_data.automation_prompt,
            frequency=task_data.frequency,
            schedule_time=task_data.schedule_time,
            is_active=True
        )

        task_id = await ScheduledTaskDB.create(task)

        # Notify agent_server to add this task to scheduler
        # We'll do this via a simple HTTP request
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    'http://localhost:5005/api/scheduler/reload',
                    json={"task_id": task_id},
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as response:
                    if response.status == 200:
                        print(f"✅ Notified scheduler to add task {task_id}")
                    else:
                        print(f"⚠️ Failed to notify scheduler: {response.status}")
        except Exception as e:
            print(f"⚠️ Could not notify scheduler (it may not be running): {e}")

        return JSONResponse(content={
            "success": True,
            "message": "Scheduled task created successfully",
            "task_id": task_id
        })
    except Exception as e:
        print(f"Error creating scheduled task: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


class UpdateScheduledTaskRequest(BaseModel):
    task_name: Optional[str] = None
    task_description: Optional[str] = None
    automation_prompt: Optional[str] = None
    frequency: Optional[str] = None
    schedule_time: Optional[str] = None
    is_active: Optional[bool] = None


@app.put("/api/scheduled-tasks/{task_id}")
async def update_scheduled_task(request: Request, task_id: str, task_data: UpdateScheduledTaskRequest):
    """Update an existing scheduled task"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        # Get existing task to verify ownership
        existing_task = await ScheduledTaskDB.get_by_id(task_id)

        if not existing_task:
            raise HTTPException(status_code=404, detail="Task not found")

        if existing_task.get("user_email") != user["email"]:
            raise HTTPException(status_code=403, detail="Unauthorized")

        # Update task
        update_data = task_data.dict(exclude_none=True)
        success = await ScheduledTaskDB.update(task_id, update_data)

        if success:
            # Sync scheduler when task status or schedule changes
            import aiohttp
            try:
                if task_data.is_active is False:
                    # Task paused - remove from scheduler
                    async with aiohttp.ClientSession() as session:
                        async with session.post(
                            'http://localhost:5005/api/scheduler/remove',
                            json={"task_id": task_id},
                            timeout=aiohttp.ClientTimeout(total=5)
                        ) as response:
                            print(f"{'✅' if response.status == 200 else '⚠️'} Scheduler remove for paused task {task_id}")

                    # Also cancel any currently running execution
                    user_email = existing_task.get("user_email")
                    if user_email:
                        try:
                            async with aiohttp.ClientSession() as session:
                                async with session.post(
                                    'http://localhost:5005/api/scheduler/cancel',
                                    json={"user_email": user_email},
                                    timeout=aiohttp.ClientTimeout(total=5)
                                ) as response:
                                    print(f"{'✅' if response.status == 200 else '⚠️'} Cancellation flag set for {user_email}")
                        except Exception as cancel_err:
                            print(f"⚠️ Could not set cancellation flag: {cancel_err}")

                elif task_data.is_active is True or task_data.schedule_time or task_data.frequency:
                    # Task resumed or schedule changed - reload in scheduler
                    async with aiohttp.ClientSession() as session:
                        async with session.post(
                            'http://localhost:5005/api/scheduler/reload',
                            json={"task_id": task_id},
                            timeout=aiohttp.ClientTimeout(total=5)
                        ) as response:
                            print(f"{'✅' if response.status == 200 else '⚠️'} Scheduler reload for task {task_id}")

                    # Clear cancellation flag on resume
                    user_email = existing_task.get("user_email")
                    if user_email:
                        try:
                            async with aiohttp.ClientSession() as session:
                                async with session.post(
                                    'http://localhost:5005/api/scheduler/clear-cancel',
                                    json={"user_email": user_email},
                                    timeout=aiohttp.ClientTimeout(total=5)
                                ) as response:
                                    print(f"{'✅' if response.status == 200 else '⚠️'} Cancellation flag cleared for {user_email}")
                        except Exception as clear_err:
                            print(f"⚠️ Could not clear cancellation flag: {clear_err}")
            except Exception as e:
                print(f"⚠️ Could not sync scheduler: {e}")

            return JSONResponse(content={
                "success": True,
                "message": "Task updated successfully"
            })
        else:
            raise HTTPException(status_code=400, detail="Failed to update task")

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error updating scheduled task: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.delete("/api/scheduled-tasks/{task_id}")
async def delete_scheduled_task(request: Request, task_id: str):
    """Delete a scheduled task"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        success = await ScheduledTaskDB.delete(task_id, user_email)

        if success:
            # Notify scheduler to remove the job
            import aiohttp
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        'http://localhost:5005/api/scheduler/remove',
                        json={"task_id": task_id},
                        timeout=aiohttp.ClientTimeout(total=5)
                    ) as response:
                        if response.status == 200:
                            print(f"✅ Removed task {task_id} from scheduler")
                        else:
                            print(f"⚠️ Failed to remove task from scheduler: {response.status}")
            except Exception as e:
                print(f"⚠️ Could not notify scheduler to remove task: {e}")

            return JSONResponse(content={
                "success": True,
                "message": "Task deleted successfully"
            })
        else:
            raise HTTPException(status_code=404, detail="Task not found or unauthorized")

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error deleting scheduled task: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/api/scheduled-tasks/{task_id}/run")
async def run_scheduled_task_now(request: Request, task_id: str):
    """Manually trigger a scheduled task to run immediately (for testing or manual execution)"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    user_email = user["email"]

    try:
        # Get the task from database
        task = await ScheduledTaskDB.get_by_id(task_id)

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Verify ownership
        if task.get("user_email") != user_email:
            raise HTTPException(status_code=403, detail="Unauthorized - not your task")

        # Extract task details
        task_name = task.get("task_name", "Unnamed Task")
        automation_prompt = task.get("automation_prompt", "")

        if not automation_prompt:
            raise HTTPException(status_code=400, detail="Task has no automation prompt")

        print(f"🚀 Manually triggering scheduled task: {task_name} for {user_email}")

        # Fire-and-forget: trigger the agent server to run via scheduler's execute path
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "task_id": task_id,
                    "user_email": user_email,
                    "task_name": task_name,
                    "automation_prompt": automation_prompt,
                    "frequency": task.get("frequency")
                }

                async with session.post(
                    'http://localhost:5005/api/scheduler/run-now',
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=10)  # Short timeout - server returns immediately
                ) as response:
                    if response.status == 200:
                        print(f"✅ Scheduled task started: {task_name}")
                        return JSONResponse(content={
                            "success": True,
                            "message": f"Task '{task_name}' started",
                            "task_id": task_id
                        })
                    else:
                        error_msg = f"Agent server returned status {response.status}"
                        print(f"❌ Error starting task: {error_msg}")
                        return JSONResponse(
                            status_code=500,
                            content={"success": False, "error": error_msg}
                        )
        except Exception as e:
            print(f"❌ Error calling agent server: {e}")
            return JSONResponse(
                status_code=503,
                content={"success": False, "error": f"Agent server unavailable: {str(e)}"}
            )

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error running scheduled task: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================================
# User Profile & Settings API Endpoints
# ============================================================================


class UpdateProfileRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    gender: Optional[str] = None
    company: Optional[str] = None
    phone: Optional[str] = None

    @field_validator('gender')
    @classmethod
    def validate_gender(cls, v):
        if v is not None and v not in ('male', 'female', 'other'):
            raise ValueError('Gender must be male, female, or other')
        return v


class ProfilePictureRequest(BaseModel):
    image_data: str  # base64-encoded image


class UpdateSettingsRequest(BaseModel):
    email_notifications: bool = True
    task_notifications: bool = True
    error_alerts: bool = False


@app.get("/api/user/profile")
def get_user_profile(request: Request):
    """Get current user's profile data"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    user_doc = db[USERS_COLLECTION].find_one({"email": user["email"]})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(content={
        "success": True,
        "data": {
            "username": user_doc.get("username", ""),
            "email": user_doc.get("email", ""),
            "gender": user_doc.get("gender"),
            "company": user_doc.get("company"),
            "phone": user_doc.get("phone"),
            "profile_picture": user_doc.get("profile_picture"),
            "created_at": user_doc.get("created_at").isoformat() if user_doc.get("created_at") else None
        }
    })


@app.put("/api/user/profile")
def update_user_profile(request: Request, profile_data: UpdateProfileRequest):
    """Update current user's profile data"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    update_fields = {
        "username": profile_data.username,
    }
    if profile_data.gender is not None:
        update_fields["gender"] = profile_data.gender
    if profile_data.company is not None:
        update_fields["company"] = profile_data.company
    if profile_data.phone is not None:
        update_fields["phone"] = profile_data.phone

    result = db[USERS_COLLECTION].update_one(
        {"email": user["email"]},
        {"$set": update_fields}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    # Update session username
    request.session["username"] = profile_data.username

    return JSONResponse(content={
        "success": True,
        "message": "Profile updated successfully"
    })


@app.post("/api/user/profile-picture")
def upload_profile_picture(request: Request, picture_data: ProfilePictureRequest):
    """Upload/update user profile picture (base64)"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    # Basic size check: base64 string shouldn't exceed ~2MB of image data
    if len(picture_data.image_data) > 2_800_000:
        raise HTTPException(status_code=413, detail="Image too large. Maximum size is 2MB.")

    result = db[USERS_COLLECTION].update_one(
        {"email": user["email"]},
        {"$set": {"profile_picture": picture_data.image_data}}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(content={
        "success": True,
        "message": "Profile picture updated successfully"
    })


@app.delete("/api/user/profile-picture")
def delete_profile_picture(request: Request):
    """Remove user profile picture"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    result = db[USERS_COLLECTION].update_one(
        {"email": user["email"]},
        {"$unset": {"profile_picture": ""}}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(content={
        "success": True,
        "message": "Profile picture removed"
    })


@app.get("/api/user/settings")
def get_user_settings(request: Request):
    """Get current user's notification settings"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    user_doc = db[USERS_COLLECTION].find_one({"email": user["email"]})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")

    # Return settings with defaults
    settings = user_doc.get("settings", {})

    return JSONResponse(content={
        "success": True,
        "data": {
            "email_notifications": settings.get("email_notifications", False),
            "task_notifications": settings.get("task_notifications", False),
            "error_alerts": settings.get("error_alerts", False)
        }
    })


@app.put("/api/user/settings")
def update_user_settings(request: Request, settings_data: UpdateSettingsRequest):
    """Update current user's notification settings"""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if db is None:
        raise HTTPException(status_code=500, detail="Database connection error")

    result = db[USERS_COLLECTION].update_one(
        {"email": user["email"]},
        {"$set": {
            "settings": {
                "email_notifications": settings_data.email_notifications,
                "task_notifications": settings_data.task_notifications,
                "error_alerts": settings_data.error_alerts
            }
        }}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(content={
        "success": True,
        "message": "Settings saved successfully"
    })


# ============================================================================
# Plan / Subscription Endpoints
# ============================================================================

@app.get("/api/plan-info")
async def api_plan_info(request: Request, email: str = None):
    """Get current plan info for a user."""
    from plan_module import get_user_plan_info
    user_email = email
    if not user_email:
        # Try Starlette session (used by other endpoints)
        user = get_current_user(request)
        if user:
            user_email = user["email"]
    if not user_email:
        # Try cookie-based session as fallback
        session_token = request.cookies.get("session_token")
        if session_token:
            session = await db["sessions"].find_one({"token": session_token})
            if session:
                user_email = session.get("email")
    if not user_email:
        return JSONResponse(status_code=400, content={"error": "email parameter required"})

    try:
        info = await get_user_plan_info(user_email)
        return JSONResponse(content=info)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/api/upgrade")
async def api_upgrade_plan(request: Request):
    """Upgrade user plan (simulated — no real payment)."""
    from plan_module import upgrade_plan
    data = await request.json()
    user_email = data.get("email")
    new_plan = data.get("plan")

    if not user_email or not new_plan:
        return JSONResponse(status_code=400, content={"error": "email and plan required"})

    result = await upgrade_plan(user_email, new_plan)
    status_code = 200 if result["success"] else 400
    return JSONResponse(status_code=status_code, content=result)


@app.post("/api/downgrade")
async def api_downgrade_plan(request: Request):
    """Downgrade user to free plan."""
    from plan_module import downgrade_plan
    data = await request.json()
    user_email = data.get("email")

    if not user_email:
        return JSONResponse(status_code=400, content={"error": "email required"})

    result = await downgrade_plan(user_email)
    return JSONResponse(content=result)


# ============================================================================
# Export Endpoints
# ============================================================================

@app.get("/api/history/export")
async def api_export_history(request: Request, email: str = None,
                              format: str = "json",
                              from_date: str = None, to_date: str = None):
    """Export automation history as CSV or JSON."""
    from models import AutomationHistoryDB
    from datetime import datetime as dt
    import csv
    import io

    user_email = email
    if not user_email:
        user = get_current_user(request)
        if user:
            user_email = user["email"]
    if not user_email:
        session_token = request.cookies.get("session_token")
        if session_token:
            session = await db["sessions"].find_one({"token": session_token})
            if session:
                user_email = session.get("email")
    if not user_email:
        return JSONResponse(status_code=400, content={"error": "email parameter required"})

    # Parse dates
    parsed_from = None
    parsed_to = None
    try:
        if from_date:
            parsed_from = dt.fromisoformat(from_date)
        if to_date:
            parsed_to = dt.fromisoformat(to_date)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid date format. Use ISO format."})

    records = await AutomationHistoryDB.get_for_export(user_email, parsed_from, parsed_to)

    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Date", "Task", "Status", "Duration (s)", "Result", "URLs"])
        for r in records:
            writer.writerow([
                str(r.get("start_time", "")),
                r.get("task_name", ""),
                r.get("status", ""),
                r.get("duration_seconds", ""),
                (r.get("final_result") or "")[:200],
                ", ".join(r.get("urls_visited", [])[:5])
            ])
        csv_content = output.getvalue()
        from starlette.responses import Response
        return Response(
            content=csv_content,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=automation_history.csv"}
        )
    else:
        # JSON export — clean up ObjectId and datetime
        for r in records:
            r["_id"] = str(r.get("_id", ""))
            for key in ["start_time", "end_time", "created_at"]:
                if key in r and r[key]:
                    r[key] = str(r[key])
        return JSONResponse(content=records, headers={
            "Content-Disposition": "attachment; filename=automation_history.json"
        })


# ============================================================================
# PDF Report Export
# ============================================================================

@app.get("/api/export-pdf-report")
async def export_pdf_report(request: Request):
    """Generate and download a PDF report of the user's automation activity."""
    from models import AutomationHistoryDB, ScheduledTaskDB
    from fpdf import FPDF
    from io import BytesIO
    from starlette.responses import Response

    user = get_current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=302)

    user_email = user["email"]

    # Fetch user profile
    user_doc = db[USERS_COLLECTION].find_one({"email": user_email}) if db is not None else None
    username = user_doc.get("username", "User") if user_doc else "User"

    # Fetch stats
    stats = await AutomationHistoryDB.get_user_stats(user_email)

    # Fetch recent history (last 20)
    history = await AutomationHistoryDB.get_by_user(user_email, limit=20)

    # Fetch scheduled tasks
    scheduled_tasks = await ScheduledTaskDB.get_by_user(user_email)

    # Fetch plan info
    try:
        from plan_module import get_user_plan_info
        plan_info = await get_user_plan_info(user_email)
        plan_name = plan_info.get("plan", "Free").capitalize()
    except Exception:
        plan_name = "Free"

    # --- Build PDF ---
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # Colors
    primary = (1, 107, 97)      # #016B61
    dark = (10, 42, 37)         # #0a2a25
    text_color = (51, 51, 51)
    light_bg = (240, 247, 246)  # #F0F7F6
    white = (255, 255, 255)

    # --- Header ---
    pdf.set_fill_color(*primary)
    pdf.rect(0, 0, 210, 40, 'F')
    pdf.set_text_color(*white)
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_y(10)
    pdf.cell(0, 10, "GeniPilot - Automation Report", ln=True, align="C")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 8, f"Generated: {datetime.utcnow().strftime('%B %d, %Y at %H:%M UTC')}", ln=True, align="C")

    pdf.ln(10)

    # --- User Info ---
    pdf.set_text_color(*text_color)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 7, f"User: {username}  |  Email: {user_email}  |  Plan: {plan_name}", ln=True)
    pdf.ln(5)

    # --- Summary Statistics ---
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*dark)
    pdf.cell(0, 10, "Summary Statistics", ln=True)
    pdf.set_draw_color(*primary)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(*text_color)

    avg_duration = (stats.total_duration_seconds / stats.total_tasks) if stats.total_tasks > 0 else 0
    date_range_start = "N/A"
    date_range_end = "N/A"
    if history:
        dates = [h.get("start_time") for h in history if h.get("start_time")]
        if dates:
            min_date = min(dates)
            max_date = max(dates)
            date_range_start = min_date.strftime("%b %d, %Y") if hasattr(min_date, 'strftime') else str(min_date)[:10]
            date_range_end = max_date.strftime("%b %d, %Y") if hasattr(max_date, 'strftime') else str(max_date)[:10]

    stat_items = [
        ("Total Automations", str(stats.total_tasks)),
        ("Success Rate", f"{stats.success_rate}%"),
        ("Successful Tasks", str(stats.successful_tasks)),
        ("Failed Tasks", str(stats.failed_tasks)),
        ("Average Duration", f"{avg_duration:.1f}s"),
        ("Report Period", f"{date_range_start} - {date_range_end}"),
    ]

    col_width = 95
    for i, (label, value) in enumerate(stat_items):
        x = 10 + (i % 2) * col_width
        if i % 2 == 0 and i > 0:
            pdf.ln(7)
        pdf.set_x(x)
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(50, 7, f"{label}:", align="L")
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(40, 7, value, align="L")

    pdf.ln(12)

    # --- Task Status Breakdown ---
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*dark)
    pdf.cell(0, 10, "Task Status Breakdown", ln=True)
    pdf.set_draw_color(*primary)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    # Table header
    pdf.set_fill_color(*primary)
    pdf.set_text_color(*white)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(63, 8, "Status", 1, 0, "C", fill=True)
    pdf.cell(63, 8, "Count", 1, 0, "C", fill=True)
    pdf.cell(64, 8, "Percentage", 1, 1, "C", fill=True)

    pdf.set_text_color(*text_color)
    pdf.set_font("Helvetica", "", 10)
    total = stats.total_tasks if stats.total_tasks > 0 else 1

    canceled = stats.total_tasks - stats.successful_tasks - stats.failed_tasks - stats.pending_tasks
    if canceled < 0:
        canceled = 0

    breakdown = [
        ("Completed", stats.successful_tasks),
        ("Failed", stats.failed_tasks),
        ("Cancelled", canceled),
        ("Pending", stats.pending_tasks),
    ]

    for i, (status, count) in enumerate(breakdown):
        if i % 2 == 0:
            pdf.set_fill_color(*light_bg)
        else:
            pdf.set_fill_color(*white)
        pct = f"{(count / total * 100):.1f}%" if stats.total_tasks > 0 else "0%"
        pdf.cell(63, 7, status, 1, 0, "C", fill=True)
        pdf.cell(63, 7, str(count), 1, 0, "C", fill=True)
        pdf.cell(64, 7, pct, 1, 1, "C", fill=True)

    pdf.ln(8)

    # --- Recent Automation History ---
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*dark)
    pdf.cell(0, 10, "Recent Automation History (Last 20)", ln=True)
    pdf.set_draw_color(*primary)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    if not history:
        pdf.set_font("Helvetica", "I", 10)
        pdf.set_text_color(120, 120, 120)
        pdf.cell(0, 8, "No automation history yet.", ln=True)
    else:
        # Table header
        pdf.set_fill_color(*primary)
        pdf.set_text_color(*white)
        pdf.set_font("Helvetica", "B", 8)
        pdf.cell(55, 7, "Task Name", 1, 0, "C", fill=True)
        pdf.cell(22, 7, "Status", 1, 0, "C", fill=True)
        pdf.cell(32, 7, "Date", 1, 0, "C", fill=True)
        pdf.cell(18, 7, "Duration", 1, 0, "C", fill=True)
        pdf.cell(63, 7, "Result", 1, 1, "C", fill=True)

        pdf.set_text_color(*text_color)
        pdf.set_font("Helvetica", "", 7.5)

        for i, h in enumerate(history):
            if pdf.get_y() > 265:
                pdf.add_page()

            if i % 2 == 0:
                pdf.set_fill_color(*light_bg)
            else:
                pdf.set_fill_color(*white)

            task_name = str(h.get("task_name", ""))[:30]
            status = str(h.get("status", ""))
            start = h.get("start_time")
            if hasattr(start, 'strftime'):
                date_str = start.strftime("%Y-%m-%d %H:%M")
            else:
                date_str = str(start)[:16] if start else ""
            duration = h.get("duration_seconds")
            dur_str = f"{duration:.0f}s" if duration else "-"
            result = str(h.get("final_result") or "")[:55]

            pdf.cell(55, 6, task_name, 1, 0, "L", fill=True)
            pdf.cell(22, 6, status, 1, 0, "C", fill=True)
            pdf.cell(32, 6, date_str, 1, 0, "C", fill=True)
            pdf.cell(18, 6, dur_str, 1, 0, "C", fill=True)
            pdf.cell(63, 6, result, 1, 1, "L", fill=True)

    pdf.ln(8)

    # --- Scheduled Tasks ---
    if pdf.get_y() > 240:
        pdf.add_page()

    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(*dark)
    pdf.cell(0, 10, "Scheduled Tasks", ln=True)
    pdf.set_draw_color(*primary)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(3)

    active_tasks = [t for t in scheduled_tasks if t.get("is_active", False)]
    if not active_tasks:
        pdf.set_font("Helvetica", "I", 10)
        pdf.set_text_color(120, 120, 120)
        pdf.cell(0, 8, "No active scheduled tasks.", ln=True)
    else:
        pdf.set_fill_color(*primary)
        pdf.set_text_color(*white)
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(55, 7, "Task Name", 1, 0, "C", fill=True)
        pdf.cell(30, 7, "Frequency", 1, 0, "C", fill=True)
        pdf.cell(50, 7, "Next Run", 1, 0, "C", fill=True)
        pdf.cell(55, 7, "Last Status", 1, 1, "C", fill=True)

        pdf.set_text_color(*text_color)
        pdf.set_font("Helvetica", "", 8.5)

        for i, t in enumerate(active_tasks):
            if pdf.get_y() > 265:
                pdf.add_page()

            if i % 2 == 0:
                pdf.set_fill_color(*light_bg)
            else:
                pdf.set_fill_color(*white)

            name = str(t.get("task_name", ""))[:30]
            freq = str(t.get("frequency", ""))
            next_run = t.get("next_run")
            if hasattr(next_run, 'strftime'):
                next_str = next_run.strftime("%Y-%m-%d %H:%M")
            else:
                next_str = str(next_run)[:16] if next_run else "Pending"
            last_status = str(t.get("last_execution_status", "pending"))

            pdf.cell(55, 6, name, 1, 0, "L", fill=True)
            pdf.cell(30, 6, freq, 1, 0, "C", fill=True)
            pdf.cell(50, 6, next_str, 1, 0, "C", fill=True)
            pdf.cell(55, 6, last_status, 1, 1, "C", fill=True)

    # --- Footer on every page ---
    total_pages = pdf.page
    for page_num in range(1, total_pages + 1):
        pdf.page = page_num
        pdf.set_y(-15)
        pdf.set_font("Helvetica", "I", 8)
        pdf.set_text_color(130, 130, 130)
        pdf.cell(0, 10, f"Generated by GeniPilot - AI-Powered Browser Automation  |  Page {page_num}/{total_pages}", align="C")

    # Output PDF
    pdf_bytes = pdf.output()
    today_str = datetime.utcnow().strftime("%Y-%m-%d")

    return Response(
        content=bytes(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="genipilot-report-{today_str}.pdf"'
        }
    )


# ============================================================================
# Task Re-run Endpoint
# ============================================================================

@app.post("/api/rerun")
async def api_rerun_task(request: Request):
    """Re-run a previous automation task."""
    from models import AutomationHistoryDB
    data = await request.json()
    task_id = data.get("task_id")
    user_email = data.get("email")

    if not task_id or not user_email:
        return JSONResponse(status_code=400, content={"error": "task_id and email required"})

    # Fetch original task
    original = await AutomationHistoryDB.get_by_id(task_id)
    if not original:
        return JSONResponse(status_code=404, content={"error": "Task not found"})

    if original.get("user_email") != user_email:
        return JSONResponse(status_code=403, content={"error": "Not authorized"})

    task_description = original.get("task_description", original.get("task_name", ""))

    # Store pending rerun in DB so the extension can pick it up
    try:
        db["pending_reruns"].delete_many({"user_email": user_email})
        db["pending_reruns"].insert_one({
            "user_email": user_email,
            "task_description": task_description,
            "original_task_id": task_id,
            "created_at": datetime.utcnow()
        })
    except Exception as e:
        print(f"Error storing pending rerun: {e}")

    return JSONResponse(content={
        "success": True,
        "task_description": task_description,
        "original_task_id": task_id,
        "message": f"Re-running: {task_description[:100]}"
    })


@app.get("/api/pending-rerun")
async def api_pending_rerun(request: Request, email: str = None):
    """Check and consume a pending rerun task for the user."""
    user_email = None
    try:
        user = get_current_user(request)
        if user:
            user_email = user.get("email") if isinstance(user, dict) else user
    except Exception:
        pass
    if not user_email and email:
        user_email = email

    if not user_email:
        return JSONResponse(content={"pending": False})

    try:
        doc = db["pending_reruns"].find_one_and_delete({"user_email": user_email})
        if doc:
            return JSONResponse(content={
                "pending": True,
                "task_description": doc.get("task_description", "")
            })
    except Exception as e:
        print(f"Error fetching pending rerun: {e}")

    return JSONResponse(content={"pending": False})


# ============================================================================
# Health Check Endpoint
# ============================================================================

@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "database": "connected" if db else "disconnected"}


# ============================================================================
# Mount Static Files (MUST be after all routes!)
# ============================================================================

# Mount static files LAST to avoid interfering with routes
# Mount individual directories for direct access (e.g., /img/, /css/, /js/)
try:
    app.mount("/img", StaticFiles(directory="templates/assets/img"), name="img")
    print("✓ Static files mounted at /img")
except Exception as e:
    print(f"✗ Warning: Could not mount img directory: {e}")

try:
    app.mount("/css", StaticFiles(directory="templates/assets/css"), name="css")
    print("✓ Static files mounted at /css")
except Exception as e:
    print(f"✗ Warning: Could not mount css directory: {e}")

try:
    app.mount("/js", StaticFiles(directory="templates/assets/js"), name="js")
    print("✓ Static files mounted at /js")
except Exception as e:
    print(f"✗ Warning: Could not mount js directory: {e}")

try:
    app.mount("/fonts", StaticFiles(directory="templates/assets/fonts"), name="fonts")
    print("✓ Static files mounted at /fonts")
except Exception as e:
    print(f"✗ Warning: Could not mount fonts directory: {e}")

# Also mount the entire assets directory for /assets/ prefixed paths
try:
    app.mount("/assets", StaticFiles(directory="templates/assets"), name="assets")
    print("✓ Static files mounted at /assets")
except Exception as e:
    print(f"✗ Warning: Could not mount assets directory: {e}")


# ============================================================================
# Run the application
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
