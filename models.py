"""
Database Models for FYPAuto Platform
Handles automation history, scheduled tasks, and user data tracking
"""

from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from enum import Enum
import os


# Enums for status tracking
class TaskStatus(str, Enum):
    SUCCESS = "success"
    FAILED = "failed"
    CANCELED = "canceled"
    PENDING = "pending"
    RUNNING = "running"


class ScheduleFrequency(str, Enum):
    ONCE = "once"
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    HOURLY = "hourly"
    CUSTOM = "custom"


# Pydantic Models for Data Validation
class AutomationHistory(BaseModel):
    """Model for tracking automation execution history"""
    id: Optional[str] = Field(None, alias="_id")
    user_email: str
    task_name: str
    task_description: str
    status: TaskStatus
    start_time: datetime
    end_time: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    steps_count: int = 0
    urls_visited: List[str] = []
    errors: List[str] = []
    final_result: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        use_enum_values = True


class ScheduledTask(BaseModel):
    """Model for scheduled automation tasks"""
    id: Optional[str] = Field(None, alias="_id")
    user_email: str
    task_name: str
    task_description: str
    automation_prompt: str  # The actual task to send to the agent
    frequency: ScheduleFrequency
    schedule_time: str  # Format: "HH:MM" for daily, "MON-HH:MM" for weekly, etc.
    is_active: bool = True
    last_run: Optional[datetime] = None
    next_run: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        use_enum_values = True


class UserStats(BaseModel):
    """Model for user automation statistics"""
    user_email: str
    total_tasks: int = 0
    successful_tasks: int = 0
    failed_tasks: int = 0
    pending_tasks: int = 0
    success_rate: float = 0.0
    last_task_date: Optional[datetime] = None
    total_duration_seconds: float = 0.0


# Database connection singleton
_mongo_client: Optional[AsyncIOMotorClient] = None
_database = None


def get_database():
    """Get or create MongoDB database connection"""
    global _mongo_client, _database

    if _mongo_client is None:
        mongo_url = os.getenv("MONGODB_URL", "mongodb://localhost:27017/")
        _mongo_client = AsyncIOMotorClient(mongo_url)
        database_name = os.getenv("DATABASE_NAME", "myapp")
        _database = _mongo_client[database_name]

    return _database


# Database Operations
class AutomationHistoryDB:
    """Database operations for automation history"""

    @staticmethod
    async def create(history: AutomationHistory) -> str:
        """Create new automation history record"""
        db = get_database()
        collection = db["automation_history"]

        history_dict = history.dict(by_alias=True, exclude={"id"})
        result = await collection.insert_one(history_dict)
        return str(result.inserted_id)

    @staticmethod
    async def get_by_user(user_email: str, limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        """Get automation history for a user"""
        db = get_database()
        collection = db["automation_history"]

        cursor = collection.find({"user_email": user_email}) \
            .sort("start_time", -1) \
            .skip(skip) \
            .limit(limit)

        results = []
        async for doc in cursor:
            doc["_id"] = str(doc["_id"])
            results.append(doc)

        return results

    @staticmethod
    async def get_by_id(history_id: str) -> Optional[Dict[str, Any]]:
        """Get specific automation history by ID"""
        from bson import ObjectId
        db = get_database()
        collection = db["automation_history"]

        doc = await collection.find_one({"_id": ObjectId(history_id)})
        if doc:
            doc["_id"] = str(doc["_id"])
        return doc

    @staticmethod
    async def update_status(history_id: str, status: TaskStatus,
                           end_time: datetime, duration_seconds: float,
                           final_result: Optional[str] = None,
                           errors: Optional[List[str]] = None) -> bool:
        """Update automation history status after completion"""
        from bson import ObjectId
        db = get_database()
        collection = db["automation_history"]

        update_data = {
            "status": status.value,
            "end_time": end_time,
            "duration_seconds": duration_seconds
        }

        if final_result:
            update_data["final_result"] = final_result
        if errors:
            update_data["errors"] = errors

        result = await collection.update_one(
            {"_id": ObjectId(history_id)},
            {"$set": update_data}
        )

        return result.modified_count > 0

    @staticmethod
    async def delete_by_user(user_email: str) -> int:
        """Delete all automation history for a user. Returns count of deleted records."""
        db = get_database()
        collection = db["automation_history"]
        result = await collection.delete_many({"user_email": user_email})
        return result.deleted_count

    @staticmethod
    async def get_user_stats(user_email: str) -> UserStats:
        """Get statistics for a user"""
        db = get_database()
        collection = db["automation_history"]

        # Aggregate statistics
        pipeline = [
            {"$match": {"user_email": user_email}},
            {"$group": {
                "_id": None,
                "total_tasks": {"$sum": 1},
                "successful_tasks": {
                    "$sum": {"$cond": [{"$eq": ["$status", "success"]}, 1, 0]}
                },
                "failed_tasks": {
                    "$sum": {"$cond": [{"$eq": ["$status", "failed"]}, 1, 0]}
                },
                "canceled_tasks": {
                    "$sum": {"$cond": [{"$eq": ["$status", "canceled"]}, 1, 0]}
                },
                "pending_tasks": {
                    "$sum": {"$cond": [{"$eq": ["$status", "pending"]}, 1, 0]}
                },
                "total_duration": {"$sum": "$duration_seconds"},
                "last_task_date": {"$max": "$start_time"}
            }}
        ]

        cursor = collection.aggregate(pipeline)
        result = await cursor.to_list(length=1)

        if result:
            data = result[0]
            total = data["total_tasks"]
            success = data["successful_tasks"]
            canceled = data.get("canceled_tasks", 0)
            # Success rate excludes canceled tasks from total
            completed_tasks = total - canceled
            success_rate = (success / completed_tasks * 100) if completed_tasks > 0 else 0.0

            return UserStats(
                user_email=user_email,
                total_tasks=total,
                successful_tasks=success,
                failed_tasks=data["failed_tasks"],
                pending_tasks=data["pending_tasks"],
                success_rate=round(success_rate, 1),
                last_task_date=data.get("last_task_date"),
                total_duration_seconds=data.get("total_duration", 0.0)
            )
        else:
            return UserStats(user_email=user_email)


class ScheduledTaskDB:
    """Database operations for scheduled tasks"""

    @staticmethod
    async def create(task: ScheduledTask) -> str:
        """Create new scheduled task"""
        db = get_database()
        collection = db["scheduled_tasks"]

        task_dict = task.dict(by_alias=True, exclude={"id"})
        result = await collection.insert_one(task_dict)
        return str(result.inserted_id)

    @staticmethod
    async def get_by_user(user_email: str, active_only: bool = False) -> List[Dict[str, Any]]:
        """Get scheduled tasks for a user"""
        db = get_database()
        collection = db["scheduled_tasks"]

        query = {"user_email": user_email}
        if active_only:
            query["is_active"] = True

        cursor = collection.find(query).sort("created_at", -1)

        results = []
        async for doc in cursor:
            doc["_id"] = str(doc["_id"])
            results.append(doc)

        return results

    @staticmethod
    async def get_by_id(task_id: str) -> Optional[Dict[str, Any]]:
        """Get specific scheduled task by ID"""
        from bson import ObjectId
        db = get_database()
        collection = db["scheduled_tasks"]

        doc = await collection.find_one({"_id": ObjectId(task_id)})
        if doc:
            doc["_id"] = str(doc["_id"])
        return doc

    @staticmethod
    async def update(task_id: str, update_data: Dict[str, Any]) -> bool:
        """Update scheduled task"""
        from bson import ObjectId
        db = get_database()
        collection = db["scheduled_tasks"]

        update_data["updated_at"] = datetime.utcnow()

        result = await collection.update_one(
            {"_id": ObjectId(task_id)},
            {"$set": update_data}
        )

        return result.modified_count > 0

    @staticmethod
    async def delete(task_id: str, user_email: str) -> bool:
        """Delete scheduled task (with user verification)"""
        from bson import ObjectId
        db = get_database()
        collection = db["scheduled_tasks"]

        result = await collection.delete_one({
            "_id": ObjectId(task_id),
            "user_email": user_email
        })

        return result.deleted_count > 0

    @staticmethod
    async def update_last_run(task_id: str, last_run: datetime, next_run: datetime) -> bool:
        """Update last run time and next run time"""
        from bson import ObjectId
        db = get_database()
        collection = db["scheduled_tasks"]

        result = await collection.update_one(
            {"_id": ObjectId(task_id)},
            {"$set": {
                "last_run": last_run,
                "next_run": next_run,
                "updated_at": datetime.utcnow()
            }}
        )

        return result.modified_count > 0

    @staticmethod
    async def get_all_active() -> List[Dict[str, Any]]:
        """Get all active scheduled tasks (for scheduler)"""
        db = get_database()
        collection = db["scheduled_tasks"]

        cursor = collection.find({"is_active": True})

        results = []
        async for doc in cursor:
            doc["_id"] = str(doc["_id"])
            results.append(doc)

        return results
