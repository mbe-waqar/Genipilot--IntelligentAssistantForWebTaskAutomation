"""
Task Scheduler for Automated Tasks
Uses APScheduler to execute scheduled automation tasks
"""

import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from apscheduler.triggers.date import DateTrigger
from datetime import datetime, timedelta
from typing import Dict, Any
import logging

from models import ScheduledTaskDB, ScheduleFrequency, AutomationHistoryDB, AutomationHistory, TaskStatus, get_database
from browser_use import Browser, Agent as BrowserAgent, ChatOpenAI, Tools

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class TaskSchedulerService:
    """Service to manage and execute scheduled automation tasks"""

    def __init__(self, browser: Browser, llm: ChatOpenAI, tools: Tools, automation_func=None):
        self.browser = browser
        self.llm = llm
        self.tools = tools
        self.automation_func = automation_func  # Shared automation function from agent_server
        self.scheduler = AsyncIOScheduler()
        self.active_jobs: Dict[str, Any] = {}  # task_id -> job

    async def execute_scheduled_task(self, task_id: str, user_email: str,
                                     task_name: str, automation_prompt: str, frequency: str = None):
        """Execute a scheduled automation task using the same API as the extension"""
        logger.info(f"🚀 Executing scheduled task: {task_name} for {user_email}")

        # If this is a "once" task, disable it after execution
        is_once_task = frequency == ScheduleFrequency.ONCE

        execution_success = False

        # --- Send "task started" notification via WebSocket ---
        try:
            from agent_server import active_websockets, dashboard_websockets, safe_send_json

            # Update task status in DB so dashboard polling picks it up
            await ScheduledTaskDB.update(task_id, {
                "last_execution_status": "running"
            })

            start_msg = {
                "type": "scheduled_task_started",
                "task_id": task_id,
                "task_name": task_name,
                "message": f"Scheduled task '{task_name}' has started",
                "timestamp": datetime.now().isoformat()
            }

            # Send to extension WebSocket — also send extension-compatible messages
            # so the sidebar UI shows steps and status
            ws = active_websockets.get(user_email)
            if ws:
                await safe_send_json(ws, start_msg)
                # Send 'start' so extension initializes step display
                await safe_send_json(ws, {
                    "type": "start",
                    "timestamp": datetime.now().isoformat(),
                    "message": f"Scheduled task '{task_name}' starting...",
                    "user_email": user_email
                })
                # Send 'automation_started' so extension shows automation progress
                await safe_send_json(ws, {
                    "type": "automation_started",
                    "timestamp": datetime.now().isoformat(),
                    "message": f"Running scheduled automation: {task_name}"
                })

            # Send to dashboard WebSocket
            dws = dashboard_websockets.get(user_email)
            if dws:
                await safe_send_json(dws, start_msg)

            logger.info(f"📡 Sent task-started notification to {user_email} (ext={'yes' if ws else 'no'}, dash={'yes' if dws else 'no'})")
        except Exception as notif_start_err:
            logger.warning(f"⚠️ Could not send task-started notification: {notif_start_err}")

        try:
            # Use the same automation function as the extension if available
            if self.automation_func:
                # Call the shared automation function with user_email parameter
                # This function handles history tracking, browser agent creation, etc.
                logger.info(f"📝 Calling automation function for task: {task_name}")
                logger.info(f"📝 Automation prompt: {automation_prompt[:200]}...")
                logger.info(f"📝 User email: {user_email}")

                result = await self.automation_func(automation_prompt, user_email=user_email)

                if result:
                    logger.info(f"✅ Scheduled task completed successfully: {task_name}")
                    logger.info(f"Result preview: {str(result)[:200]}...")
                    execution_success = True
                else:
                    logger.warning(f"⚠️ Scheduled task returned empty result: {task_name}")
                    execution_success = True  # Empty result doesn't mean failure
            else:
                # Fallback: Direct execution (legacy behavior)
                logger.warning("⚠️ No automation function provided, using direct execution")
                agent = BrowserAgent(
                    task=automation_prompt,
                    browser=self.browser,
                    llm=self.llm,
                    tools=self.tools,
                    reset=False,
                    keep_open=True
                )
                history = await agent.run()
                logger.info(f"✅ Scheduled task completed (direct): {task_name}")
                execution_success = True

        except Exception as e:
            logger.error(f"❌ Scheduled task failed: {task_name} - {e}")
            import traceback
            traceback.print_exc()
            execution_success = False

        # Send notifications based on user settings
        try:
            from agent_server import get_user_settings, send_task_notification_email, send_error_alert_email
            settings = await get_user_settings(user_email)
            logger.info(f"📋 Scheduler: User settings for {user_email}: {settings}")

            status_str = "success" if execution_success else "failed"

            # Email Notifications toggle
            if settings["email_notifications"]:
                send_task_notification_email(
                    to_email=user_email,
                    task_name=task_name,
                    status=status_str,
                    duration="N/A (scheduled task)",
                    result_summary=f"Scheduled task '{task_name}' {status_str}."
                )
                logger.info(f"📧 Scheduler: Email notification sent (email_notifications=True)")
            else:
                logger.info(f"📧 Scheduler: Email notification SKIPPED (email_notifications=False)")

            # Error Alerts toggle
            if settings["error_alerts"] and not execution_success:
                send_error_alert_email(
                    to_email=user_email,
                    task_name=task_name,
                    errors=[f"Scheduled task '{task_name}' failed during execution"]
                )
                logger.info(f"🚨 Scheduler: Error alert sent (error_alerts=True)")
            elif not execution_success:
                logger.info(f"🚨 Scheduler: Error alert SKIPPED (error_alerts=False)")

        except Exception as notif_err:
            logger.warning(f"⚠️ Scheduler: Could not send notifications: {notif_err}")

        # --- Send "task completed/failed" notification via WebSocket ---
        try:
            from agent_server import active_websockets, dashboard_websockets, safe_send_json
            complete_msg = {
                "type": "scheduled_task_completed",
                "task_id": task_id,
                "task_name": task_name,
                "status": "success" if execution_success else "failed",
                "message": f"Scheduled task '{task_name}' {'completed successfully' if execution_success else 'failed'}",
                "timestamp": datetime.now().isoformat()
            }

            ws = active_websockets.get(user_email)
            if ws:
                await safe_send_json(ws, complete_msg)
                # Send extension-compatible 'complete' or 'error' so sidebar shows result
                if execution_success:
                    await safe_send_json(ws, {
                        "type": "complete",
                        "timestamp": datetime.now().isoformat(),
                        "message": f"Scheduled task '{task_name}' completed successfully",
                        "final_output": f"Scheduled task '{task_name}' completed successfully."
                    })
                else:
                    await safe_send_json(ws, {
                        "type": "error",
                        "timestamp": datetime.now().isoformat(),
                        "error": f"Scheduled task '{task_name}' failed",
                        "message": f"Scheduled task '{task_name}' failed during execution."
                    })

            dws = dashboard_websockets.get(user_email)
            if dws:
                await safe_send_json(dws, complete_msg)

            logger.info(f"📡 Sent task-completed notification to {user_email}")
        except Exception as notif_end_err:
            logger.warning(f"⚠️ Could not send task-completed notification: {notif_end_err}")

        finally:
            # Clear the "running" status from the task document
            try:
                await ScheduledTaskDB.update(task_id, {
                    "last_execution_status": None
                })
            except Exception:
                pass

            # Update last_run and next_run times (scheduling-specific logic)
            if is_once_task:
                # Disable "once" tasks after execution (whether successful or failed)
                await ScheduledTaskDB.update(task_id, {
                    "is_active": False,
                    "last_run": datetime.now()
                })
                logger.info(f"🔒 Disabled one-time task: {task_name} (status: {'success' if execution_success else 'failed'})")

                # Remove from scheduler
                await self.remove_scheduled_task(task_id)
            else:
                # For recurring tasks, update last_run and calculate next_run
                next_run = self.calculate_next_run(task_id)
                await ScheduledTaskDB.update_last_run(
                    task_id=task_id,
                    last_run=datetime.now(),
                    next_run=next_run
                )
                logger.info(f"📅 Updated recurring task: {task_name}, next run: {next_run}")

    def calculate_next_run(self, task_id: str) -> datetime:
        """Calculate the next run time for a task"""
        job = self.active_jobs.get(task_id)
        if job and job.next_run_time:
            return job.next_run_time
        return datetime.now() + timedelta(days=1)  # Default to 1 day

    def parse_schedule_time(self, frequency: str, schedule_time: str):
        """
        Parse schedule time string and create appropriate trigger

        Formats:
        - Once: "YYYY-MM-DD-HH:MM" (e.g., "2025-12-27-14:30")
        - Daily: "HH:MM" (e.g., "09:00")
        - Weekly: "MON-HH:MM", "TUE-HH:MM", etc. (e.g., "MON-09:00")
        - Monthly: "DD-HH:MM" (e.g., "01-09:00")
        - Hourly: "MM" (e.g., "00" for top of hour)
        """
        try:
            if frequency == ScheduleFrequency.ONCE:
                # Format: "YYYY-MM-DD-HH:MM"
                parts = schedule_time.split('-')
                if len(parts) >= 4:
                    year = int(parts[0])
                    month = int(parts[1])
                    day = int(parts[2])
                    time_parts = ':'.join(parts[3:]).split(':')
                    hour = int(time_parts[0])
                    minute = int(time_parts[1]) if len(time_parts) > 1 else 0

                    run_date = datetime(year, month, day, hour, minute)
                    return DateTrigger(run_date=run_date)
                else:
                    logger.error(f"Invalid 'once' schedule format: {schedule_time}")
                    # Default to 1 hour from now
                    return DateTrigger(run_date=datetime.now() + timedelta(hours=1))

            elif frequency == ScheduleFrequency.DAILY:
                # Format: "HH:MM"
                hour, minute = schedule_time.split(":")
                return CronTrigger(hour=int(hour), minute=int(minute))

            elif frequency == ScheduleFrequency.WEEKLY:
                # Format: "MON-HH:MM"
                day_of_week, time = schedule_time.split("-")
                hour, minute = time.split(":")

                day_map = {
                    "MON": 0, "TUE": 1, "WED": 2, "THU": 3,
                    "FRI": 4, "SAT": 5, "SUN": 6
                }

                return CronTrigger(
                    day_of_week=day_map.get(day_of_week.upper(), 0),
                    hour=int(hour),
                    minute=int(minute)
                )

            elif frequency == ScheduleFrequency.MONTHLY:
                # Format: "DD-HH:MM"
                day, time = schedule_time.split("-")
                hour, minute = time.split(":")

                return CronTrigger(
                    day=int(day),
                    hour=int(hour),
                    minute=int(minute)
                )

            elif frequency == ScheduleFrequency.HOURLY:
                # Format: "MM" (minute of the hour)
                return CronTrigger(minute=int(schedule_time))

            else:
                # Default to daily at 9 AM
                logger.warning(f"Unknown frequency: {frequency}, defaulting to daily at 9 AM")
                return CronTrigger(hour=9, minute=0)

        except Exception as e:
            logger.error(f"Error parsing schedule time: {e}")
            # Default to daily at 9 AM
            return CronTrigger(hour=9, minute=0)

    async def add_scheduled_task(self, task: Dict[str, Any]):
        """Add a scheduled task to the scheduler"""
        task_id = task["_id"]
        task_name = task["task_name"]
        user_email = task["user_email"]
        automation_prompt = task["automation_prompt"]
        frequency = task["frequency"]
        schedule_time = task["schedule_time"]

        # Parse schedule and create trigger
        trigger = self.parse_schedule_time(frequency, schedule_time)

        # Add job to scheduler with misfire handling
        # misfire_grace_time: if job missed its run time, still run it if within grace period
        job = self.scheduler.add_job(
            self.execute_scheduled_task,
            trigger=trigger,
            args=[task_id, user_email, task_name, automation_prompt, frequency],
            id=task_id,
            name=task_name,
            replace_existing=True,
            misfire_grace_time=300  # 5 minutes grace period for missed jobs
        )

        self.active_jobs[task_id] = job

        # Update next_run in database (safely access next_run_time)
        next_run_time = getattr(job, 'next_run_time', None)
        if next_run_time:
            await ScheduledTaskDB.update(task_id, {
                "next_run": next_run_time
            })

        logger.info(f"✅ Added scheduled task: {task_name} ({frequency} at {schedule_time})")
        if next_run_time:
            logger.info(f"   Next run: {next_run_time}")
        else:
            logger.info(f"   Next run: Will be scheduled when scheduler starts")

    async def remove_scheduled_task(self, task_id: str):
        """Remove a scheduled task from the scheduler"""
        try:
            self.scheduler.remove_job(task_id)
            if task_id in self.active_jobs:
                del self.active_jobs[task_id]
            logger.info(f"✅ Removed scheduled task: {task_id}")
        except Exception as e:
            logger.error(f"Error removing scheduled task {task_id}: {e}")

    async def load_all_scheduled_tasks(self):
        """Load all active scheduled tasks from database"""
        logger.info("📋 Loading scheduled tasks from database...")

        try:
            tasks = await ScheduledTaskDB.get_all_active()
            loaded_count = 0
            expired_count = 0
            executing_missed_count = 0

            for task in tasks:
                # Check if this is a "once" task that might have missed its execution time
                if task["frequency"] == ScheduleFrequency.ONCE:
                    # Parse the schedule time to check if it has passed
                    schedule_time = task["schedule_time"]
                    parts = schedule_time.split('-')

                    if len(parts) >= 4:
                        year = int(parts[0])
                        month = int(parts[1])
                        day = int(parts[2])
                        time_parts = ':'.join(parts[3:]).split(':')
                        hour = int(time_parts[0])
                        minute = int(time_parts[1]) if len(time_parts) > 1 else 0

                        scheduled_datetime = datetime(year, month, day, hour, minute)
                        now = datetime.now()
                        time_diff = now - scheduled_datetime

                        # If the scheduled time has passed
                        if scheduled_datetime < now:
                            # Grace period: 5 minutes
                            # If missed by less than 5 minutes, execute immediately
                            if time_diff.total_seconds() < 300:  # 5 minutes = 300 seconds
                                logger.info(f"⚡ Executing missed task immediately (missed by {time_diff.total_seconds():.0f}s): {task['task_name']}")
                                # Execute the task immediately in the background
                                asyncio.create_task(self.execute_scheduled_task(
                                    task["_id"],
                                    task["user_email"],
                                    task["task_name"],
                                    task["automation_prompt"],
                                    task["frequency"]
                                ))
                                executing_missed_count += 1
                                continue
                            else:
                                # Too old, mark as expired
                                logger.warning(f"⏰ Expiring old 'once' task: {task['task_name']} (was scheduled for {scheduled_datetime}, missed by {time_diff})")
                                await ScheduledTaskDB.update(task["_id"], {
                                    "is_active": False,
                                    "last_run": None,  # Never ran
                                    "next_run": None
                                })
                                expired_count += 1
                                continue  # Skip adding this task to scheduler

                # Add task to scheduler (for future tasks or recurring tasks)
                await self.add_scheduled_task(task)
                loaded_count += 1

            logger.info(f"✅ Loaded {loaded_count} scheduled tasks")
            if expired_count > 0:
                logger.info(f"⏰ Expired {expired_count} old tasks")
            if executing_missed_count > 0:
                logger.info(f"⚡ Executing {executing_missed_count} recently missed tasks immediately")

        except Exception as e:
            logger.error(f"❌ Error loading scheduled tasks: {e}")
            import traceback
            traceback.print_exc()

    async def start(self):
        """Start the scheduler"""
        logger.info("🚀 Starting task scheduler...")

        # Load all scheduled tasks from database
        await self.load_all_scheduled_tasks()

        # Start the scheduler
        self.scheduler.start()

        logger.info("✅ Task scheduler started")

    def stop(self):
        """Stop the scheduler"""
        logger.info("⏹️  Stopping task scheduler...")
        self.scheduler.shutdown()
        logger.info("✅ Task scheduler stopped")

    def get_active_jobs(self) -> list:
        """Get list of active scheduled jobs"""
        jobs = []
        for job in self.scheduler.get_jobs():
            next_run_time = getattr(job, 'next_run_time', None)
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": next_run_time.isoformat() if next_run_time else None,
                "trigger": str(job.trigger)
            })
        return jobs


# Global scheduler instance
_scheduler_instance: TaskSchedulerService = None


def get_scheduler() -> TaskSchedulerService:
    """Get the global scheduler instance"""
    return _scheduler_instance


async def initialize_scheduler(browser: Browser, llm: ChatOpenAI, tools: Tools, automation_func=None):
    """Initialize and start the global scheduler"""
    global _scheduler_instance

    if _scheduler_instance is None:
        _scheduler_instance = TaskSchedulerService(browser, llm, tools, automation_func)
        await _scheduler_instance.start()

    return _scheduler_instance


def shutdown_scheduler():
    """Shutdown the global scheduler"""
    global _scheduler_instance

    if _scheduler_instance:
        _scheduler_instance.stop()
        _scheduler_instance = None
