import os
import time
import json
import uuid
import csv
import re
import asyncio
from dotenv import load_dotenv
from groq import Groq
from prompts.relational_vlm import SYSTEM_PROMPT

# Load environment variables on startup
load_dotenv(override=True)

# ── Universal device scope (injected into all VLM prompts) ────────────────────
# Keep this list in ONE place so every prompt stays consistent.
DEVICE_SCOPE = (
    "The device can be ANY electrical, electronic, or mechanical equipment, including:\n"
    "  \u2022 HVAC & Climate: air conditioner (split AC, window AC, central AC, inverter AC), "
    "    air cooler, ceiling fan, exhaust fan, air purifier, dehumidifier, room heater\n"
    "  \u2022 Kitchen Appliances: refrigerator, microwave oven, electric oven, toaster, "
    "    mixer grinder, juicer, dishwasher, induction cooktop, electric kettle, coffee maker\n"
    "  \u2022 Laundry: washing machine (top-load, front-load), tumble dryer, iron\n"
    "  \u2022 Entertainment & Computing: television, monitor, desktop PC, laptop, tablet, "
    "    projector, speaker, soundbar, set-top box, gaming console\n"
    "  \u2022 Networking: Wi-Fi router, modem, network switch, access point, UPS, power strip\n"
    "  \u2022 Water & Sanitation: water heater / geyser, water purifier (RO), water pump, "
    "    submersible pump, electric shower\n"
    "  \u2022 Industrial / Commercial: AC induction motor, servo motor, pump, compressor, "
    "    generator, transformer, electrical panel / switchboard, inverter, solar panel, "
    "    welding machine, CNC machine, conveyor motor\n"
    "  \u2022 Lighting: LED driver, ballast, smart bulb, emergency light\n"
    "  \u2022 Medical: nebuliser, CPAP, ECG machine, oximeter, blood pressure monitor\n"
    "  \u2022 Vehicles & Charging: EV charger, battery charger, electric scooter panel\n"
    "  \u2022 Tools: power drill, angle grinder, circular saw, electric screwdriver\n"
    "  \u2022 Other: any electrical / electronic device not listed above\n"
    "\nIMPORTANT: Identify what is ACTUALLY visible. "
    "Do NOT default to 'motor' or 'industrial equipment' unless that is genuinely what appears in the image."
)

class HazardDetector:
    def __init__(self):
        groq_keys = [k.strip() for k in os.getenv("GROQ_API_KEY", "").split(",") if k.strip()]
        if not groq_keys or groq_keys[0] == "your_key_here":
            raise EnvironmentError(
                "\n\n[FixSight] GROQ_API_KEY is not set or is still the placeholder value.\n"
                "Set it in backend/.env before starting the server.\n"
            )

        self.groq_clients = [Groq(api_key=k) for k in groq_keys]
        self.current_groq_idx = 0
        self.client = self.groq_clients[self.current_groq_idx]
        
        self.llm_model = "llama-3.3-70b-versatile"
        self.llm_fallback_model = "llama-3.1-8b-instant"  # 500K TPD fallback when 70B hits daily limit
        self.vlm_model = "pixtral-12b-2409"
        self.groq_vlm_model = "meta-llama/llama-4-scout-17b-16e-instruct"

        # Initialize Mistral SDK client if key is present
        mistral_keys = [k.strip() for k in os.getenv("MISTRAL_API_KEY", "").split(",") if k.strip()]
        self.mistral_clients = []
        self.mistral_client = None
        if mistral_keys:
            try:
                from mistralai.client import Mistral
                self.mistral_clients = [Mistral(api_key=k) for k in mistral_keys]
                self.current_mistral_idx = 0
                self.mistral_client = self.mistral_clients[self.current_mistral_idx]
                print(f"[Detector] Mistral SDK initialized with {len(self.mistral_clients)} keys.")
            except Exception as mistral_init_err:
                print(f"[Warning] Mistral SDK init failed: {type(mistral_init_err).__name__}: {mistral_init_err}")
                
        # In-memory session state (SRS §16.1)
        self.sessions: dict[str, dict] = {}
        self.scene_memory: dict[str, dict] = {}
        
        # Lazy frame upload tracking (Tool Call architecture)
        self.lazy_frames: dict[str, str] = {}
        self.lazy_events: dict[str, asyncio.Event] = {}
        
        # VLM Result Cache: scene_id -> {"timestamp": float, "result": dict}
        import time
        self._vlm_cache: dict[str, dict] = {}
        self._VLM_CACHE_TTL = 8.0  # seconds — reuse VLM result within this window
        
        # File paths for tracking logs (expected by unit tests)
        self.csv_log_file = "detections_log.csv"
        self.detected_hazards_file = "detected_hazards.csv"
        self.non_hazards_file = "non_hazards.csv"
        
    def rotate_groq_client(self):
        self.current_groq_idx = (self.current_groq_idx + 1) % len(self.groq_clients)
        self.client = self.groq_clients[self.current_groq_idx]
        print(f"[Detector] Rotated Groq client to index {self.current_groq_idx}")

    def rotate_mistral_client(self):
        if self.mistral_clients:
            self.current_mistral_idx = (self.current_mistral_idx + 1) % len(self.mistral_clients)
            self.mistral_client = self.mistral_clients[self.current_mistral_idx]
            print(f"[Detector] Rotated Mistral client to index {self.current_mistral_idx}")

        # Category tracking maps (expected by unit tests)
        self.names = {0: "person", 1: "fire", 2: "smoke"}

    # ──────────────────────────────────────────────────────────────
    # Primary analysis — scan-driven (no user text)
    # ──────────────────────────────────────────────────────────────
    def analyze_scene(
        self,
        full_frame_b64: str,
        hazard_focus_bbox: list,
        session_id: str,
        device_context: dict,
    ) -> dict:
        """Analyse a camera frame using Pixtral-12B (VLM) + Llama 3.3 70B (LLM)."""
        try:
            jpeg_b64 = self._ensure_jpeg(full_frame_b64)
            
            # Step 1: Call VLM (Pixtral) to get scene understanding and object coordinate detection
            vlm_prompt = (
                "Analyze the image and provide a detailed visual description of the scene under the heading "
                "'**Scene Understanding/Description:**'. "
                "Identify all objects, hazards, tools, and people. Output a JSON block under the heading "
                "'**Object Detection:**' containing a key 'detections' which is a list of objects and "
                "their normalized 2D bounding boxes [x1, y1, x2, y2] (0.0 to 1.0 range)."
            )
            vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)
            
            # Extract detections for logging
            detections, _ = self.parse_pixtral_response(vlm_response, 640, 480)
            self.append_detections_to_csv(detections)

            # Step 2: Call LLM (Llama 3.3 70B) to reason over visual context and synthesize the final JSON scene graph
            llm_user_prompt = f"""
Visual scene analysis from VLM:
---
{vlm_response}
---
Device context: {device_context}.
Tracker hint box (normalized): {hazard_focus_bbox if hazard_focus_bbox else []}.

Synthesize a complete safety scene graph strictly conforming to the system prompt JSON schema.
Make sure you map the spatial target coordinates from the detections above, categorize threat levels, and construct detailed remediation steps.
"""
            llm_response = self._call_groq_llm(SYSTEM_PROMPT, llm_user_prompt)
            result = json.loads(llm_response)
            
            # Normalise response structures
            result["event"] = "scene_analysis_complete"
            if not result.get("scene_id"):
                result["scene_id"] = str(uuid.uuid4())
                
            # Backwards compatibility formatting
            if result.get("hazards") and len(result["hazards"]) > 0:
                top = result["hazards"][0]
                result.setdefault("primary_hazard", top.get("title", ""))
                result.setdefault("risk_level", top.get("risk_level", "LOW"))
                result.setdefault("summary", top.get("summary", ""))
                result.setdefault("fallback_plan", top.get("fallback_plan", ""))
                result.setdefault("confidence", top.get("confidence", 0.0))
                result.setdefault("guidance", top.get("guidance", {}))
                
            result.setdefault("spatial_targets", [])
            result.setdefault("hazards", [])
            result.setdefault("selected_hazard_id", None)
            result.setdefault("general_solutions", [])
            
            self.sessions[session_id] = {
                "last_hazards": [h.get("id") for h in result.get("hazards", [])],
                "last_risk": result.get("risk_level"),
                "last_scene_id": result.get("scene_id"),
            }
            
            return result
        except Exception as e:
            return self._fallback_response(str(e))

    # ──────────────────────────────────────────────────────────────
    # Chat analysis — user text + frame (Phase 5)
    # ──────────────────────────────────────────────────────────────
    def analyze_with_chat(
        self,
        full_frame_b64: str,
        user_message: str,
        session_id: str,
        device_context: dict,
        conversation_history: list | None = None,
        scene_id: str = None,
    ) -> dict:
        """Analyse a camera frame in the context of user chat using Pixtral-12B + Llama 3.3 70B."""
        try:
            from prompts.chat_vlm import CHAT_SYSTEM_PROMPT

            history = conversation_history or []
            
            if scene_id and scene_id in self.scene_memory:
                vlm_response = self.scene_memory[scene_id].get("vlm_scene_description")
            else:
                jpeg_b64 = self._ensure_jpeg(full_frame_b64)
                # Step 1: Call VLM (Pixtral) to analyze details relevant to the question
                vlm_prompt = (
                    f"Analyze the image in the context of the user question: '{user_message}'. "
                    "Provide a detailed description of the scene under the heading '**Scene Understanding/Description:**'. "
                    "Identify all objects, components, tools, and people. Output a JSON block under the heading "
                    "'**Object Detection:**' containing a key 'detections' which is a list of objects and "
                    "their normalized 2D bounding boxes [x1, y1, x2, y2] (0.0 to 1.0 range)."
                )
                vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            # Step 2: Call LLM (Llama 3.3 70B) to reason over the chat history, VLM analysis, and output the response
            llm_user_prompt = f"""
Visual scene analysis from VLM:
---
{vlm_response}
---
User question: "{user_message}"
Conversation history: {history}
Device context: {device_context}.

Address the user question directly in the 'chat_reply' field (1-3 plain sentences) and fill out the complete component analysis schema. Map the target referred to by your answer in 'chat_focus_target_id'.
"""
            llm_response = self._call_groq_llm(CHAT_SYSTEM_PROMPT, llm_user_prompt)
            result = json.loads(llm_response)
            
            # Normalise response structures
            result["event"] = "scene_analysis_complete"
            if not result.get("scene_id"):
                result["scene_id"] = str(uuid.uuid4())

            result.setdefault("spatial_targets", [])
            result.setdefault("general_solutions", [])
            result.setdefault("chat_reply", "")
            result.setdefault("chat_focus_target_id", None)
            
            self.sessions[session_id] = {
                "last_chat_reply": result.get("chat_reply"),
            }
            return result
        except Exception as e:
            return self._fallback_response(str(e))


    async def analyze_with_chat_stream(
        self,
        full_frame_b64: str,
        user_message: str,
        session_id: str,
        device_context: dict,
        recent_turns: list | None = None,
        scene_id: str = None,
        scene_summary: dict = None,
        detected_language: str = "en"
    ):
        """Stream chat analysis with LLM Tool Calling and lazy frame upload."""
        try:
            from prompts.chat_vlm import CHAT_SYSTEM_PROMPT
            import uuid
            
            history = recent_turns or []
            
            import time as _time
            
            # Memory initialization
            if scene_id and scene_id not in self.scene_memory:
                self.scene_memory[scene_id] = {
                    "previous_scene_memory": "None.",
                    "current_scene_memory": "None.",
                    "conversation_context": "Initial session state.",
                    "objects": {},
                    "active_object_id": None,
                }
            
            # Skip routing for noise / very short transcriptions (avoids spurious VLM calls)
            if len(user_message.strip().split()) <= 2 and not any(c.isalpha() for c in user_message):
                yield {"type": "ar_context", "highlight_target": None, "show_arrow": False}
                yield {"type": "sentence", "text": "Sorry, I didn't catch that clearly. Could you say that again?"}
                return

            # Semantic memory injection — only current_scene_memory shown to routing LLM
            mem = self.scene_memory.get(scene_id, {}) if scene_id else {}
            
            objects = mem.get("objects", {})
            active_obj_id = mem.get("active_object_id")
            active_obj_data = objects.get(active_obj_id, {}) if active_obj_id else {}
            
            previous_objects_desc = [
                odata["scene_memory"]
                for oid, odata in objects.items()
                if oid != active_obj_id and odata.get("scene_memory")
            ]
            prev_objects_context = ""
            if previous_objects_desc:
                prev_objects_context = (
                    "\n\nPREVIOUSLY SEEN OBJECTS IN THIS SESSION (remember but do NOT volunteer unless user explicitly asks):\n"
                    + "\n".join(f"- {d}" for d in previous_objects_desc)
                )

            if scene_summary and scene_summary.get("device"):
                device_name = scene_summary.get('device', 'a device')
                state = scene_summary.get('currentState', 'an unknown state')
                warnings = scene_summary.get('warnings', [])
                warnings_str = " No active warnings." if not warnings else f" Active warnings include: {', '.join(warnings)}."
                
                paragraph = f"The user is currently inspecting {device_name}. The system is in {state}.{warnings_str}"
                
                current_mem = active_obj_data.get('scene_memory') or mem.get('current_scene_memory', '')
                if current_mem and current_mem != 'None.':
                    paragraph += f" Visually, the scene shows: {current_mem}"
                    
                vlm_context = paragraph + prev_objects_context
                conv_context = mem.get('conversation_context', 'User is looking at a known device component.')
                print(f"[Detector] 🧠 Generated Routing Context:\n{vlm_context}")
            elif scene_id:
                current_mem = mem.get('current_scene_memory', 'None.')
                vlm_context = current_mem  # Only current! Previous is NOT shown to avoid LLM confusion.
                conv_context = mem.get('conversation_context', 'Initial session state.')
            else:
                vlm_context = "No visual context."
                conv_context = "No session context."

            current_mem_known = vlm_context not in ("None.", "No visual context.", "")
            system_prompt = f"""
{CHAT_SYSTEM_PROMPT}

CURRENT SCENE MEMORY:
{vlm_context}

DECISION POLICY FOR TOOLS:
You have one vision tool: 'inspect_current_scene'.

RULE 1 — MAXIMUM EFFICIENCY: If the information in CURRENT SCENE MEMORY is sufficient to understand what the user is talking about, DO NOT call vision.
RULE 2 — GENERAL KNOWLEDGE: If the user asks a how-to or general knowledge question about the object in memory (e.g., "how do I fix it?"), use your internal knowledge. DO NOT call vision.
RULE 3 — CALL vision ONLY if:
  - The current scene memory is empty (shows "None.")
  - The user explicitly mentions a NEW object NOT described in the memory (e.g. camera moved to a remote when memory shows a laptop)
  - The user asks to verify a physical action or read text/labels that are not yet known

If the camera is obstructed, use 'request_better_view'.
"""

            routing_user_prompt = f"""
Conversation Context: {conv_context}
Detected language: {detected_language}

User Question: "{user_message}"

Based on the DECISION POLICY above:
- Can you answer the user's question using your internal knowledge combined with the Current Scene Memory? If YES → do NOT call any tool.
- Does the user's question require a NEW visual inspection of the physical world (e.g., asking "what is this new thing", or "did I do it right")? If YES → call inspect_current_scene.

Tool Available: inspect_current_scene() | Current frame available: YES
"""
            tools = [
                {
                    "type": "function",
                    "function": {
                        "name": "inspect_current_scene",
                        "description": "Inspects the live camera feed to get the current physical state of the scene. Returns structured world-state changes.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "reason": {"type": "string", "description": "Why you need to inspect the scene"}
                            },
                            "required": ["reason"]
                        }
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "request_better_view",
                        "description": "Ask the user to adjust the camera or provide a better view.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "reason": {"type": "string", "description": "What is wrong with the view (e.g. 'too blurry', 'connector hidden')"}
                            },
                            "required": ["reason"]
                        }
                    }
                }
            ]

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": routing_user_prompt}
            ]

            # --- PASS 1: ROUTING (Non-streaming) ---
            route_response = None
            for key_attempt in range(len(self.groq_clients)):
                try:
                    route_response = await asyncio.to_thread(
                        self.client.chat.completions.create,
                        model=self.llm_model,
                        messages=messages,
                        tools=tools,
                        tool_choice="auto",
                        temperature=0.1,
                        max_tokens=256
                    )
                    break
                except Exception as e:
                    err_str = str(e).lower()
                    if ("429" in err_str or "rate limit" in err_str or "too many requests" in err_str) and key_attempt < len(self.groq_clients) - 1:
                        print("[Detector] Routing LLM 429 hit. Rotating Groq key...")
                        self.rotate_groq_client()
                    else:
                        raise e
            
            if not route_response:
                raise Exception("All Groq keys rate-limited during routing.")
                
            choice = route_response.choices[0]
            
            if choice.message.tool_calls:
                tool_call = choice.message.tool_calls[0]
                
                if tool_call.function.name == "request_better_view":
                    args = json.loads(tool_call.function.arguments)
                    yield {
                        "type": "sentence",
                        "text": f"I can't clearly see that. {args.get('reason', 'Could you adjust the camera?')}"
                    }
                    return

                if tool_call.function.name == "inspect_current_scene":
                    import random
                    
                    # --- VLM TTL Cache Check ---
                    cached = self._vlm_cache.get(scene_id) if scene_id else None
                    if cached and (_time.time() - cached["timestamp"]) < self._VLM_CACHE_TTL:
                        print(f"[Detector] VLM cache HIT for scene_id={scene_id}. Skipping VLM call.")
                        patch = cached["result"]
                        messages.append(choice.message)
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": json.dumps(patch)
                        })
                    else:
                        tool_call_id = str(uuid.uuid4())
                        self.lazy_events[tool_call_id] = asyncio.Event()
                        
                        acks = [
                            "One moment, let me check.",
                            "Checking that for you.",
                            "Let me take a quick look.",
                            "Hold on, I'm taking a look.",
                            "Give me just a second to see."
                        ]
                        yield {
                            "type": "tool_call",
                            "name": "inspect_current_scene",
                            "tool_call_id": tool_call_id,
                            "ack_text": random.choice(acks)
                        }
                        
                        # Wait for frame upload (lazy upload)
                        try:
                            await asyncio.wait_for(self.lazy_events[tool_call_id].wait(), timeout=10.0)
                            frame_b64 = self.lazy_frames.get(tool_call_id)
                        except asyncio.TimeoutError:
                            yield {"type": "sentence", "text": "I didn't receive the camera frame in time."}
                            return
                        finally:
                            self.lazy_events.pop(tool_call_id, None)
                            self.lazy_frames.pop(tool_call_id, None)
                            
                        if not frame_b64:
                            yield {"type": "sentence", "text": "No camera frame received."}
                            return

                        jpeg_b64 = self._ensure_jpeg(frame_b64)
                        
                        vlm_prompt = (
                            f"Describe ONLY what you see in this image right now. Output a JSON object:\n"
                            "{\n"
                            "  \"change_type\": \"<no_change|state_update|new_object|camera_repositioned|uncertain>\",\n"
                            "  \"current_scene_memory\": \"<Max 40 words. Describe exactly what is in the center of the image right now. Do not mention missing objects.>\",\n"
                            "  \"previous_scene_memory\": \"<Max 40 words. Only fill if the scene has CHANGED from this prior context: "
                            f"{vlm_context[:100]}. Otherwise leave as empty string.>\"\n"
                            "}"
                        )
                        vlm_patch_str = await asyncio.to_thread(self._call_pixtral_vlm, jpeg_b64, vlm_prompt)
                        
                        try:
                            clean_json = vlm_patch_str.replace("```json", "").replace("```", "").strip()
                            patch = json.loads(clean_json)
                            change_type = patch.get("change_type", "uncertain")
                            new_scene_description = patch.get("current_scene_memory", "")
                            if scene_id and scene_id in self.scene_memory:
                                mem = self.scene_memory[scene_id]
                                current_active_obj_id = mem.get("active_object_id")
                                if change_type in ("new_object", "camera_repositioned") and new_scene_description:
                                    # Persist the current active object's final state before switching
                                    if current_active_obj_id and current_active_obj_id in mem.get("objects", {}):
                                        mem["objects"][current_active_obj_id]["scene_memory"] = mem.get("current_scene_memory", "")
                                        mem["objects"][current_active_obj_id]["last_seen"] = time.time()
                                    # Register the new object
                                    new_obj_id = str(uuid.uuid4())[:8]
                                    mem.setdefault("objects", {})[new_obj_id] = {
                                        "scene_memory": new_scene_description,
                                        "first_seen": time.time(),
                                        "last_seen": time.time(),
                                    }
                                    mem["active_object_id"] = new_obj_id
                                    mem["previous_scene_memory"] = mem.get("current_scene_memory", "None.")
                                    mem["current_scene_memory"] = new_scene_description
                                    self._vlm_cache.pop(scene_id, None) # Invalidate cache
                                else:
                                    # Same Object — Update Active Memory
                                    if new_scene_description:
                                        mem["current_scene_memory"] = new_scene_description
                                        if current_active_obj_id and current_active_obj_id in mem.get("objects", {}):
                                            mem["objects"][current_active_obj_id]["scene_memory"] = new_scene_description
                                            mem["objects"][current_active_obj_id]["last_seen"] = time.time()
                                        elif not current_active_obj_id:
                                            new_obj_id = str(uuid.uuid4())[:8]
                                            mem.setdefault("objects", {})[new_obj_id] = {
                                                "scene_memory": new_scene_description,
                                                "first_seen": time.time(),
                                                "last_seen": time.time(),
                                            }
                                            mem["active_object_id"] = new_obj_id
                                    prev = patch.get("previous_scene_memory", "").strip()
                                    if prev:
                                        mem["previous_scene_memory"] = prev
                                        
                                print(f"\n[Backend] 🔄 SCENE MEMORY UPDATED via VLM Snapshot")
                                print(f"   ┣━ Change Type: {change_type}")
                                print(f"   ┣━ Current Scene Memory: {mem.get('current_scene_memory', '')}")
                                print(f"   ┗━ Previous Scene Memory: {mem.get('previous_scene_memory', '')}")

                            if scene_id and change_type not in ("new_object", "camera_repositioned"):
                                self._vlm_cache[scene_id] = {"timestamp": time.time(), "result": patch}
                        except Exception as e:
                            print(f"[Detector] VLM Patch parse error: {e}")
                            patch = {"change_type": "uncertain"}
                        
                        messages.append(choice.message) # Append assistant's tool call
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.function.name,
                            "content": json.dumps(patch)
                        })
            
            # --- PASS 2: STREAMING FINAL ANSWER ---
            # Update the prompt to force JSON format and use the latest scene memory
            if scene_id and scene_id in self.scene_memory:
                mem = self.scene_memory.get(scene_id, {})
                objects_final = mem.get("objects", {})
                active_obj_id_final = mem.get("active_object_id")
                active_obj_final = objects_final.get(active_obj_id_final, {}) if active_obj_id_final else {}
                active_description = active_obj_final.get("scene_memory") or mem.get("current_scene_memory", "None.")
                prev_obj_descs = [
                    odata["scene_memory"]
                    for oid, odata in objects_final.items()
                    if oid != active_obj_id_final and odata.get("scene_memory")
                ]
                if prev_obj_descs:
                    prev_str = "\n".join(f"- {d}" for d in prev_obj_descs)
                    vlm_context = (
                        f"ACTIVE OBJECT (what the user is pointing at right now — answer about this):\n{active_description}\n\n"
                        f"PREVIOUSLY SEEN OBJECTS (held in memory — do NOT volunteer info about these):\n{prev_str}"
                    )
                else:
                    vlm_context = f"Previous Scene Memory:\n{mem.get('previous_scene_memory', 'None.')}\n\nCurrent Scene Memory:\n{active_description}"
            
            final_user_prompt = f"""
Current Scene Memory Context:
---
{vlm_context}
---
User question: "{user_message}"
Conversation Context: {conv_context}
Detected language: {detected_language}
Device context: {device_context}.

INSTRUCTIONS:
1. Voice Personality: Be extremely conversational, witty, and human-like with a touch of humor. Keep answers EXTREMELY short (1-2 sentences). Do not sound like a machine. Avoid lists.
2. Confidence Manager: If the confidence is low (e.g. < 50%) or you can't clearly see the part, DO NOT answer confidently.
3. Proactive Warnings: Warn proactively if you notice critical hazards.
4. Context Override: If the Current Scene Memory describes a new object that contradicts the Device Context or Conversation Context, trust the Current Scene Memory. The user has pointed their camera at a new object. NEVER mention, compare, or reference previously seen objects unless the user explicitly asks about them.

IMPORTANT: You must output a JSON object exactly like this, where "chat_reply" is the VERY LAST key:
{{
  "highlight_target": "<component_id or null>",
  "show_arrow": <true/false>,
  "chat_reply": "<Your complete spoken response here, ALWAYS in English>"
}}
"""
            messages[1]["content"] = final_user_prompt

            import queue as queue_module
            import threading

            chunk_queue: queue_module.Queue = queue_module.Queue()

            def _run_stream():
                for key_attempt in range(len(self.groq_clients)):
                    try:
                        stream = self.client.chat.completions.create(
                            model=self.llm_model,
                            messages=messages,
                            response_format={"type": "json_object"},
                            temperature=0.2,
                            max_tokens=512,
                            stream=True
                        )
                        for chunk in stream:
                            content = chunk.choices[0].delta.content
                            if content:
                                chunk_queue.put(content)
                        return # Success
                    except Exception as e:
                        err_str = str(e).lower()
                        if ("429" in err_str or "rate limit" in err_str or "too many requests" in err_str) and key_attempt < len(self.groq_clients) - 1:
                            print("[Detector] Streaming LLM 429 hit. Rotating Groq key...")
                            self.rotate_groq_client()
                        else:
                            chunk_queue.put(Exception(e))
                            return
                chunk_queue.put(None)

            thread = threading.Thread(target=_run_stream, daemon=True)
            thread.start()
            
            import re
            buffer = ""
            full_reply = ""
            inside_reply = False
            finished_reply = False

            while True:
                try:
                    content = await asyncio.get_event_loop().run_in_executor(None, lambda: chunk_queue.get(timeout=30))
                except Exception:
                    break

                if content is None:
                    break
                if isinstance(content, Exception):
                    raise content
                    
                if finished_reply:
                    continue

                buffer += content

                if not inside_reply and '"chat_reply"' in buffer:
                    target_match = re.search(r'"highlight_target"\s*:\s*"?([^",\n]+)"?', buffer)
                    arrow_match = re.search(r'"show_arrow"\s*:\s*(true|false)', buffer, re.IGNORECASE)

                    target = target_match.group(1) if target_match and target_match.group(1) != "null" else None
                    arrow = True if arrow_match and arrow_match.group(1).lower() == "true" else False

                    yield {
                        "type": "ar_context",
                        "highlight_target": target,
                        "show_arrow": arrow
                    }
                    inside_reply = True

                    buffer = buffer.split('"chat_reply"')[1]
                    buffer = re.sub(r'^\s*:\s*"', '', buffer)

                if inside_reply:
                    end_str_match = re.search(r'(?<!\\)"\s*(,|})', buffer)
                    if end_str_match:
                        buffer = buffer[:end_str_match.start()]
                        finished_reply = True

                    match = re.search(r'([.!?]+)(\s+|$)', buffer)
                    if match:
                        end_idx = match.end()
                        sentence = buffer[:end_idx].strip()
                        sentence = sentence.replace('\\"', '"').replace('\\n', ' ')
                        if sentence:
                            full_reply += sentence + " "
                            yield {"type": "sentence", "text": sentence}
                        buffer = buffer[end_idx:]
                        
                    if finished_reply:
                        clean_tail = buffer.strip().replace('\\"', '"').replace('\\n', ' ')
                        if clean_tail:
                            full_reply += clean_tail + " "
                            yield {"type": "sentence", "text": clean_tail}
                        buffer = ""

            if inside_reply and not finished_reply and buffer.strip():
                clean_tail = re.sub(r'"}?\s*}?$', '', buffer.strip())
                clean_tail = clean_tail.replace('\\"', '"').replace('\\n', ' ')
                if clean_tail:
                    full_reply += clean_tail + " "
                    yield {"type": "sentence", "text": clean_tail}
                    
            if scene_id:
                asyncio.create_task(self._update_conversation_context(scene_id, conv_context, user_message, full_reply))
                    
        except Exception as e:
            yield {"type": "error", "message": str(e)}
    # ──────────────────────────────────────────────────────────────
    # Model Access Helpers
    # ──────────────────────────────────────────────────────────────
    async def _update_conversation_context(self, scene_id: str, old_context: str, user_message: str, assistant_reply: str):
        prompt = f"""
Update the semantic session context based on the latest turn.
Old context: {old_context}
User asked: {user_message}
Assistant replied: {assistant_reply}

Rules:
- Max 20 words.
- Describe the CURRENT GOAL and relevant context ONLY.
- Do NOT include full transcripts.
"""
        try:
            for key_attempt in range(len(self.groq_clients)):
                try:
                    res = await asyncio.to_thread(
                        self.client.chat.completions.create,
                        model=self.llm_fallback_model,
                        messages=[{"role": "user", "content": prompt}],
                        max_tokens=35,
                        temperature=0.1
                    )
                    new_context = res.choices[0].message.content.strip()
                    self.scene_memory[scene_id]["conversation_context"] = new_context
                    print(f"\n[Backend] 💬 CONVERSATION CONTEXT UPDATED")
                    print(f"   ┗━ New Context: {new_context}")
                    break
                except Exception as e:
                    err_str = str(e).lower()
                    if ("429" in err_str or "rate limit" in err_str or "too many requests" in err_str) and key_attempt < len(self.groq_clients) - 1:
                        print("[Detector] Context update LLM 429 hit. Rotating Groq key...")
                        self.rotate_groq_client()
                    else:
                        print(f"[Detector] Context update failed: {e}")
                        break
        except Exception as e:
            print(f"[Detector] Context update process failed: {e}")


    def _call_pixtral_vlm(self, jpeg_b64: str, prompt: str) -> str:
        """Call Pixtral-12B via official Mistral AI SDK with retry on 429, and Groq Vision fallback."""

        # ── No Mistral key or SDK not installed → go straight to Groq Vision ──
        if not self.mistral_client:
            print("[Warning] Mistral client unavailable. Using Groq Vision VLM directly.")
            return self._call_groq_vision(jpeg_b64, prompt)

        # ── Build the message payload ─────────────────────────────────────────
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{jpeg_b64}"}},
                ],
            }
        ]

        # ── Retry loop: up to 3 attempts with exponential backoff on 429 ──────
        max_key_attempts = len(self.mistral_clients)
        max_backoff_attempts = 3
        backoff_seconds = [2, 4, 8]  # wait times between retries

        for backoff_attempt in range(1, max_backoff_attempts + 1):
            for key_attempt in range(max_key_attempts):
                try:
                    response = self.mistral_client.chat.complete(
                        model=self.vlm_model,
                        messages=messages,
                        temperature=0.2,
                        max_tokens=1024,
                    )
                    print(f"[Detector] Mistral Pixtral-12B responded (backoff attempt {backoff_attempt}, key attempt {key_attempt + 1}).")
                    return response.choices[0].message.content
                except Exception as e:
                    err_str = str(e).lower()
                    is_rate_limit = "429" in err_str or "rate limit" in err_str or "too many requests" in err_str

                    if is_rate_limit and key_attempt < max_key_attempts - 1:
                        print(f"[Detector] Mistral hit 429. Rotating key...")
                        self.rotate_mistral_client()
                        continue
                        
                    if is_rate_limit and backoff_attempt < max_backoff_attempts:
                        wait = backoff_seconds[backoff_attempt - 1]
                        print(f"[Detector] All Mistral keys hit 429. Retrying in {wait}s...")
                        time.sleep(wait)
                        break # Break inner loop, trigger next backoff iteration

                    # Non-429 error OR exhausted retries → fall back to Groq Vision
                    if is_rate_limit:
                        print(f"[Detector] Mistral rate-limit persists after {max_backoff_attempts} attempts. "
                              f"Falling back to Groq Vision VLM...")
                    else:
                        print(f"[Detector] Mistral API error: {e}. Falling back to Groq Vision VLM...")
                    return self._call_groq_vision(jpeg_b64, prompt)

        # Should never reach here, but safety net
        return self._call_groq_vision(jpeg_b64, prompt)

    def _call_groq_vision(self, jpeg_b64: str, prompt: str) -> str:
        """Call Groq Vision VLM (llama-4-scout) as primary or fallback vision model."""
        max_key_attempts = len(self.groq_clients)
        for key_attempt in range(max_key_attempts):
            try:
                response = self.client.chat.completions.create(
                    model=self.groq_vlm_model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{jpeg_b64}"}},
                            ],
                        }
                    ],
                    max_tokens=1024,
                )
                print("[Detector] Groq Vision VLM responded successfully.")
                return response.choices[0].message.content
            except Exception as e:
                err_str = str(e).lower()
                is_rate_limit = "429" in err_str or "rate limit" in err_str or "too many requests" in err_str
                if is_rate_limit and key_attempt < max_key_attempts - 1:
                    print(f"[Detector] Groq Vision hit 429. Rotating key...")
                    self.rotate_groq_client()
                    continue
                if key_attempt == max_key_attempts - 1:
                    print(f"[Detector] Groq Vision VLM also failed: {e}")
                    raise RuntimeError(f"Both Mistral and Groq Vision VLM failed. Last error: {e}")
        raise RuntimeError("All Groq Vision retries failed.")

    def _call_groq_llm(self, system_prompt: str, user_prompt: str) -> str:
        """Call Llama 3.3 70B via Groq API, with automatic fallback to 8B on 429 rate limit."""
        models_to_try = [self.llm_model, self.llm_fallback_model]
        max_key_attempts = len(self.groq_clients)

        for model in models_to_try:
            for key_attempt in range(max_key_attempts):
                try:
                    response = self.client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt}
                        ],
                        response_format={"type": "json_object"},
                        temperature=0.2,
                        max_tokens=2048
                    )
                    if model != self.llm_model:
                        print(f"[Detector] LLM fallback: using {model} (primary model hit rate limit).")
                    return response.choices[0].message.content
                except Exception as e:
                    err_str = str(e).lower()
                    is_rate_limit = "429" in err_str or "rate limit" in err_str or "too many requests" in err_str
                    if is_rate_limit:
                        if key_attempt < max_key_attempts - 1:
                            print(f"[Detector] {model} hit 429. Rotating Groq key...")
                            self.rotate_groq_client()
                            continue
                        elif model != models_to_try[-1]:
                            print(f"[Detector] {model} hit 429 on all keys. Falling back to {models_to_try[models_to_try.index(model) + 1]}...")
                            break # Go to next model
                        else:
                            raise
                    raise

    def _ensure_jpeg(self, full_frame_b64: str) -> str:
        """Convert raw RGB bytes (320x320x3) to JPEG and downscale to max 768px.
        Smaller payload = faster VLM transfer. 768px is more than sufficient for VLM understanding."""
        try:
            import base64
            from PIL import Image
            import io

            raw_bytes = base64.b64decode(full_frame_b64)

            # Handle raw RGB frame (320x320x3 = 307200 bytes)
            if len(raw_bytes) == 320 * 320 * 3:
                img = Image.frombytes("RGB", (320, 320), raw_bytes)
            else:
                img = Image.open(io.BytesIO(raw_bytes))

            # Downscale to max 768px — VLMs don't need full resolution to identify objects
            max_size = 768
            if img.width > max_size or img.height > max_size:
                ratio = min(max_size / img.width, max_size / img.height)
                new_w = int(img.width * ratio)
                new_h = int(img.height * ratio)
                try:
                    resample = Image.Resampling.LANCZOS
                except AttributeError:
                    resample = Image.LANCZOS
                img = img.resize((new_w, new_h), resample)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            # JPEG quality 65 — good enough for VLM object recognition, ~30% smaller than 75
            jpeg_io = io.BytesIO()
            img.save(jpeg_io, format="JPEG", quality=65, optimize=True)

            result_b64 = base64.b64encode(jpeg_io.getvalue()).decode("utf-8")
            print(f"[Detector] Image prepared: {img.width}x{img.height}, "
                  f"{len(full_frame_b64)} → {len(result_b64)} chars ({100*len(result_b64)//len(full_frame_b64)}%)")
            return result_b64
        except Exception as e:
            print(f"[Detector] Warning: _ensure_jpeg failed: {e}")
            return full_frame_b64

    def _ensure_jpeg_small(self, full_frame_b64: str) -> str:
        """Like _ensure_jpeg but capped at 512px and quality 45 for fast inference tasks
        like object presence evaluation in the interactive guide loop."""
        try:
            import base64
            from PIL import Image
            import io

            raw_bytes = base64.b64decode(full_frame_b64)
            if len(raw_bytes) == 320 * 320 * 3:
                img = Image.frombytes("RGB", (320, 320), raw_bytes)
            else:
                img = Image.open(io.BytesIO(raw_bytes))

            max_size = 512
            if img.width > max_size or img.height > max_size:
                ratio = min(max_size / img.width, max_size / img.height)
                new_w = int(img.width * ratio)
                new_h = int(img.height * ratio)
                try:
                    resample = Image.Resampling.LANCZOS
                except AttributeError:
                    resample = Image.LANCZOS
                img = img.resize((new_w, new_h), resample)

            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")

            jpeg_io = io.BytesIO()
            img.save(jpeg_io, format="JPEG", quality=45, optimize=True)
            result_b64 = base64.b64encode(jpeg_io.getvalue()).decode("utf-8")
            print(f"[Detector] Small image: {img.width}x{img.height}, {len(result_b64)} chars")
            return result_b64
        except Exception as e:
            print(f"[Detector] _ensure_jpeg_small failed: {e}")
            return full_frame_b64

    def _fallback_response(self, reason: str) -> dict:
        return {
            "event": "error",
            "message": f"Analysis unavailable: {reason}",
        }

    def identify_device(self, image_b64: str, device_context: dict) -> dict:
        """Identify ANY electrical/electronic/mechanical device in the image."""
        try:
            jpeg_b64 = self._ensure_jpeg(image_b64)
            vlm_prompt = (
                "Examine this image and identify the PRIMARY device or equipment that is the focus of the scene.\n"
                + DEVICE_SCOPE + "\n\n"
                "Provide:\n"
                "1. The exact device name (be specific — e.g. 'Split Air Conditioner', not just 'appliance').\n"
                "2. Brand and model number if visible on the label.\n"
                "3. All visible components/parts with their names.\n"
                "4. Current operating state (running/off/door-open/panel-removed/etc.).\n"
                "5. Any visible damage, error lights, or abnormalities."
            )
            vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are the device identification engine for FixSight. "
                "Given the VLM's visual description, extract and return a JSON identification result. "
                "Use the EXACT device name the VLM identified — do NOT change it to 'motor' or any generic name. "
                "You MUST output valid JSON only. No markdown, no prose.\n"
                "{\n"
                "  \"device\": \"<exact device name as described by VLM>\",\n"
                "  \"confidence\": <float 0.0-1.0>,\n"
                "  \"summary\": \"<1-2 sentences: what is visible and its current state>\",\n"
                "  \"confirmation_required\": <true if confidence < 0.85 or ambiguous, else false>,\n"
                "  \"title\": \"<same as device>\",\n"
                "  \"actions\": [\"<safety or inspection action 1>\", \"<action 2>\"],\n"
                "  \"voice_text\": \"I can see a <device>.\",\n"
                "  \"ar_targets\": []\n"
                "}"
            )
            llm_user_prompt = f"VLM Description:\n{vlm_response}\nDevice Context: {device_context}"

            llm_response = self._call_groq_llm(system_prompt, llm_user_prompt)
            return json.loads(llm_response)
        except Exception as e:
            print(f"[Detector] identify_device failed: {e}")
            return {
                "device": "Unknown Device",
                "confidence": 0.5,
                "summary": f"Could not identify device: {e}",
                "confirmation_required": True,
                "title": "Unknown Device",
                "actions": ["Verify device visibility", "Check camera lighting"],
                "voice_text": "I was unable to identify the device. Please make sure it is clearly visible.",
                "ar_targets": []
            }

    def scan_scene(self, image_b64: str, device_context: dict) -> dict:
        """Single-pass scene scan: identify any electrical device and its components."""
        try:
            jpeg_b64 = self._ensure_jpeg(image_b64)
            vlm_prompt = (
                "Examine this image carefully.\n"
                + DEVICE_SCOPE + "\n\n"
                "Output two sections:\n"
                "**Scene Understanding/Description:**\n"
                "  - Exact device name (be specific, e.g. 'LG Split Air Conditioner 1.5 Ton', not just 'appliance').\n"
                "  - Brand/model if visible on the label.\n"
                "  - All visible components/parts.\n"
                "  - Current operational state (running, off, door open, panel removed, error light on, etc.).\n"
                "  - Any visible damage or abnormalities.\n\n"
                "**Object Detection:**\n"
                "{\"detections\": [{\"label\": \"<component name>\", \"bbox\": [x1,y1,x2,y2]}, ...]}"
                " where coordinates are normalised 0.0–1.0."
            )
            vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are the scene analysis engine for FixSight. "
                "Given the visual description from the VLM, output a JSON object with the device and its components. "
                "The device can be ANYTHING — industrial or consumer (AC, laptop, router, washing machine, etc.). "
                "Use the EXACT device name the VLM identified. Do NOT substitute with 'motor' or 'industrial equipment'. "
                "You MUST output valid JSON only. No markdown, no prose.\n"
                "{\n"
                "  \"device\": \"<exact device name as seen>\",\n"
                "  \"confidence\": <float 0.0 to 1.0>,\n"
                "  \"summary\": \"<1-2 sentences about what is visible and its state>\",\n"
                "  \"components\": [\n"
                "    {\n"
                "      \"id\": \"<lowercase_snake_case>\",\n"
                "      \"name\": \"<Component Name>\",\n"
                "      \"label\": \"<Component Name>\",\n"
                "      \"bbox\": [x1, y1, x2, y2],\n"
                "      \"box_2d\": [x1, y1, x2, y2],\n"
                "      \"importance\": <1-5>,\n"
                "      \"description\": \"<what this component does>\",\n"
                "      \"status\": \"<Operational|Clean|Loose|Unknown>\",\n"
                "      \"statusType\": \"<success|warning|error>\"\n"
                "    }\n"
                "  ]\n"
                "}"
            )
            llm_user_prompt = f"VLM Output:\n{vlm_response}\nDevice Context: {device_context}"
            models_to_try = [self.llm_fallback_model, self.llm_model]  # 8B first — faster
            
            llm_response = None
            for model in models_to_try:
                try:
                    response = self.client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": llm_user_prompt}
                        ],
                        response_format={"type": "json_object"},
                        temperature=0.1,
                        max_tokens=1024,  # reduced from 2048 — component list rarely needs more
                    )
                    llm_response = response.choices[0].message.content
                    break
                except Exception as e:
                    print(f"Fallback required for scan_scene: {e}")
                    pass
            
            if not llm_response:
                raise Exception("LLM failed")
                
            result = json.loads(llm_response)
            scene_id = str(uuid.uuid4())
            import time
            new_obj_id = str(uuid.uuid4())[:8]
            self.scene_memory[scene_id] = {
                "vlm_scene_description": vlm_response,
                "timestamp": time.time(),
                "device": result.get("device", "Unknown"),
                "current_scene_memory": vlm_response,
                "previous_scene_memory": "None.",
                "conversation_context": "Initial scan complete.",
                "active_object_id": new_obj_id,
                "objects": {
                    new_obj_id: {
                        "scene_memory": vlm_response,
                        "first_seen": time.time(),
                        "last_seen": time.time(),
                    }
                }
            }
            result["scene_id"] = scene_id
            
            print(f"\n[Backend] 📸 INITIAL SCAN COMPLETE")
            print(f"   ┣━ Device: {self.scene_memory[scene_id]['device']}")
            print(f"   ┣━ Current Scene Memory: {self.scene_memory[scene_id]['current_scene_memory']}")
            print(f"   ┗━ Conversation Context: {self.scene_memory[scene_id]['conversation_context']}")
            
            if "vlm_scene_description" in result:
                del result["vlm_scene_description"]
            return result
        except Exception as e:
            print(f"[Detector] scan_scene failed: {e}")
            return {
                "device": "Unknown Device",
                "confidence": 0.5,
                "summary": f"Could not analyze scene: {e}",
                "vlm_scene_description": "",
                "components": []
            }

    def troubleshoot_device(self, image_b64: str, device: str, component_id: str, issue: str, device_context: dict, scene_id: str = None) -> dict:
        """Troubleshoot issues on the device/component."""
        try:
            if scene_id and scene_id in self.scene_memory:
                vlm_response = self.scene_memory[scene_id].get("vlm_scene_description")
            else:
                vlm_response = "No image provided for troubleshooting."
                if image_b64:
                    jpeg_b64 = self._ensure_jpeg(image_b64)
                    vlm_prompt = (
                        f"Analyze the image of the '{device}' focusing on component '{component_id}' and issue '{issue}' if specified. "
                        "Describe any visual anomalies, wear, damage, leaks, faults, or general condition."
                    )
                    vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are the troubleshooting engine for FixSight. "
                "Given the visual description (if available), device name, component ID, and issue details, output a JSON object containing troubleshooting information. "
                "You MUST output valid JSON only. Do not wrap in markdown or include any prose. "
                "IMPORTANT: If the visual description shows no signs of damage, wear, overheating, or other issues, or if the issue is extremely mild/normal, do NOT invent or force a diagnosis. State clearly that everything appears to be in normal operational condition. In this case, set \"issue\" to \"No Issue\" or \"None\", list \"possible_causes\" as empty, and provide general preventive maintenance or visual inspection tips under \"actions\".\n"
                "Return a schema conforming to both troubleshoot-mode and standard JSON response standard:\n"
                "{\n"
                "  \"issue\": \"<Identified or suspected issue, or 'No Issue'>\",\n"
                "  \"possible_causes\": [\"<cause 1>\", \"<cause 2>\"],\n"
                "  \"related_components\": [\"<component_id_1>\", \"<component_id_2>\"],\n"
                "  \"title\": \"Troubleshooting: <issue>\",\n"
                "  \"summary\": \"<Brief summary of troubleshooting analysis>\",\n"
                "  \"actions\": [\"<recommended action 1>\", \"<recommended action 2>\"],\n"
                "  \"voice_text\": \"<Spoken text summarizing the status>\",\n"
                "  \"ar_targets\": [\"<related component ids>\"]\n"
                "}"
            )
            llm_user_prompt = f"VLM Visual description:\n{vlm_response}\nDevice: {device}\nComponent ID: {component_id}\nIssue: {issue}\nDevice Context: {device_context}"
            llm_response = self._call_groq_llm(system_prompt, llm_user_prompt)
            return json.loads(llm_response)
        except Exception as e:
            print(f"[Detector] troubleshoot_device failed: {e}")
            return {
                "issue": issue or "General Fault",
                "possible_causes": ["Unknown system error"],
                "related_components": [component_id] if component_id else [],
                "title": f"Troubleshooting: {issue or 'General Fault'}",
                "summary": f"Could not perform troubleshooting: {e}",
                "actions": ["Manual physical inspection", "Check main power supply"],
                "voice_text": f"Troubleshooting failed. Please check the system logs.",
                "ar_targets": [component_id] if component_id else []
            }

    def explain_component(self, image_b64: str, device: str, component_id: str, device_context: dict, scene_id: str = None) -> dict:
        """Explain the function and purpose of a specific component."""
        try:
            if scene_id and scene_id in self.scene_memory:
                vlm_response = self.scene_memory[scene_id].get("vlm_scene_description")
            else:
                vlm_response = "No image provided for explanation."
                if image_b64:
                    jpeg_b64 = self._ensure_jpeg(image_b64)
                    vlm_prompt = (
                        f"Analyze the image of the '{device}' focusing on the component '{component_id}'. "
                        "Describe its visual appearance, state, and environment."
                    )
                    vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are the explanation engine for FixSight. "
                "Given the visual description (if available), device name, and component ID, output a JSON object explaining the component. "
                "You MUST output valid JSON only. Do not wrap in markdown or include any prose. "
                "Return a schema conforming to both explain-mode and standard JSON response standard:\n"
                "{\n"
                "  \"title\": \"<Component Label>\",\n"
                "  \"summary\": \"<Purpose and function of this component, explained simply>\",\n"
                "  \"note\": \"<Maintenance notes, wear indicators, or safety remarks>\",\n"
                "  \"actions\": [\"Perform regular visual inspection\"],\n"
                "  \"voice_text\": \"This is the <Component Label>. It is responsible for...\",\n"
                "  \"ar_targets\": [\"<component_id>\"]\n"
                "}"
            )
            llm_user_prompt = f"VLM Visual description:\n{vlm_response}\nDevice: {device}\nComponent ID: {component_id}\nDevice Context: {device_context}"
            llm_response = self._call_groq_llm(system_prompt, llm_user_prompt)
            return json.loads(llm_response)
        except Exception as e:
            print(f"[Detector] explain_component failed: {e}")
            return {
                "title": component_id.replace("_", " ").title() if component_id else "Component",
                "summary": "No explanation available.",
                "note": f"Error loading explanation: {e}",
                "actions": [],
                "voice_text": "Failed to explain the component.",
                "ar_targets": [component_id] if component_id else []
            }

    # ──────────────────────────────────────────────────────────────
    # Smart Scene Refresh — verify_scene_state (Quick Mini-VLM)
    # ──────────────────────────────────────────────────────────────
    def verify_scene_state(
        self,
        image_b64: str,
        scene_id: str = None,
        previous_scene_summary: str = None,
        current_step_context: str = None,
        device_context: dict = None,
    ) -> dict:
        """Quick scene verification after a user claims they performed an action.
        Uses VLM only for the verification question, not full scene rebuild.
        Example: user says 'done' → ask VLM if the step is visually complete."""
        try:
            device_context = device_context or {}
            vlm_description = ""

            if image_b64:
                jpeg_b64 = self._ensure_jpeg(image_b64)
                verify_prompt = (
                    "You are verifying a maintenance or inspection step on an electrical/electronic device.\n"
                    + DEVICE_SCOPE + "\n\n"
                    f"Previous context: {previous_scene_summary or 'No prior context.'}\n"
                    f"Step being verified: {current_step_context or 'General state check.'}\n\n"
                    "Look at the current image and describe ONLY what is visually different or notable "
                    "compared to the expected completed state. Be concise — 2-3 sentences maximum."
                )
                vlm_description = self._call_pixtral_vlm(jpeg_b64, verify_prompt)
            elif scene_id and scene_id in self.scene_memory:
                vlm_description = self.scene_memory[scene_id].get("vlm_scene_description", "")

            system_prompt = (
                "You are a smart scene verifier for an AR maintenance assistant. "
                "Given a visual description of the current state, the previous scene summary, "
                "and the step context, determine if the described action appears to be completed. "
                "You MUST output valid JSON only. No markdown, no prose.\n"
                "Schema:\n"
                "{\n"
                "  \"status\": \"<completed|not_completed|uncertain>\",\n"
                "  \"confidence\": <float 0.0-1.0>,\n"
                "  \"reason\": \"<1 sentence explaining your verdict>\",\n"
                "  \"scene_changed\": <bool — true if the scene looks different from summary>,\n"
                "  \"updated_summary\": \"<brief updated scene state for memory, 2-3 sentences>\"\n"
                "}"
            )
            user_prompt = (
                f"Current visual state:\n{vlm_description}\n\n"
                f"Previous scene summary:\n{previous_scene_summary or 'N/A'}\n\n"
                f"Step to verify:\n{current_step_context or 'General check'}"
            )

            response = self._call_groq_llm(system_prompt, user_prompt)
            result = json.loads(response)

            # If scene changed, update scene_memory so future queries are fresh
            if result.get("scene_changed") and scene_id and scene_id in self.scene_memory:
                self.scene_memory[scene_id]["vlm_scene_description"] = (
                    result.get("updated_summary", vlm_description)
                )
                print(f"[Detector] Scene memory updated for scene_id={scene_id}")

            return result

        except Exception as e:
            print(f"[Detector] verify_scene_state failed: {e}")
            return {
                "status": "uncertain",
                "confidence": 0.0,
                "reason": f"Verification failed: {e}",
                "scene_changed": False,
                "updated_summary": previous_scene_summary or "",
            }

    # ──────────────────────────────────────────────────────────────
    # Smart Scene Refresh — refresh_scene (Full Re-scan)
    # ──────────────────────────────────────────────────────────────
    def refresh_scene(
        self,
        image_b64: str,
        old_scene_id: str = None,
        device_name: str = None,
        device_context: dict = None,
    ) -> dict:
        """Full scene re-analysis when camera significantly changed.
        Updates scene_memory in-place with the old scene_id if provided,
        otherwise creates a new one. Returns updated scene summary + scene_id."""
        try:
            device_context = device_context or {}
            jpeg_b64 = self._ensure_jpeg(image_b64)

            vlm_prompt = (
                f"Analyze this image of {'the ' + device_name if device_name else 'the equipment'}. "
                "Provide a detailed scene description focusing on: "
                "1) What components/parts are visible. "
                "2) What has CHANGED compared to a typical resting state (open panels, removed parts, tools, etc.). "
                "3) Current operational state. Be specific and concise."
            )
            vlm_description = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are a scene analysis engine for an AR maintenance assistant. "
                "Given a new visual description of the equipment, extract a compact scene summary for memory. "
                "Output valid JSON only:\n"
                "{\n"
                "  \"device\": \"<device name>\",\n"
                "  \"confidence\": <float 0.0-1.0>,\n"
                "  \"summary\": \"<2-3 sentence plain-language summary of current state>\",\n"
                "  \"visible_components\": [\"<component name>\"],\n"
                "  \"notable_changes\": \"<What is different from normal — e.g., cover removed, wires exposed>\",\n"
                "  \"scene_version_note\": \"<short tag like 'cover_removed' or 'camera_moved_to_panel'>\"\n"
                "}"
            )
            user_prompt = (
                f"New visual description:\n{vlm_description}\n"
                f"Known device: {device_name or 'Unknown'}\n"
                f"Device context: {device_context}"
            )

            response = self._call_groq_llm(system_prompt, user_prompt)
            result = json.loads(response)

            # Update or create scene_memory entry
            import time
            target_scene_id = old_scene_id if old_scene_id and old_scene_id in self.scene_memory else str(uuid.uuid4())
            self.scene_memory[target_scene_id] = {
                "vlm_scene_description": vlm_description,
                "timestamp": time.time(),
                "device": result.get("device", device_name or "Unknown"),
            }
            result["scene_id"] = target_scene_id
            result["refreshed"] = True
            print(f"[Detector] Scene refreshed → scene_id={target_scene_id}, change={result.get('scene_version_note')}")

            return result

        except Exception as e:
            print(f"[Detector] refresh_scene failed: {e}")
            return {
                "scene_id": old_scene_id,
                "refreshed": False,
                "error": str(e),
                "summary": "Refresh failed. Using previous scene data.",
            }

    def guide_procedure(self, image_b64: str, device: str, component_id: str, device_context: dict, scene_id: str = None) -> dict:
        """Provide a step-by-step guided procedure for the device/component."""
        try:
            if scene_id and scene_id in self.scene_memory:
                vlm_response = self.scene_memory[scene_id].get("vlm_scene_description")
            else:
                vlm_response = "No image provided for guidance."
                if image_b64:
                    jpeg_b64 = self._ensure_jpeg(image_b64)
                    vlm_prompt = (
                        f"Analyze the image of the '{device}' focusing on component '{component_id}' if specified. "
                        "Describe the physical layout and state to assist with step-by-step operating/servicing guidance."
                    )
                    vlm_response = self._call_pixtral_vlm(jpeg_b64, vlm_prompt)

            system_prompt = (
                "You are the procedure guide engine for FixSight. "
                "Given the visual description (if available), device name, and component ID, output a JSON object with step-by-step instructions. "
                "You MUST output valid JSON only. Do not wrap in markdown or include any prose. "
                "Return a schema conforming to both guide-mode and standard JSON response standard:\n"
                "{\n"
                "  \"steps\": [\n"
                "    {\n"
                "      \"id\": \"step_1\",\n"
                "      \"stepNumber\": 1,\n"
                "      \"title\": \"<Short step title>\",\n"
                "      \"instruction\": \"<Detailed step instruction>\",\n"
                "      \"description\": \"<Detailed step description>\",\n"
                "      \"target\": \"<associated component id>\",\n"
                "      \"componentId\": \"<associated component id>\"\n"
                "    }\n"
                "  ],\n"
                "  \"title\": \"Guided Procedure\",\n"
                "  \"summary\": \"Guided steps for servicing or operating the device.\",\n"
                "  \"actions\": [\"Follow safety guidelines\", \"Use proper PPE\"],\n"
                "  \"voice_text\": \"To service the device, please follow these steps...\",\n"
                "  \"ar_targets\": [\"<component ids associated with steps>\"]\n"
                "}"
            )
            llm_user_prompt = f"VLM Visual description:\n{vlm_response}\nDevice: {device}\nComponent ID: {component_id}\nDevice Context: {device_context}"
            llm_response = self._call_groq_llm(system_prompt, llm_user_prompt)
            return json.loads(llm_response)
        except Exception as e:
            print(f"[Detector] guide_procedure failed: {e}")
            return {
                "steps": [
                    {
                        "id": "step_1",
                        "stepNumber": 1,
                        "title": "Visual Inspection",
                        "instruction": "Perform a general visual inspection of the device.",
                        "description": "Perform a general visual inspection of the device.",
                        "target": component_id or "",
                        "componentId": component_id or ""
                    }
                ],
                "title": "Guided Procedure Failed",
                "summary": f"Could not generate steps: {e}",
                "actions": ["Refer to physical manual"],
                "voice_text": "Failed to generate guided steps.",
                "ar_targets": [component_id] if component_id else []
            }

    # ──────────────────────────────────────────────────────────────
    # Interactive Visual Guidance Engine (AR Onboarding Style)
    # ──────────────────────────────────────────────────────────────
    def plan_interactive_task(self, user_request: str, device_context: dict) -> dict:
        """Generate a sequential state machine for a real-world task."""
        system_prompt = (
            "You are an Augmented Reality Task Planner. "
            "Convert the user's request into a strict sequence of atomic, visually verifiable steps. "
            "Each step must require specific real-world objects. "
            "Do not explain the process; instead, command the user step-by-step. "
            "Break down complex actions into pointing at one object at a time.\n"
            "CRITICAL: If the user needs to interact with something (like selecting text, pressing a button, or locating an item), explicitly instruct them to point at it WITH THEIR FINGER. "
            "The success_condition must be 'User's finger is visible pointing at the object'.\n"
            "You MUST output valid JSON only. No markdown, no prose.\n"
            "{\n"
            "  \"task_name\": \"<Short Task Name>\",\n"
            "  \"steps\": [\n"
            "    {\n"
            "      \"instruction\": \"<Spoken command, e.g., 'Hover over the Ctrl key'>\",\n"
            "      \"required_objects\": [\"<object1>\", \"<object2>\"],\n"
            "      \"success_condition\": \"<What visual state means this step is done>\",\n"
            "      \"fallback\": \"<Camera instruction if object is missing>\"\n"
            "    }\n"
            "  ]\n"
            "}"
        )
        user_prompt = f"User Request: {user_request}\nDevice Context: {device_context}"
        try:
            llm_response = self._call_groq_llm(system_prompt, user_prompt)
            return json.loads(llm_response)
        except Exception as e:
            print(f"[Detector] plan_interactive_task failed: {e}")
            return {"error": str(e), "steps": []}

    def evaluate_interactive_step(self, image_b64: str, task_state: dict) -> dict:
        """
        Evaluate a single frame against the current step in the Interactive Task State.
        task_state expects:
        {
            "task_name": "...",
            "current_step": 1,
            "instruction": "...",
            "required_objects": [...],
            "success_condition": "...",
            "fallback": "..."
        }
        """
        try:
            # Compress aggressively — object presence detection doesn't need high detail.
            jpeg_b64 = self._ensure_jpeg_small(image_b64)
            req_objs = ", ".join(task_state.get("required_objects", []))
            
            # Using Groq Vision directly — skips Mistral retry overhead (2-8s) for fast eval.
            vlm_prompt = (
                f"You are a visual guidance evaluator. The user is on step: '{task_state.get('instruction')}'.\n"
                f"Look for these exact objects: {req_objs}.\n"
                "If they are visible, return their exact bounding boxes (normalized 0.0 to 1.0) and set object_found: true.\n"
                "If the object is a tiny UI element (like a mouse cursor) or hard to see, be very lenient. Estimate its bounding box if you can infer its location and set object_found: true.\n"
                "If they are entirely NOT visible, determine how the camera should move based on the current view "
                "(e.g., 'pan left', 'move closer') and output camera_guidance.\n"
                "Evaluate if the success_condition is met: " + task_state.get("success_condition", "") + "\n"
                "Do NOT describe the whole scene. You MUST output valid JSON only. No markdown, no prose:\n"
                "{\n"
                "  \"object_found\": true|false,\n"
                "  \"bounding_box_target\": [x1, y1, x2, y2] | null,\n"
                "  \"camera_guidance\": \"<string or null>\",\n"
                "  \"success_condition_met\": true|false\n"
                "}"
            )
            vlm_response = self._call_groq_vision(jpeg_b64, vlm_prompt)
            
            import re
            clean_json = vlm_response.replace("```json", "").replace("```", "").strip()
            match = re.search(r'\{.*\}', clean_json, re.DOTALL)
            if match:
                result = json.loads(match.group(0))
            else:
                result = json.loads(clean_json)
                
            return {
                "task": task_state.get("task_name"),
                "current_step": task_state.get("current_step", 1),
                "instruction": task_state.get("instruction") if result.get("object_found") else None,
                "required_objects": task_state.get("required_objects"),
                "object_found": result.get("object_found", False),
                "bounding_box_target": result.get("bounding_box_target"),
                "camera_guidance": result.get("camera_guidance") if not result.get("object_found") else None,
                "success_condition_met": result.get("success_condition_met", False)
            }
        except Exception as e:
            print(f"[Detector] evaluate_interactive_step failed: {e}")
            return {
                "object_found": False,
                "camera_guidance": "I'm having trouble analyzing the camera view.",
                "success_condition_met": False,
                "error": str(e)
            }
