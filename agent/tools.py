import json
import logging

logger = logging.getLogger(__name__)

# These are the tool definitions sent to Gemini Live
# Actual execution happens in the Chrome extension via DOM injection
# The agent receives the tool call, packages it as an "action",
# and forwards it to the extension over the same WebSocket

TOOL_DECLARATIONS = [
    {
        "name": "gmail_action",
        "description": "Perform an action on Gmail — read inbox, read an email, compose, or reply. The action is executed via DOM injection in the user's active Gmail tab.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read_inbox", "read_email", "compose_email", "reply_email", "send_email"],
                    "description": "The Gmail action to perform"
                },
                "params": {
                    "type": "object",
                    "description": "Action-specific parameters",
                    "properties": {
                        "count":   {"type": "integer", "description": "Number of emails to read"},
                        "to":      {"type": "string",  "description": "Recipient email address"},
                        "subject": {"type": "string",  "description": "Email subject line"},
                        "body":    {"type": "string",  "description": "Email body text"}
                    }
                }
            },
            "required": ["action"]
        }
    },
    {
        "name": "whatsapp_action",
        "description": "Perform an action on WhatsApp Web — list chats, read messages, or send a message. Executed via DOM injection in the user's active WhatsApp Web tab.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read_chats", "read_messages", "send_message", "open_chat", "confirm_send"],
                    "description": "The WhatsApp action to perform"
                },
                "params": {
                    "type": "object",
                    "description": "Action-specific parameters",
                    "properties": {
                        "contact": {"type": "string", "description": "Contact name to open or message"},
                        "message": {"type": "string", "description": "Message text to send"},
                        "count":   {"type": "integer", "description": "Number of messages to read"}
                    }
                }
            },
            "required": ["action"]
        }
    }
]


def parse_action_from_text(text: str):
    """
    Fallback: if Gemini outputs a JSON action block in text instead of
    a formal tool call, parse it out here.
    """
    try:
        start = text.find("{")
        end = text.rfind("}") + 1
        if start != -1 and end > start:
            return json.loads(text[start:end])
    except Exception:
        pass
    return None
