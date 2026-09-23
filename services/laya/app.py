"""Local-only Laya semantic assertion sidecar. No generative/cloud fallback."""
import os
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HOME", os.path.abspath(".data/huggingface"))

import math
import threading
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

router = None
lock = threading.Lock()
load_error = None


def load_models():
    global router, load_error
    try:
        from laya import Router
        instance = Router(max_loaded=2, device=os.getenv("LAYA_DEVICE", "cpu"))
        instance.preload(["english", "multilingual"])
        router = instance
    except Exception as exc:
        load_error = str(exc)


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_models, daemon=True).start()
    yield


app = FastAPI(title="AutoStage / Laya", lifespan=lifespan)


class Assertion(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=12000)]
    expectation: Annotated[str, Field(min_length=1, max_length=4000)]


@app.get("/health")
def health():
    return {"ready": router is not None, "model": "laya router · english / multilingual", "error": load_error}


@app.post("/assert")
def evaluate(body: Assertion):
    if router is None:
        raise HTTPException(503, load_error or "Laya models are loading")
    questions = {"assertion": {"type": "noul", "instructions": "Based only on the observed page text, is this expected condition true? " + body.expectation}}
    with lock:
        from laya.common import build_sequence
        state = {"page_text": body.text}
        route = router.route(state, questions)
        agent = router.load(route["model"])
        question = {"t": "noul", "ins": questions["assertion"]["instructions"], "crit": None}
        full, _ = build_sequence(agent.tok, state, question, 1000000, 1000000)
        bounded, _ = build_sequence(agent.tok, state, question, agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192))
        if len(full) > len(bounded):
            raise HTTPException(422, "判定対象または期待条件が Laya の文脈長を超えています。対象セレクターで範囲を絞るか、条件を短くしてください。")
        result = router.predict(state, questions)
    value = result.get("answers", {}).get("assertion", {}).get("noul")
    if not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise HTTPException(502, "Laya returned an invalid probability")
    return {"probability": value, "routing": result.get("routing", {}), "evidence": body.text}
