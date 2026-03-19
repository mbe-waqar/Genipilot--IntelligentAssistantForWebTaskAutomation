"""
Plan / Subscription Module for GeniPilot (FYPAuto)
Standalone module for tier-based subscription management.

Handles plan types, feature gating, daily task limits, and plan upgrades.
All plan logic lives here — agent_server.py and main.py only import and call.

Usage:
    from plan_module import get_user_plan, check_task_limit, increment_task_count, PLAN_LIMITS

    plan = await get_user_plan(user_email)
    can_run = await check_task_limit(user_email)
    await increment_task_count(user_email)
"""

import os
import logging
from datetime import datetime, timedelta
from enum import Enum
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# ─── Plan Types ─────────────────────────────────────────────────────────────

class PlanType(str, Enum):
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


# ─── Plan Limits Configuration ──────────────────────────────────────────────

@dataclass(frozen=True)
class PlanLimits:
    """Immutable configuration for a plan tier."""
    name: str
    display_name: str
    price_monthly: float
    daily_task_limit: int          # -1 = unlimited
    max_scheduled_tasks: int       # -1 = unlimited
    image_module: bool
    email_notifications: bool
    voice_assistant: bool
    custom_templates: bool
    api_access: bool
    history_retention_days: int
    priority_support: bool


# NOTE: Free plan limits are temporarily set to match Pro for testing.
# To restore original free plan limits, change: daily_task_limit=10,
# max_scheduled_tasks=5, image_module=False, email_notifications=False,
# history_retention_days=30
PLAN_LIMITS = {
    PlanType.FREE: PlanLimits(
        name="free",
        display_name="Free",
        price_monthly=0.0,
        daily_task_limit=100,        # Was 10, now matches Pro for testing
        max_scheduled_tasks=25,      # Was 5, now matches Pro for testing
        image_module=True,           # Was False, now matches Pro for testing
        email_notifications=True,    # Was False, now matches Pro for testing
        voice_assistant=True,
        custom_templates=False,
        api_access=False,
        history_retention_days=90,   # Was 30, now matches Pro for testing
        priority_support=False,
    ),
    PlanType.PRO: PlanLimits(
        name="pro",
        display_name="Pro",
        price_monthly=9.99,
        daily_task_limit=100,
        max_scheduled_tasks=25,
        image_module=True,
        email_notifications=True,
        voice_assistant=True,
        custom_templates=False,
        api_access=False,
        history_retention_days=90,
        priority_support=False,
    ),
    PlanType.ENTERPRISE: PlanLimits(
        name="enterprise",
        display_name="Enterprise",
        price_monthly=29.99,
        daily_task_limit=-1,  # unlimited
        max_scheduled_tasks=-1,  # unlimited
        image_module=True,
        email_notifications=True,
        voice_assistant=True,
        custom_templates=True,
        api_access=True,
        history_retention_days=365,
        priority_support=True,
    ),
}


# ─── Database Helpers ───────────────────────────────────────────────────────

def _get_db():
    """Get database reference (imports from models to avoid circular deps)."""
    from models import get_database
    return get_database()


async def get_user_plan(user_email: str) -> PlanType:
    """
    Fetch the user's current plan from MongoDB.
    Returns PlanType.FREE if no plan is set (safe default for existing users).
    """
    try:
        db = _get_db()
        user = await db["users"].find_one(
            {"email": user_email},
            {"plan": 1, "plan_expires": 1}
        )

        if not user or "plan" not in user:
            return PlanType.FREE

        plan_value = user["plan"]

        # Check if plan has expired
        plan_expires = user.get("plan_expires")
        if plan_expires and isinstance(plan_expires, datetime):
            if datetime.utcnow() > plan_expires:
                # Plan expired — downgrade to free
                await _downgrade_to_free(user_email)
                return PlanType.FREE

        try:
            return PlanType(plan_value)
        except ValueError:
            return PlanType.FREE

    except Exception as e:
        logger.error(f"Error fetching plan for {user_email}: {e}")
        return PlanType.FREE


def get_plan_limits(plan: PlanType) -> PlanLimits:
    """Get the limits configuration for a plan tier."""
    return PLAN_LIMITS.get(plan, PLAN_LIMITS[PlanType.FREE])


async def get_user_plan_info(user_email: str) -> dict:
    """
    Get full plan info for API responses / dashboard display.
    Returns a JSON-safe dict.
    """
    plan = await get_user_plan(user_email)
    limits = get_plan_limits(plan)
    usage = await get_daily_usage(user_email)

    return {
        "plan": plan.value,
        "display_name": limits.display_name,
        "price_monthly": limits.price_monthly,
        "daily_task_limit": limits.daily_task_limit,
        "daily_tasks_used": usage,
        "max_scheduled_tasks": limits.max_scheduled_tasks,
        "image_module": limits.image_module,
        "email_notifications": limits.email_notifications,
        "voice_assistant": limits.voice_assistant,
        "custom_templates": limits.custom_templates,
        "api_access": limits.api_access,
        "history_retention_days": limits.history_retention_days,
        "priority_support": limits.priority_support,
    }


# ─── Task Limit Tracking ───────────────────────────────────────────────────

async def get_daily_usage(user_email: str) -> int:
    """Get the number of automation tasks the user has run today (UTC)."""
    try:
        db = _get_db()
        user = await db["users"].find_one(
            {"email": user_email},
            {"daily_task_count": 1, "daily_task_reset": 1}
        )

        if not user:
            return 0

        count = user.get("daily_task_count", 0)
        reset_date = user.get("daily_task_reset")

        # Check if the counter needs to be reset (new UTC day)
        today = datetime.utcnow().date()
        if reset_date and hasattr(reset_date, 'date'):
            if reset_date.date() < today:
                # New day — reset the counter
                await _reset_daily_counter(user_email)
                return 0

        return count

    except Exception as e:
        logger.error(f"Error getting daily usage for {user_email}: {e}")
        return 0


async def check_task_limit(user_email: str) -> dict:
    """
    Check if the user can run another automation task.

    Returns:
        {
            "allowed": bool,
            "plan": str,
            "daily_limit": int,
            "daily_used": int,
            "message": str or None
        }
    """
    plan = await get_user_plan(user_email)
    limits = get_plan_limits(plan)
    usage = await get_daily_usage(user_email)

    # Unlimited plan
    if limits.daily_task_limit == -1:
        return {
            "allowed": True,
            "plan": plan.value,
            "daily_limit": -1,
            "daily_used": usage,
            "message": None
        }

    if usage >= limits.daily_task_limit:
        return {
            "allowed": False,
            "plan": plan.value,
            "daily_limit": limits.daily_task_limit,
            "daily_used": usage,
            "message": (
                f"You've reached your daily automation limit "
                f"({usage}/{limits.daily_task_limit} tasks). "
                f"Upgrade your plan for more tasks per day."
            )
        }

    return {
        "allowed": True,
        "plan": plan.value,
        "daily_limit": limits.daily_task_limit,
        "daily_used": usage,
        "message": None
    }


async def check_image_access(user_email: str) -> dict:
    """
    Check if the user's plan allows image-to-automation feature.

    Returns:
        {"allowed": bool, "plan": str, "message": str or None}
    """
    plan = await get_user_plan(user_email)
    limits = get_plan_limits(plan)

    if not limits.image_module:
        return {
            "allowed": False,
            "plan": plan.value,
            "message": (
                "Image-to-automation is available on Pro and Enterprise plans. "
                "Upgrade to unlock visual task automation."
            )
        }

    return {"allowed": True, "plan": plan.value, "message": None}


async def check_scheduled_task_limit(user_email: str) -> dict:
    """
    Check if the user can create another scheduled task.

    Returns:
        {"allowed": bool, "plan": str, "current_count": int, "limit": int, "message": str or None}
    """
    plan = await get_user_plan(user_email)
    limits = get_plan_limits(plan)

    # Count existing active scheduled tasks
    try:
        db = _get_db()
        count = await db["scheduled_tasks"].count_documents({
            "user_email": user_email,
            "is_active": True
        })
    except Exception:
        count = 0

    if limits.max_scheduled_tasks == -1:
        return {
            "allowed": True,
            "plan": plan.value,
            "current_count": count,
            "limit": -1,
            "message": None
        }

    if count >= limits.max_scheduled_tasks:
        return {
            "allowed": False,
            "plan": plan.value,
            "current_count": count,
            "limit": limits.max_scheduled_tasks,
            "message": (
                f"You've reached your scheduled task limit "
                f"({count}/{limits.max_scheduled_tasks}). "
                f"Upgrade your plan for more scheduled tasks."
            )
        }

    return {
        "allowed": True,
        "plan": plan.value,
        "current_count": count,
        "limit": limits.max_scheduled_tasks,
        "message": None
    }


async def increment_task_count(user_email: str) -> None:
    """Increment the user's daily task counter."""
    try:
        db = _get_db()
        today = datetime.utcnow()

        await db["users"].update_one(
            {"email": user_email},
            {
                "$inc": {"daily_task_count": 1},
                "$set": {"daily_task_reset": today}
            }
        )
    except Exception as e:
        logger.error(f"Error incrementing task count for {user_email}: {e}")


# ─── Plan Upgrade / Downgrade ──────────────────────────────────────────────

async def upgrade_plan(user_email: str, new_plan: str) -> dict:
    """
    Upgrade a user's plan (simulated — no real payment).

    Returns:
        {"success": bool, "plan": str, "expires": str, "message": str}
    """
    try:
        plan_type = PlanType(new_plan)
    except ValueError:
        return {
            "success": False,
            "plan": "free",
            "expires": None,
            "message": f"Invalid plan: {new_plan}"
        }

    if plan_type == PlanType.FREE:
        return await downgrade_plan(user_email)

    expires = datetime.utcnow() + timedelta(days=30)

    try:
        db = _get_db()
        await db["users"].update_one(
            {"email": user_email},
            {"$set": {
                "plan": plan_type.value,
                "plan_started": datetime.utcnow(),
                "plan_expires": expires,
            }}
        )

        limits = get_plan_limits(plan_type)
        return {
            "success": True,
            "plan": plan_type.value,
            "expires": expires.isoformat(),
            "message": f"Successfully upgraded to {limits.display_name} plan!"
        }

    except Exception as e:
        logger.error(f"Error upgrading plan for {user_email}: {e}")
        return {
            "success": False,
            "plan": "free",
            "expires": None,
            "message": f"Upgrade failed: {str(e)}"
        }


async def downgrade_plan(user_email: str) -> dict:
    """Downgrade user to free plan."""
    try:
        await _downgrade_to_free(user_email)
        return {
            "success": True,
            "plan": "free",
            "expires": None,
            "message": "Downgraded to Free plan."
        }
    except Exception as e:
        logger.error(f"Error downgrading plan for {user_email}: {e}")
        return {
            "success": False,
            "plan": "free",
            "expires": None,
            "message": f"Downgrade failed: {str(e)}"
        }


# ─── Internal Helpers ───────────────────────────────────────────────────────

async def _downgrade_to_free(user_email: str) -> None:
    """Internal: set user plan to free."""
    db = _get_db()
    await db["users"].update_one(
        {"email": user_email},
        {"$set": {
            "plan": PlanType.FREE.value,
            "plan_expires": None,
        }}
    )


async def _reset_daily_counter(user_email: str) -> None:
    """Internal: reset daily task counter for a new UTC day."""
    db = _get_db()
    await db["users"].update_one(
        {"email": user_email},
        {"$set": {
            "daily_task_count": 0,
            "daily_task_reset": datetime.utcnow()
        }}
    )
