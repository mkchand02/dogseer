import asyncio
import base64
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types

from system_prompt import SYSTEM_PROMPT
from tools import TOOL_DECLARATIONS, parse_action_from_text

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# ✅ Correct model per official docs — 2.0 is deprecated
GEMINI_MODEL = "gemini-3.1-flash-live-preview"

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found")

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel(GEMINI_MODEL, tools=TOOL_DECLARATIONS)


app = FastAPI(title="DOGSeer Agent", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "agent": "DOGSeer", "model": GEMINI_MODEL}


@app.websocket("/live")
async def live_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("Extension connected")
    await ws.send_json({"type": "status", "value": "connected"})

    try:
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=types.Content(
                parts=[types.Part(text=SYSTEM_PROMPT)]
            ),
            # ✅ Enable transcriptions for both input and output
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )

        async with model.aio.live.connect(
            config=config
        ) as session:
            logger.info(f"Gemini Live session open: {GEMINI_MODEL}")
            await asyncio.gather(
                receive_from_extension(ws, session),
                send_to_extension(ws, session)
            )

    except WebSocketDisconnect:
        logger.info("Extension disconnected")
    except Exception as e:
        logger.error(f"Session error: {e}", exc_info=True)
        try:
            await ws.send_json({"type": "error", "value": str(e)})
        except Exception:
            pass


async def receive_from_extension(ws: WebSocket, session):
    """Handle ALL incoming messages — text (JSON) and binary (audio)"""
    try:
        while True:
            message = await ws.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                # Raw binary = mic audio (webm/opus chunks from MediaRecorder)
                raw = message["bytes"]
                await session.send_realtime_input(
                    audio=types.Blob(data=raw, mime_type="audio/webm;codecs=opus")
                )

            elif "text" in message and message["text"]:
                try:
                    msg = json.loads(message["text"])
                    msg_type = msg.get("type")

                    if msg_type == "frame":
                        # ✅ Screen frame — send as video alongside audio (multimodal)
                        image_bytes = base64.b64decode(msg["data"])
                        await session.send_realtime_input(
                            video=types.Blob(data=image_bytes, mime_type="image/jpeg")
                        )
                        logger.debug("Video frame sent to Gemini")

                    elif msg_type == "end_turn":
                        # ✅ Correct: send audioStreamEnd to flush cached audio
                        await session.send_realtime_input(
                            audio_stream_end=True
                        )
                        logger.info("Audio stream ended (end of turn)")

                    elif msg_type == "action_result":
                        result_text = json.dumps(msg.get("data", {}))
                        await session.send_realtime_input(
                            text=f"Action result: {result_text}"
                        )
                        logger.info(f"Action result: {result_text[:80]}")

                except json.JSONDecodeError:
                    pass

    except Exception as e:
        logger.error(f"receive_from_extension error: {e}")


async def send_to_extension(ws: WebSocket, session):
    """Stream Gemini responses — process ALL parts per event"""
    try:
        async for response in session.receive():
            content = response.server_content

            if not content:
                # Tool calls
                if response.tool_call:
                    for fn in response.tool_call.function_calls:
                        logger.info(f"Tool call: {fn.name} {fn.args}")
                        await ws.send_json({
                            "type":    "action",
                            "tool":    fn.name,
                            "data":    dict(fn.args),
                            "call_id": fn.id
                        })
                continue

            # ✅ Process ALL parts in each event (audio + transcript can arrive together)
            if content.model_turn:
                for part in content.model_turn.parts:
                    if part.inline_data:
                        # PCM16 audio at 24kHz — send as binary
                        await ws.send_bytes(part.inline_data.data)

            # ✅ Input transcription (what user said)
            if content.input_transcription:
                text = content.input_transcription.text
                if text and text.strip():
                    logger.info(f"User said: {text[:80]}")
                    await ws.send_json({"type": "user_transcript", "value": text})

            # ✅ Output transcription (what Gemini said)
            if content.output_transcription:
                text = content.output_transcription.text
                if text and text.strip():
                    logger.info(f"Gemini: {text[:80]}")
                    action = parse_action_from_text(text)
                    if action:
                        await ws.send_json({"type": "action", "data": action})
                    else:
                        await ws.send_json({"type": "transcript", "value": text})

            # ✅ Interruption — tell client to stop playback
            if content.interrupted is True:
                await ws.send_json({"type": "status", "value": "interrupted"})
                logger.info("Gemini interrupted")

    except Exception as e:
        logger.error(f"send_to_extension error: {e}")
