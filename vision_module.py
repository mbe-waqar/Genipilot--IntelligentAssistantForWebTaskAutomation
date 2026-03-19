"""
Vision Module for GeniPilot (FYPAuto)
Standalone module for image-to-automation processing.

Extracts visual context from user-uploaded images using GPT-4o vision API,
then combines it with the user's text query to create an enriched prompt
for the orchestrator agent.

Usage:
    from vision_module import create_vision_processor

    processor = create_vision_processor()
    result = await processor.extract_context(image_base64, "find this on Amazon")
    enriched_prompt = result.enriched_prompt
"""

import os
import base64
import io
import json
import logging
from dataclasses import dataclass, field
from typing import List, Optional

logger = logging.getLogger(__name__)


# ─── Data Models ────────────────────────────────────────────────────────────

@dataclass
class VisionResult:
    """Structured result from vision processing."""
    extracted_text: str = ""
    visual_description: str = ""
    identified_elements: List[str] = field(default_factory=list)
    enriched_prompt: str = ""
    thumbnail_base64: str = ""
    success: bool = True
    error: Optional[str] = None


# ─── Constants ──────────────────────────────────────────────────────────────

MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5MB
SUPPORTED_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}
THUMBNAIL_MAX_SIZE = 200  # px

VISION_SYSTEM_PROMPT = """You are a vision analysis assistant. Analyze the provided image and extract actionable information.

Your response MUST be valid JSON with exactly these fields:
{
  "extracted_text": "Any text/OCR content visible in the image",
  "visual_description": "A concise description of what the image shows",
  "identified_elements": ["list", "of", "key", "elements", "found"]
}

Be specific and actionable. If you see a product, include brand, model, color, size hints.
If you see a form, describe the fields. If you see an error, include the error message.
If you see a website, mention the site name and what page/section is shown."""


# ─── VisionProcessor Class ─────────────────────────────────────────────────

class VisionProcessor:
    """Processes images using GPT-4o vision API to extract context for automation."""

    def __init__(self, api_key: str, model: str = "gpt-4o-mini"):
        self.api_key = api_key
        self.model = model
        self._client = None

    def _get_client(self):
        """Lazy-initialize OpenAI client."""
        if self._client is None:
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(api_key=self.api_key)
        return self._client

    async def extract_context(self, image_base64: str, user_query: str) -> VisionResult:
        """
        Extract actionable context from an image using GPT-4o vision.

        Args:
            image_base64: Base64-encoded image (with or without data URI prefix)
            user_query: The user's text query accompanying the image

        Returns:
            VisionResult with enriched_prompt ready for the orchestrator
        """
        try:
            # Validate image
            clean_base64, mime_type = self._parse_image_data(image_base64)
            if not self._validate_image(clean_base64):
                return VisionResult(
                    success=False,
                    error="Image validation failed: too large or unsupported format",
                    enriched_prompt=user_query  # Fallback to text-only
                )

            # Build the data URI for the API
            data_uri = f"data:{mime_type};base64,{clean_base64}"

            # Call GPT-4o vision
            client = self._get_client()
            response = await client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": VISION_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": self._build_vision_prompt(user_query)},
                            {"type": "image_url", "image_url": {"url": data_uri}}
                        ]
                    }
                ],
                max_tokens=1000,
                temperature=0.2
            )

            # Parse the response
            raw_content = response.choices[0].message.content.strip()
            vision_data = self._parse_vision_response(raw_content)

            # Generate thumbnail
            thumbnail = self._create_thumbnail(clean_base64)

            # Build enriched prompt
            enriched = format_enriched_prompt(user_query, vision_data)

            return VisionResult(
                extracted_text=vision_data.get("extracted_text", ""),
                visual_description=vision_data.get("visual_description", ""),
                identified_elements=vision_data.get("identified_elements", []),
                enriched_prompt=enriched,
                thumbnail_base64=thumbnail,
                success=True
            )

        except Exception as e:
            logger.error(f"Vision processing failed: {e}")
            # Graceful fallback — still process the text query
            return VisionResult(
                success=False,
                error=str(e),
                enriched_prompt=user_query  # Fallback to text-only
            )

    def _parse_image_data(self, image_base64: str) -> tuple:
        """
        Parse image data, stripping data URI prefix if present.

        Returns:
            (clean_base64, mime_type)
        """
        mime_type = "image/png"  # default

        if image_base64.startswith("data:"):
            # Format: data:image/png;base64,<data>
            header, _, data = image_base64.partition(",")
            # Extract mime type from header
            if "image/jpeg" in header or "image/jpg" in header:
                mime_type = "image/jpeg"
            elif "image/webp" in header:
                mime_type = "image/webp"
            elif "image/png" in header:
                mime_type = "image/png"
            return data, mime_type

        return image_base64, mime_type

    def _validate_image(self, clean_base64: str) -> bool:
        """Validate image size and basic format."""
        try:
            decoded = base64.b64decode(clean_base64)
            if len(decoded) > MAX_IMAGE_SIZE_BYTES:
                logger.warning(f"Image too large: {len(decoded)} bytes (max {MAX_IMAGE_SIZE_BYTES})")
                return False
            if len(decoded) < 100:
                logger.warning("Image data too small, likely invalid")
                return False
            return True
        except Exception:
            logger.warning("Failed to decode base64 image data")
            return False

    def _build_vision_prompt(self, user_query: str) -> str:
        """Build the text prompt sent alongside the image."""
        return (
            f"The user wants to perform this task: \"{user_query}\"\n\n"
            f"Analyze the image and extract all relevant information that would help "
            f"complete this task. Focus on actionable details like product names, "
            f"text content, UI elements, URLs, prices, or any identifiable information."
        )

    def _parse_vision_response(self, raw_content: str) -> dict:
        """Parse the GPT-4o vision response, handling JSON and plain text."""
        # Try to parse as JSON first
        try:
            # Strip markdown code fences if present
            content = raw_content
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                # Also handle ```json prefix
                if content.startswith("json"):
                    content = content[4:]
                content = content.strip()

            return json.loads(content)
        except (json.JSONDecodeError, IndexError):
            # Fallback: treat as plain text description
            return {
                "extracted_text": "",
                "visual_description": raw_content,
                "identified_elements": []
            }

    def _create_thumbnail(self, clean_base64: str) -> str:
        """
        Create a small thumbnail from the image for history storage.
        Returns base64-encoded thumbnail or empty string on failure.
        """
        try:
            from PIL import Image

            decoded = base64.b64decode(clean_base64)
            img = Image.open(io.BytesIO(decoded))

            # Resize maintaining aspect ratio
            img.thumbnail((THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE), Image.LANCZOS)

            # Convert to JPEG for smaller size
            buffer = io.BytesIO()
            # Convert RGBA to RGB if needed
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(buffer, format="JPEG", quality=70)

            return base64.b64encode(buffer.getvalue()).decode("utf-8")

        except ImportError:
            # PIL not available — skip thumbnail generation
            logger.debug("Pillow not installed, skipping thumbnail generation")
            return ""
        except Exception as e:
            logger.debug(f"Thumbnail generation failed (non-critical): {e}")
            return ""


# ─── Helper Functions ───────────────────────────────────────────────────────

def format_enriched_prompt(user_query: str, vision_data: dict) -> str:
    """
    Combine user query with vision-extracted context into an enriched prompt
    that the orchestrator can process through the normal Automation tool flow.
    """
    parts = ["[IMAGE CONTEXT]"]

    desc = vision_data.get("visual_description", "")
    if desc:
        parts.append(desc)

    text = vision_data.get("extracted_text", "")
    if text:
        parts.append(f"Text found in image: '{text}'")

    elements = vision_data.get("identified_elements", [])
    if elements:
        parts.append(f"Key elements: {', '.join(elements)}")

    parts.append(f"[USER REQUEST] {user_query}")

    return " ".join(parts)


def create_vision_processor() -> Optional[VisionProcessor]:
    """
    Factory function to create a VisionProcessor instance.
    Reads API key from environment. Returns None if not configured.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.warning("OPENAI_API_KEY not set — vision module disabled")
        return None

    model = os.getenv("VISION_MODEL", "gpt-4o-mini")

    logger.info(f"Vision module initialized (model: {model})")
    return VisionProcessor(api_key=api_key, model=model)
