import asyncio
import json
import sys
import os
import tempfile
import logging
import logging.handlers
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv

load_dotenv()

# ── Logging setup ─────────────────────────────────────────────────────────────
# Logs are written to backend/logs/backend.log (rotates at 5MB, keeps 3 backups)
os.makedirs("logs", exist_ok=True)
_log_formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_file_handler = logging.handlers.RotatingFileHandler(
    "logs/backend.log",
    maxBytes=5 * 1024 * 1024,  # 5 MB
    backupCount=3,
    encoding="utf-8",
)
_file_handler.setFormatter(_log_formatter)
_console_handler = logging.StreamHandler(sys.stdout)
_console_handler.setFormatter(_log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[_file_handler, _console_handler])
logger = logging.getLogger("fixsight")

# Redirect bare print() calls to the logger so existing code is captured
class _PrintToLogger:
    def __init__(self, level): self._level = level
    def write(self, msg):
        msg = msg.rstrip()
        if msg: logger.log(self._level, msg)
    def flush(self): pass
    def isatty(self): return False

sys.stdout = _PrintToLogger(logging.INFO)
sys.stderr = _PrintToLogger(logging.ERROR)
# ── End logging setup ──────────────────────────────────────────────────────────

app = FastAPI(title="FixSight Scene Analysis API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazy-load detector — server starts and reports health even when API key is missing.
_detector = None

def get_detector():
    global _detector
    if _detector is None:
        from detector import HazardDetector
        _detector = HazardDetector()
    return _detector


@app.get("/")
def health():
    try:
        d = get_detector()
        return {"status": "running", "service": "FixSight Scene Analysis", "model": d.vlm_model}
    except EnvironmentError as e:
        return {"status": "degraded", "error": str(e)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        # Validate detector on first connection
        try:
            detector = get_detector()
        except EnvironmentError as e:
            await websocket.send_json({
                "event": "error",
                "message": str(e),
                "code": "MISSING_API_KEY",
            })
            await websocket.close()
            return

        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event = payload.get("event")

            # ── Normal scene frame (scan-driven) ─────────────────────────────
            if event == "scene_frame_ready":
                print(f"\n[Backend] 📸 Received scene frame (size: {len(payload.get('full_frame_b64', ''))} chars)")
                print("[Backend] 🧠 Sending to VLM for multi-hazard analysis...")

                result = await asyncio.to_thread(
                    detector.analyze_scene,
                    payload["full_frame_b64"],
                    payload.get("hazard_focus_bbox", []),
                    payload.get("session_id", "default"),
                    payload.get("device_context", {}),
                )

                hazard_count = len(result.get("hazards", []))
                top_risk = result.get("risk_level", "?")
                print(f"[Backend] ✅ Analysis complete — {hazard_count} hazard(s), top risk: {top_risk}")
                await websocket.send_json(result)

            # ── Chat frame (Ask AI mode — Phase 5) ───────────────────────────
            elif event == "chat_frame_query":
                user_msg = payload.get("user_message", "")
                print(f"\n[Backend] 💬 Chat query received: \"{user_msg[:60]}\"")
                print("[Backend] 🧠 Sending frame + text to VLM...")

                result = await asyncio.to_thread(
                    detector.analyze_with_chat,
                    payload["full_frame_b64"],
                    user_msg,
                    payload.get("session_id", "default"),
                    payload.get("device_context", {}),
                    payload.get("conversation_history", []),
                )

                print(f"[Backend] ✅ Chat analysis complete — reply: \"{str(result.get('chat_reply', ''))[:60]}\"")
                await websocket.send_json(result)

    except WebSocketDisconnect:
        print("\n[Backend] Client disconnected from WebSocket.")
    except Exception as e:
        try:
            await websocket.send_json({"event": "error", "message": str(e)})
        except Exception:
            pass


@app.post("/reset")
def reset():
    if _detector:
        _detector.sessions.clear()
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe_endpoint(file: UploadFile = File(...)):
    try:
        suffix = os.path.splitext(file.filename)[1] if file.filename else ".m4a"
        if not suffix:
            suffix = ".m4a"
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
        
        try:
            api_keys_str = os.environ.get("GROQ_API_KEY", "")
            api_keys = [k.strip() for k in api_keys_str.split(",") if k.strip()]
            if not api_keys:
                raise HTTPException(status_code=500, detail="GROQ_API_KEY is not configured")
            
            from groq import Groq
            transcription = None
            last_err = None
            for key in api_keys:
                try:
                    client = Groq(api_key=key)
                    with open(tmp_path, "rb") as audio_file:
                        transcription = client.audio.transcriptions.create(
                            file=(os.path.basename(tmp_path), audio_file.read()),
                            model="whisper-large-v3",
                            prompt="The audio is spoken in English.",
                            response_format="verbose_json",
                            language="en",
                        )
                    break
                except Exception as e:
                    err_str = str(e).lower()
                    last_err = e
                    if "429" in err_str or "rate limit" in err_str:
                        print(f"[Backend] Transcription 429 hit. Trying next key...")
                        continue
                    else:
                        break
                        
            if not transcription:
                raise last_err or Exception("Transcription failed.")
            
            text = transcription.text
            language = getattr(transcription, 'language', 'en')
            print(f"[Backend] 🎤 Transcribed text: \"{text}\" (Language: {language})")
            return {"text": text, "language": language}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        print(f"[Backend] ❌ Transcription error: {e}")
        return {"error": str(e)}


class ChatRequest(BaseModel):
    full_frame_b64: Optional[str] = None
    user_message: str
    session_id: str = "default"
    device_context: Dict[str, Any] = {}
    conversation_history: List[Any] = []
    scene_id: Optional[str] = None
    scene_summary: Optional[Dict[str, Any]] = None
    detected_language: str = "en"
    recent_turns: List[Any] = []

@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.analyze_with_chat,
            req.full_frame_b64,
            req.user_message,
            req.session_id,
            req.device_context,
            req.conversation_history,
            req.scene_id,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

from fastapi.responses import StreamingResponse

@app.post("/stream-chat")
async def stream_chat_endpoint(req: ChatRequest):
    detector = get_detector()
    print(f"[Backend] 🎙️ Voice stream-chat: '{req.user_message[:60]}' | scene_id={req.scene_id} | lang={req.detected_language}")
    print(f"[Backend] 📸 Scene summary received: {req.scene_summary}")
    
    async def event_generator():
        try:
            async for chunk in detector.analyze_with_chat_stream(
                req.full_frame_b64,
                req.user_message,
                req.session_id,
                req.device_context,
                req.recent_turns,
                req.scene_id,
                req.scene_summary,
                req.detected_language
            ):
                payload = f"data: {json.dumps(chunk)}\n\n"
                print(f"[Backend] ⚡ Stream chunk: {json.dumps(chunk)[:80]}")
                yield payload
            yield "data: [DONE]\n\n"
        except Exception as e:
            print(f"[Backend] ❌ Stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )

class ToolFrameRequest(BaseModel):
    tool_call_id: str
    frame_b64: str

@app.post("/submit-tool-frame")
async def submit_tool_frame_endpoint(req: ToolFrameRequest):
    detector = get_detector()
    print(f"[Backend] 🖼️ Received tool frame upload for {req.tool_call_id}")
    detector.lazy_frames[req.tool_call_id] = req.frame_b64
    
    if req.tool_call_id in detector.lazy_events:
        detector.lazy_events[req.tool_call_id].set()
        
    return {"status": "ok"}

class IdentifyDeviceRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device_context: dict = {}
    session_id: Optional[str] = "default"

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""

class ScanSceneRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device_context: dict = {}
    session_id: Optional[str] = "default"

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""

class AnalyzeComponentsRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device: Optional[str] = "AC Induction Motor"
    device_context: dict = {}
    session_id: Optional[str] = "default"

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""

class TroubleshootRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device: Optional[str] = "AC Induction Motor"
    question: Optional[str] = None
    issue: Optional[str] = None
    component_id: Optional[str] = None
    device_context: dict = {}
    session_id: Optional[str] = "default"
    scene_id: Optional[str] = None

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""

    def get_issue(self) -> str:
        return self.question or self.issue or "General issue"

class ExplainRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device: Optional[str] = "AC Induction Motor"
    component: Optional[str] = None
    component_id: Optional[str] = None
    device_context: dict = {}
    session_id: Optional[str] = "default"
    scene_id: Optional[str] = None

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""

    def get_component(self) -> str:
        return self.component or self.component_id or ""

class GuideRequest(BaseModel):
    image: Optional[str] = None
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    device: Optional[str] = "AC Induction Motor"
    component_id: Optional[str] = None
    device_context: dict = {}
    session_id: Optional[str] = "default"
    scene_id: Optional[str] = None

    def get_image(self) -> str:
        return self.image or self.image_b64 or self.full_frame_b64 or ""


@app.post("/scan-scene")
async def scan_scene_endpoint(req: ScanSceneRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.scan_scene,
            req.get_image(),
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/identify-device")
async def identify_device_endpoint(req: IdentifyDeviceRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.identify_device,
            req.get_image(),
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/analyze-components")
async def analyze_components_endpoint(req: AnalyzeComponentsRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.analyze_components,
            req.get_image(),
            req.device,
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/mode/troubleshoot")
async def troubleshoot_endpoint(req: TroubleshootRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.troubleshoot_device,
            req.get_image(),
            req.device,
            req.component_id,
            req.get_issue(),
            req.device_context,
            req.scene_id,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/mode/explain")
async def explain_endpoint(req: ExplainRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.explain_component,
            req.get_image(),
            req.device,
            req.get_component(),
            req.device_context,
            req.scene_id,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/mode/guide")
async def guide_endpoint(req: GuideRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.guide_procedure,
            req.get_image(),
            req.device,
            req.component_id,
            req.device_context,
            req.scene_id,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}


class VerifySceneRequest(BaseModel):
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    scene_id: Optional[str] = None
    previous_scene_summary: Optional[str] = None
    current_step_context: Optional[str] = None
    device_context: dict = {}

    def get_image(self) -> str:
        return self.image_b64 or self.full_frame_b64 or ""


class RefreshSceneRequest(BaseModel):
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    scene_id: Optional[str] = None          # existing scene_id to UPDATE (not create new)
    device_context: dict = {}
    device_name: Optional[str] = None

    def get_image(self) -> str:
        return self.image_b64 or self.full_frame_b64 or ""


class PlanInteractiveTaskRequest(BaseModel):
    user_request: str
    device_context: dict = {}

class EvaluateInteractiveStepRequest(BaseModel):
    image_b64: Optional[str] = None
    full_frame_b64: Optional[str] = None
    task_state: dict
    device_context: dict = {}

    def get_image(self) -> str:
        return self.image_b64 or self.full_frame_b64 or ""


@app.post("/plan-interactive-task")
async def plan_interactive_task_endpoint(req: PlanInteractiveTaskRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.plan_interactive_task,
            req.user_request,
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}

@app.post("/evaluate-interactive-step")
async def evaluate_interactive_step_endpoint(req: EvaluateInteractiveStepRequest):
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.evaluate_interactive_step,
            req.get_image(),
            req.task_state,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}


@app.post("/verify-scene")
async def verify_scene_endpoint(req: VerifySceneRequest):
    """Quick scene verification — asks VLM if the current task was completed.
    Much cheaper than a full scan. Use after the user says 'done', 'next', 'removed it', etc."""
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.verify_scene_state,
            req.get_image(),
            req.scene_id,
            req.previous_scene_summary,
            req.current_step_context,
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}


@app.post("/refresh-scene")
async def refresh_scene_endpoint(req: RefreshSceneRequest):
    """Full scene re-analysis — use when camera changed significantly (new object, camera moved far).
    Updates scene_memory in place and returns an updated scene_id."""
    try:
        detector = get_detector()
        result = await asyncio.to_thread(
            detector.refresh_scene,
            req.get_image(),
            req.scene_id,
            req.device_name,
            req.device_context,
        )
        return result
    except Exception as e:
        return {"event": "error", "message": str(e)}


# ── /ground-label ──────────────────────────────────────────────────────────────
# Calls Moondream to:
#   1. Identify which parts are relevant to the user query (via /query)
#   2. Point at each part (via /point) to get normalized (x, y) coordinates
# Returns a list of labels ready for ARBridge.hitTest() on the frontend.
# ──────────────────────────────────────────────────────────────────────────────

try:
    import httpx
    _httpx_available = True
except ImportError:
    _httpx_available = False
    logger.warning("[ground-label] httpx not installed. Run: pip install httpx")

_moondream_key_index = 0

def _get_moondream_key() -> str:
    global _moondream_key_index
    raw = os.environ.get("MOONDREAM_API_KEY", "")
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        return ""
    key = keys[_moondream_key_index % len(keys)]
    _moondream_key_index += 1
    return key


class GroundLabelRequest(BaseModel):
    image_b64: str              # JPEG base64 from ARBridge.captureFrame()
    query: str                  # The user's voice query or mode context
    max_labels: int = 3         # Limit labels to keep UI uncluttered


@app.post("/ground-label")
async def ground_label_endpoint(req: GroundLabelRequest):
    """
    Calls Moondream to identify and spatially locate relevant components.
    Returns: [{ id, label, instruction, xNorm, yNorm, confidence }]
    These coordinates are passed to ARBridge.hitTest() on the frontend.
    """
    if not _httpx_available:
        raise HTTPException(status_code=503, detail="httpx not installed on server")

    key = _get_moondream_key()
    if not key:
        raise HTTPException(status_code=500, detail="MOONDREAM_API_KEY not configured")

    image_url = f"data:image/jpeg;base64,{req.image_b64}"
    headers = {
        "X-Moondream-Auth": key,
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: Ask Moondream which parts are relevant to this query
        try:
            r1 = await client.post(
                "https://api.moondream.ai/v1/query",
                headers=headers,
                json={
                    "image_url": image_url,
                    "question": (
                        f"Identify up to {req.max_labels} visible components or parts of this machine "
                        f"that are most relevant to: \"{req.query}\". "
                        f"Respond ONLY with JSON in this exact format: "
                        f'{{\"parts\":[{{\"label\":\"Part Name\",\"instruction\":\"What to do\"}}]}}'
                    ),
                    "stream": False,
                }
            )
            r1.raise_for_status()
            answer_text = r1.json().get("answer", "{}")
            # Clean up potential markdown wrapping
            answer_text = answer_text.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
            parts_data = json.loads(answer_text).get("parts", [])[:req.max_labels]
        except Exception as e:
            logger.warning(f"[ground-label] Step 1 (query) failed: {e}")
            return {"labels": []}

        if not parts_data:
            return {"labels": []}

        # Step 2: Point at each identified part in parallel
        async def point_at_part(part: dict, idx: int) -> Optional[dict]:
            try:
                r2 = await client.post(
                    "https://api.moondream.ai/v1/point",
                    headers=headers,
                    json={
                        "image_url": image_url,
                        "object": part.get("label", ""),
                        "stream": False,
                    }
                )
                r2.raise_for_status()
                pts = r2.json().get("points", [])
                if not pts:
                    return None
                pt = pts[0]
                label_slug = part["label"].lower().replace(" ", "_")
                return {
                    "id": f"{label_slug}_{int(asyncio.get_event_loop().time() * 1000)}_{idx}",
                    "label": part.get("label", "Component"),
                    "instruction": part.get("instruction", ""),
                    "xNorm": float(pt.get("x", 0.5)),
                    "yNorm": float(pt.get("y", 0.5)),
                    "confidence": 0.9,
                }
            except Exception as e:
                logger.warning(f"[ground-label] Step 2 point failed for '{part.get('label')}': {e}")
                return None

        tasks = [point_at_part(p, i) for i, p in enumerate(parts_data)]
        results = await asyncio.gather(*tasks)
        labels = [r for r in results if r is not None]

    logger.info(f"[ground-label] query='{req.query[:40]}' → {len(labels)} label(s) placed")
    return {"labels": labels}