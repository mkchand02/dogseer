import json
import logging
from google.genai import types

logger = logging.getLogger(__name__)


def get_tool_declarations():
    """Return properly typed Tool objects for Gemini Live API"""
    return [
        types.Tool(function_declarations=[
            types.FunctionDeclaration(
                name="gmail_action",
                description="Perform an action on Gmail — read inbox, read an email, compose, or reply.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "action": types.Schema(
                            type=types.Type.STRING,
                            enum=["read_inbox", "read_email", "compose_email", "reply_email", "send_email"],
                            description="The Gmail action to perform"
                        ),
                        "params": types.Schema(
                            type=types.Type.OBJECT,
                            description="Action-specific parameters",
                            properties={
                                "count":   types.Schema(type=types.Type.INTEGER, description="Number of emails to read"),
                                "to":      types.Schema(type=types.Type.STRING,  description="Recipient email address"),
                                "subject": types.Schema(type=types.Type.STRING,  description="Email subject line"),
                                "body":    types.Schema(type=types.Type.STRING,  description="Email body text"),
                            }
                        ),
                    },
                    required=["action"]
                )
            ),
            types.FunctionDeclaration(
                name="whatsapp_action",
                description="Perform an action on WhatsApp Web — list chats, read messages, or send a message.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "action": types.Schema(
                            type=types.Type.STRING,
                            enum=["read_chats", "read_messages", "send_message", "open_chat", "confirm_send"],
                            description="The WhatsApp action to perform"
                        ),
                        "params": types.Schema(
                            type=types.Type.OBJECT,
                            description="Action-specific parameters",
                            properties={
                                "contact": types.Schema(type=types.Type.STRING,  description="Contact name"),
                                "message": types.Schema(type=types.Type.STRING,  description="Message text"),
                                "count":   types.Schema(type=types.Type.INTEGER, description="Number of messages to read"),
                            }
                        ),
                    },
                    required=["action"]
                )
            ),
        ])
    ]


# Keep for backward compat
TOOL_DECLARATIONS = []


def parse_action_from_text(text: str):
    """Fallback: parse JSON action block from Gemini text output"""
    try:
        start = text.find("{")
        end   = text.rfind("}") + 1
        if start != -1 and end > start:
            return json.loads(text[start:end])
    except Exception:
        pass
    return None
