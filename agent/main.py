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
GEMINI_MODEL   = "gemini-3.1-flash-live-preview"

if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found")

client = genai.Client(api_key=GEMINI_API_KEY)

app = FastAPI(title="DOGSeer Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return {"status": "ok", "agent": "DOGSeer"}


@app.websocket("/live")
async def live_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("Extension connected")
    await ws.send_json({"type": "status", "value": "connected"})

    try:
        # Minimal config — no tools, no voice config, just get it connecting
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=SYSTEM_PROMPT,
        )

        async with client.aio.live.connect(
            model=GEMINI_MODEL,
            config=config
        ) as session:
            logger.info("Gemini Live session open")
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
    async for message in ws.iter_text():
        try:
            msg = json.loads(message)
            msg_type = msg.get("type")

            if msg_type == "frame":
                image_bytes = base64.b64decode(msg["data"])
                await session.send_realtime_input(
                    video=types.Blob(data=image_bytes, mime_type="image/jpeg")
                )

            elif msg_type == "end_turn":
                await session.send_realtime_input(text=".")
                logger.info("End of turn sent")

            elif msg_type == "action_result":
                result_text = json.dumps(msg.get("data", {}))
                await session.send_realtime_input(
                    text=f"Action result: {result_text}"
                )

        except json.JSONDecodeError:
            pass

    async for raw in ws.iter_bytes():
        await session.send_realtime_input(
            audio=types.Blob(data=raw, mime_type="audio/pcm;rate=16000")
        )


async def send_to_extension(ws: WebSocket, session):
    async for response in session.receive():
        content = response.server_content

        if not content:
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

        if content.model_turn:
            for part in content.model_turn.parts:
                if part.inline_data:
                    await ws.send_bytes(part.inline_data.data)

        if content.output_transcription:
            text = content.output_transcription.text
            if text:
                logger.info(f"Transcript: {text[:80]}")
                action = parse_action_from_text(text)
                if action:
                    await ws.send_json({"type": "action", "data": action})
                else:
                    await ws.send_json({"type": "transcript", "value": text})

        if content.interrupted:
            await ws.send_json({"type": "status", "value": "interrupted"})
