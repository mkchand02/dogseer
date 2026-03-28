import asyncio
import base64
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import google.genai as genai
from google.genai import types

from system_prompt import SYSTEM_PROMPT
from tools import TOOL_DECLARATIONS, parse_action_from_text

# ── env & logging ────────────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL   = "gemini-2.5-flash-preview-native-audio-dialog"

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found — check your .env file")

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="DOGSeer Agent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten this post-hackathon
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok", "agent": "DOGSeer"}

# ── Gemini client ─────────────────────────────────────────────────────────────
client = genai.Client(api_key=GEMINI_API_KEY)

# ── WebSocket endpoint ────────────────────────────────────────────────────────
@app.websocket("/live")
async def live_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("Extension connected")

    # Send status to extension UI
    await ws.send_json({"type": "status", "value": "connected"})

    try:
        # ── Build Gemini Live config ──────────────────────────────────────
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO", "TEXT"],
            system_instruction=SYSTEM_PROMPT,
            tools=[{"function_declarations": TOOL_DECLARATIONS}],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Aoede"   # warm, calm female voice
                    )
                )
            )
        )

        # ── Open Gemini Live session ──────────────────────────────────────
        async with client.aio.live.connect(
            model=GEMINI_MODEL,
            config=config
        ) as session:
            logger.info("Gemini Live session open")

            # Run send and receive concurrently
            await asyncio.gather(
                receive_from_extension(ws, session),
                send_to_extension(ws, session)
            )

    except WebSocketDisconnect:
        logger.info("Extension disconnected")
    except Exception as e:
        logger.error(f"Session error: {e}")
        await ws.send_json({"type": "error", "value": str(e)})


# ── Receive from extension → forward to Gemini ───────────────────────────────
async def receive_from_extension(ws: WebSocket, session):
    """
    Reads messages from the Chrome extension and forwards them to Gemini Live.
    
    Message formats from extension:
      Binary frames  → raw PCM16 audio bytes
      JSON text:
        {"type": "frame",    "data": "<base64 JPEG>"}   screen frame
        {"type": "end_turn"}                             user released SPACE
        {"type": "action_result", "data": {...}}         DOM action result
    """
    async for message in ws.iter_text():
        try:
            msg = json.loads(message)
            msg_type = msg.get("type")

            if msg_type == "frame":
                # Screen frame → send as inline image to Gemini
                image_bytes = base64.b64decode(msg["data"])
                await session.send(
                    input=types.LiveClientRealtimeInput(
                        media_chunks=[
                            types.Blob(
                                mime_type="image/jpeg",
                                data=image_bytes
                            )
                        ]
                    )
                )

            elif msg_type == "end_turn":
                # User released SPACE — signal Gemini to respond
                await session.send(input=".", end_of_turn=True)
                logger.info("End of turn sent to Gemini")

            elif msg_type == "action_result":
                # DOM action completed — send result back to Gemini so it can narrate
                result_text = json.dumps(msg.get("data", {}))
                await session.send(
                    input=f"Action completed. Here is the result: {result_text}",
                    end_of_turn=True
                )

        except json.JSONDecodeError:
            # Binary audio frame — send as PCM16 audio
            pass

    async for raw in ws.iter_bytes():
        await session.send(
            input=types.LiveClientRealtimeInput(
                media_chunks=[
                    types.Blob(
                        mime_type="audio/pcm",
                        data=raw
                    )
                ]
            )
        )


# ── Receive from Gemini → forward to extension ───────────────────────────────
async def send_to_extension(ws: WebSocket, session):
    """
    Reads responses from Gemini Live and forwards them to the extension.

    Gemini can respond with:
      - Audio bytes     → stream back as binary for immediate playback
      - Text            → check if it contains an action JSON block
      - Tool call       → package as action message for DOM injection
    """
    async for response in session:

        # ── Audio response ────────────────────────────────────────────────
        if response.data:
            await ws.send_bytes(response.data)

        # ── Text response ─────────────────────────────────────────────────
        if response.text:
            text = response.text
            logger.info(f"Gemini text: {text[:80]}...")

            # Check if Gemini embedded an action JSON in its text response
            action = parse_action_from_text(text)
            if action:
                await ws.send_json({
                    "type": "action",
                    "data": action
                })
            else:
                # Plain narration — send for TTS fallback display
                await ws.send_json({
                    "type": "transcript",
                    "value": text
                })

        # ── Tool call response ────────────────────────────────────────────
        if response.tool_call:
            for fn in response.tool_call.function_calls:
                logger.info(f"Tool call: {fn.name} params={fn.args}")
                await ws.send_json({
                    "type":   "action",
                    "tool":   fn.name,
                    "data":   dict(fn.args),
                    "call_id": fn.id
                })
                # Status update so UI shows "thinking"
                await ws.send_json({
                    "type":  "status",
                    "value": "waiting_for_action"
                })

