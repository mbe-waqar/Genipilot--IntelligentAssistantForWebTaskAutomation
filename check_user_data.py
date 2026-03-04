"""
Database User Data Verification Script
Checks if tasks and history are properly isolated by user
"""
import asyncio
from models import get_database, ScheduledTaskDB, AutomationHistoryDB
from dotenv import load_dotenv
import os

load_dotenv()


async def check_database():
    """Check database for user isolation issues"""
    print("\n" + "=" * 60)
    print("DATABASE USER ISOLATION CHECK")
    print("=" * 60)

    db = get_database()

    # Get database name
    db_name = os.getenv("DATABASE_NAME", "myapp")
    print(f"\nUsing database: {db_name}")
    print(f"MongoDB URL: {os.getenv('MONGODB_URL', 'mongodb://localhost:27017/')}")

    # Check users collection
    print("\n--- USERS ---")
    users = await db["users"].find({}, {"email": 1, "username": 1}).to_list(None)
    print(f"Total users: {len(users)}")
    for user in users:
        email = user.get("email", "N/A")
        username = user.get("username", "N/A")
        print(f"  - {email} ({username})")

    # Check scheduled tasks
    print("\n--- SCHEDULED TASKS ---")
    all_tasks = await db["scheduled_tasks"].find({}).to_list(None)
    print(f"Total scheduled tasks: {len(all_tasks)}")

    # Group tasks by user
    tasks_by_user = {}
    for task in all_tasks:
        user_email = task.get("user_email", "MISSING_EMAIL")
        if user_email not in tasks_by_user:
            tasks_by_user[user_email] = []
        tasks_by_user[user_email].append(task)

    for user_email, user_tasks in tasks_by_user.items():
        print(f"\n  User: {user_email}")
        print(f"  Tasks: {len(user_tasks)}")
        for task in user_tasks:
            task_name = task.get("task_name", "N/A")
            is_active = task.get("is_active", False)
            frequency = task.get("frequency", "N/A")
            status = "Active" if is_active else "Inactive"
            print(f"    - {task_name} ({frequency}) [{status}]")

    # Check automation history
    print("\n--- AUTOMATION HISTORY ---")
    all_history = await db["automation_history"].find({}).to_list(None)
    print(f"Total automation history entries: {len(all_history)}")

    # Group history by user
    history_by_user = {}
    for history in all_history:
        user_email = history.get("user_email", "MISSING_EMAIL")
        if user_email not in history_by_user:
            history_by_user[user_email] = []
        history_by_user[user_email].append(history)

    for user_email, user_history in history_by_user.items():
        print(f"\n  User: {user_email}")
        print(f"  History entries: {len(user_history)}")

        # Count by status
        status_counts = {"success": 0, "failed": 0, "running": 0, "pending": 0}
        for entry in user_history:
            status = entry.get("status", "unknown")
            if status in status_counts:
                status_counts[status] += 1

        print(f"    Success: {status_counts['success']}, Failed: {status_counts['failed']}, "
              f"Running: {status_counts['running']}, Pending: {status_counts['pending']}")

    # Check for cross-user contamination
    print("\n--- CROSS-USER CONTAMINATION CHECK ---")
    issues_found = False

    for user_email in [u.get("email") for u in users]:
        # Check if this user sees tasks from other users
        user_tasks = await ScheduledTaskDB.get_by_user(user_email)

        for task in user_tasks:
            if task.get("user_email") != user_email:
                print(f"❌ ERROR: User {user_email} has access to task owned by {task.get('user_email')}")
                issues_found = True

    if not issues_found:
        print("✅ No cross-user contamination found in scheduled tasks")

    # Check automation history isolation
    for user_email in [u.get("email") for u in users]:
        user_history = await AutomationHistoryDB.get_by_user(user_email, limit=1000)

        for entry in user_history:
            if entry.get("user_email") != user_email:
                print(f"❌ ERROR: User {user_email} has access to history owned by {entry.get('user_email')}")
                issues_found = True

    if not issues_found:
        print("✅ No cross-user contamination found in automation history")

    print("\n" + "=" * 60)
    print("VERIFICATION COMPLETE")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    asyncio.run(check_database())
