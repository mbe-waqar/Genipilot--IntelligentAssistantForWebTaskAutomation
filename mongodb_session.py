"""
MongoDB Session Implementation for OpenAI Agents SDK

Stores conversation history in MongoDB, organized by user email.
Integrates with existing authentication system.
"""

from agents.memory.session import SessionABC
from agents.items import TResponseInputItem
from typing import List, Optional
from motor.motor_asyncio import AsyncIOMotorClient
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

# Global MongoDB client (singleton pattern to avoid connection issues)
_mongo_client = None


def get_mongo_client(mongo_url: str):
    """Get or create global MongoDB client."""
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = AsyncIOMotorClient(mongo_url)
    return _mongo_client


class MongoDBSession(SessionABC):
    """
    MongoDB-based session memory for OpenAI Agents SDK.

    Stores conversation history in MongoDB collections organized by user.
    Each user has their own conversation history identified by email.
    """

    def __init__(
        self,
        session_id: str,
        mongo_url: Optional[str] = None,
        database_name: Optional[str] = None,
        collection_name: str = "agent_sessions"
    ):
        """
        Initialize MongoDB session.

        Args:
            session_id: Unique identifier for this session (e.g., user email)
            mongo_url: MongoDB connection URL (defaults to env var MONGODB_URL)
            database_name: Database name (defaults to env var DATABASE_NAME)
            collection_name: Collection name for storing sessions
        """
        self.session_id = session_id
        self.collection_name = collection_name

        # Use existing MongoDB connection from environment
        mongo_url = mongo_url or os.getenv("MONGODB_URL", "mongodb://localhost:27017/")
        database_name = database_name or os.getenv("DATABASE_NAME", "myapp")

        # Use global MongoDB client (singleton pattern)
        self.client = get_mongo_client(mongo_url)
        self.db = self.client[database_name]
        self.collection = self.db[collection_name]

    async def _ensure_indexes(self):
        """Create indexes for efficient querying."""
        try:
            # Index on session_id for fast lookups
            await self.collection.create_index("session_id")
            # Index on timestamp for ordering
            await self.collection.create_index([("session_id", 1), ("timestamp", -1)])
        except Exception as e:
            print(f"Warning: Could not create indexes: {e}")

    async def get_items(self, limit: Optional[int] = None) -> List[TResponseInputItem]:
        """
        Retrieve conversation history for this session.

        Args:
            limit: Maximum number of items to return (most recent first)

        Returns:
            List of conversation items in chronological order
        """
        try:
            # Query items for this session, sorted by timestamp
            query = {"session_id": self.session_id}
            cursor = self.collection.find(query).sort("timestamp", 1)  # Ascending order

            if limit:
                cursor = cursor.limit(limit)

            items = []
            async for doc in cursor:
                # Extract the item data (remove MongoDB _id and metadata)
                item_data = doc.get("item", {})
                items.append(item_data)

            return items
        except Exception as e:
            print(f"Error retrieving items from MongoDB: {e}")
            return []

    async def add_items(self, items: List[TResponseInputItem]) -> None:
        """
        Store new items for this session.

        Args:
            items: List of conversation items to store
        """
        try:
            if not items:
                return

            # Prepare documents to insert
            documents = []
            timestamp = datetime.utcnow()

            for i, item in enumerate(items):
                doc = {
                    "session_id": self.session_id,
                    "item": item,
                    "timestamp": timestamp,
                    "sequence": i  # Preserve order within batch
                }
                documents.append(doc)

            # Insert all items
            await self.collection.insert_many(documents)

        except Exception as e:
            print(f"Error adding items to MongoDB: {e}")
            raise

    async def pop_item(self) -> Optional[TResponseInputItem]:
        """
        Remove and return the most recent item from this session.

        Returns:
            The most recent item, or None if session is empty
        """
        try:
            # Find and delete the most recent item
            result = await self.collection.find_one_and_delete(
                {"session_id": self.session_id},
                sort=[("timestamp", -1)]  # Most recent first
            )

            if result:
                return result.get("item")
            return None

        except Exception as e:
            print(f"Error popping item from MongoDB: {e}")
            return None

    async def clear_session(self) -> None:
        """Clear all items for this session."""
        try:
            await self.collection.delete_many({"session_id": self.session_id})
        except Exception as e:
            print(f"Error clearing session from MongoDB: {e}")
            raise

    async def get_session_info(self) -> dict:
        """
        Get metadata about this session.

        Returns:
            Dictionary with session information
        """
        try:
            total_items = await self.collection.count_documents({"session_id": self.session_id})

            # Get first and last message timestamps
            first_doc = await self.collection.find_one(
                {"session_id": self.session_id},
                sort=[("timestamp", 1)]
            )
            last_doc = await self.collection.find_one(
                {"session_id": self.session_id},
                sort=[("timestamp", -1)]
            )

            return {
                "session_id": self.session_id,
                "total_items": total_items,
                "first_message": first_doc.get("timestamp") if first_doc else None,
                "last_message": last_doc.get("timestamp") if last_doc else None,
            }
        except Exception as e:
            print(f"Error getting session info: {e}")
            return {
                "session_id": self.session_id,
                "total_items": 0,
                "error": str(e)
            }

    async def close(self):
        """
        Close session resources.

        Note: Does not close the global MongoDB client as it's shared across sessions.
        """
        # Nothing to close - we use a global shared client
        pass


# Helper function to create session from user email
def create_session_for_user(user_email: str) -> MongoDBSession:
    """
    Create a MongoDB session for a specific user.

    Args:
        user_email: User's email address (used as session_id)

    Returns:
        MongoDBSession instance for this user
    """
    return MongoDBSession(session_id=user_email)
