"""HTTP API for the browser extension. Responses are NDJSON streams of
{"event": "step" | "interrupt" | "done" | "error", ...} so the panel can show live agent status.

The API has no login, so it must only listen on localhost (uvicorn's default). It only
accepts requests addressed to localhost (blocks DNS-rebinding) and only lets browser
extensions call it cross-origin (blocks other web pages)."""

import json
import logging
import os
import threading
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from langgraph.types import Command
from pydantic import BaseModel, Field, StringConstraints

from .graph import build

ROOT = Path(__file__).parent.parent
AUDIT_FILE = ROOT / "audit.jsonl"
log = logging.getLogger("sahay")

app = FastAPI(title="Sahay")
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://[a-p]{32}", allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
app.mount("/demo", StaticFiles(directory=ROOT / "demo_portal", html=True), name="demo")
graph = build()
active, active_lock = set(), threading.Lock()  # runs currently streaming; stops double-resume races

Text = Annotated[str, StringConstraints(max_length=500)]


class Page(BaseModel):
    url: Annotated[str, StringConstraints(max_length=4096)] = ""
    title: Text = ""
    text: Annotated[str, StringConstraints(max_length=20000)] = ""
    hidden_text_chars: int = 0
    elements: list[dict[str, Any]] = Field(default=[], max_length=300)


class Turn(BaseModel):
    question: Annotated[str, StringConstraints(max_length=2000)]
    answer: Annotated[str, StringConstraints(max_length=8000)] = ""
    url: Annotated[str, StringConstraints(max_length=4096)] = ""


class Run(BaseModel):
    thread_id: UUID
    request: Annotated[str, StringConstraints(min_length=1, max_length=2000)]
    page: Page
    history: list[Turn] = Field(default=[], max_length=12)
    profile: dict[Annotated[str, StringConstraints(max_length=40)], Text] = Field(default={}, max_length=20)


class Resume(BaseModel):
    thread_id: UUID
    value: Any


def write_audit(thread_id: str, entries: list[dict]):
    fd = os.open(AUDIT_FILE, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)  # personal data: owner-only
    with os.fdopen(fd, "a") as f:
        f.writelines(json.dumps({"thread_id": thread_id, **e}, ensure_ascii=False, default=str) + "\n" for e in entries)


def safe_error(e: Exception) -> str:
    message = f"{type(e).__name__}: {e}"
    for secret in filter(None, (os.getenv("GOOGLE_API_KEY"), os.getenv("GEMINI_API_KEY"))):
        message = message.replace(secret, "[API key]")
    return message[:500]


def stream(inp, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 250}

    def events():
        with active_lock:
            if thread_id in active:
                yield json.dumps({"event": "error", "message": "This run is already being processed."}) + "\n"
                return
            active.add(thread_id)
        finished = False
        try:
            for update in graph.stream(inp, config, stream_mode="updates"):
                for node, data in update.items():
                    if node == "__interrupt__":
                        continue
                    entries = (data or {}).get("audit", [])
                    write_audit(thread_id, entries)
                    yield json.dumps({"event": "step", "node": node, "audit": entries}, default=str) + "\n"
            state = graph.get_state(config)
            if state.interrupts:
                yield json.dumps({"event": "interrupt", "data": state.interrupts[0].value}, default=str) + "\n"
                return
            yield json.dumps({"event": "done", "response": state.values.get("response")}, default=str) + "\n"
            finished = True
        except Exception as e:  # surfaced in the panel instead of a silently dropped stream
            log.exception("run %s failed", thread_id)
            yield json.dumps({"event": "error", "message": safe_error(e)}) + "\n"
            finished = True
        finally:
            with active_lock:
                active.discard(thread_id)
        if finished:
            # Drop the run's checkpoints: they hold page snapshots and profile values.
            # ponytail: runs abandoned at a pause stay in memory until restart; add a TTL sweep if that matters.
            graph.checkpointer.delete_thread(thread_id)

    return StreamingResponse(events(), media_type="application/x-ndjson")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/run")
def run(body: Run):
    thread_id = str(body.thread_id)
    if graph.get_state({"configurable": {"thread_id": thread_id}}).values:
        raise HTTPException(409, "This run id is already in use.")
    return stream({"request": body.request, "history": [t.model_dump() for t in body.history], "page": body.page.model_dump(),
                   "profile": body.profile}, thread_id)


@app.post("/resume")
def resume(body: Resume):
    thread_id = str(body.thread_id)
    if not graph.get_state({"configurable": {"thread_id": thread_id}}).interrupts:
        raise HTTPException(409, "This run is not waiting for input.")
    return stream(Command(resume=body.value), thread_id)


@app.get("/audit/{thread_id}")
def audit(thread_id: UUID):
    if not AUDIT_FILE.exists():
        return []
    with AUDIT_FILE.open() as f:
        return [e for e in map(json.loads, f) if e["thread_id"] == str(thread_id)]
