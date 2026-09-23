#!/usr/bin/env python3
"""
Notion AI Provider Bridge Service for Yeonjae Studio.

Exposes a local HTTP server speaking the /v1/complete protocol expected by
@yeonjae/gateway HttpProvider, backed by notion_ai_auth.py.
Since Notion AI has no model selector, any requested modelId is accepted and
executed via Notion AI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

# Locate and import notion_ai_auth
NOTION_AUTH_DIRS = [
    "/home/ubuntu",
    os.path.dirname(os.path.abspath(__file__)),
]

notion_ai_auth = None
for d in NOTION_AUTH_DIRS:
    if os.path.isdir(d) and d not in sys.path:
        sys.path.insert(0, d)
    try:
        import notion_ai_auth as _n_auth  # type: ignore
        notion_ai_auth = _n_auth
        break
    except ImportError:
        continue

if notion_ai_auth is None:
    raise RuntimeError(f"Could not import notion_ai_auth from any of: {NOTION_AUTH_DIRS}")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [notion-bridge] %(message)s",
)
logger = logging.getLogger("notion_bridge")

_in_flight_locks: Dict[str, threading.Event] = {}
_in_flight_mutex = threading.Lock()
DEFAULT_MODEL = "notion-ai"


def _sha256(data: str) -> str:
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:16]


_FENCE_RX = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _extract_json(text: str) -> Optional[Any]:
    raw = (text or "").strip()
    if not raw:
        return None
    candidates = [raw]
    for m in _FENCE_RX.findall(raw):
        candidates.append(m.strip())
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        candidates.append(raw[first_brace:last_brace + 1])
    for c in candidates:
        try:
            return json.loads(c, strict=False)
        except Exception:
            pass
        try:
            cleaned = re.sub(r",\s*([\]}])", r"\1", c)
            return json.loads(cleaned, strict=False)
        except Exception:
            pass
    return None


class NotionBridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            logger.warning("Client disconnected before response could be sent")

    def _check_auth(self) -> bool:
        expected = os.getenv("NOTION_BRIDGE_TOKEN") or os.getenv("GENSPARK_BRIDGE_TOKEN")
        if not expected:
            return True
        auth_header = self.headers.get("Authorization", "")
        if auth_header == f"Bearer {expected}":
            return True
        self._send_json(401, {"error": "unauthorized", "message": "Missing or invalid Bearer token"})
        return False

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/health":
            limits = {}
            try:
                limits = notion_ai_auth.get_rate_limits()
            except Exception as e:
                logger.warning("Could not fetch Notion AI rate limits: %s", e)

            self._send_json(200, {
                "status": "ok",
                "provider": "notion",
                "default_model": DEFAULT_MODEL,
                "models": ["notion-ai"],
                "rate_limits": limits,
            })
            return

        if path == "/v1/models":
            self._send_json(200, {
                "models": [{"id": "notion-ai", "name": "Notion AI (Universal)", "provider": "notion"}]
            })
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:
        if not self._check_auth():
            return

        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length).decode("utf-8", errors="replace")

        try:
            payload = json.loads(raw_body) if raw_body else {}
        except Exception as exc:
            self._send_json(400, {"error": "bad_request", "detail": f"Malformed JSON: {exc}"})
            return

        if path == "/v1/cancel":
            key = str(payload.get("idempotencyKey") or "")
            with _in_flight_mutex:
                event = _in_flight_locks.get(key)
                if event:
                    event.set()
            logger.info("Cancellation requested for idempotencyKey: %s", key or "<none>")
            self._send_json(200, {"remote_cancellation": "acknowledged", "idempotencyKey": key})
            return

        if path == "/v1/complete":
            self._handle_complete(payload)
            return

        self._send_json(404, {"error": "not_found", "path": path})

    def _handle_complete(self, payload: Dict[str, Any]) -> None:
        model_id = str(payload.get("modelId") or DEFAULT_MODEL)
        system = str(payload.get("system") or "").strip()
        user = str(payload.get("user") or "").strip()
        params = payload.get("params") or {}
        idempotency_key = str(payload.get("idempotencyKey") or uuid.uuid4().hex[:16])

        cancel_event = threading.Event()
        with _in_flight_mutex:
            _in_flight_locks[idempotency_key] = cancel_event

        prompt_hash = _sha256(system + "\x1f" + user)
        logger.info(
            "Complete request: model=%s, prompt_hash=%s, idemp=%s",
            model_id, prompt_hash, idempotency_key
        )

        started = time.time()
        timeout = int(os.getenv("NOTION_TIMEOUT", "600"))

        try:
            full_reply, metadata = notion_ai_auth.chat_completion(
                prompt=user,
                system_prompt=system if system else None,
                timeout=timeout,
            )
        except Exception as exc:
            err_msg = str(exc)
            logger.error("Notion AI completion error: %s", err_msg)
            status_code = 502
            if "unauthorized" in err_msg.lower() or "401" in err_msg:
                status_code = 401
            elif "rate limit" in err_msg.lower() or "429" in err_msg:
                status_code = 429
            self._send_json(status_code, {
                "error": "provider_error",
                "message": err_msg[:300],
            })
            return
        finally:
            with _in_flight_mutex:
                _in_flight_locks.pop(idempotency_key, None)

        if cancel_event.is_set():
            logger.info("Request %s completed after cancellation; returning cancelled status", idempotency_key)
            self._send_json(499, {"error": "client_closed_request", "message": "Request cancelled"})
            return

        text = full_reply or ""
        input_tokens = max(1, len(system + user) // 4)
        output_tokens = max(1, len(text) // 4)
        parsed_json = _extract_json(text)

        elapsed = time.time() - started
        logger.info(
            "Complete success in %.2fs: output_chars=%d, in_tokens=%d, out_tokens=%d",
            elapsed, len(text), input_tokens, output_tokens
        )

        resp_body = {
            "modelId": model_id,
            "provider": "notion",
            "providerRequestId": f"notion-{idempotency_key}",
            "text": text,
            "finishReason": "stop",
            "usage": {
                "input": input_tokens,
                "output": output_tokens,
                "cached": 0,
            },
            "latencyMs": int(elapsed * 1000),
        }
        if parsed_json is not None:
            resp_body["json"] = parsed_json

        self._send_json(200, resp_body)


def main() -> None:
    parser = argparse.ArgumentParser(description="Notion AI Provider Bridge Service")
    parser.add_argument("--port", type=int, default=int(os.getenv("NOTION_PORT", "8092")), help="Port to listen on")
    parser.add_argument("--host", type=str, default=os.getenv("NOTION_HOST", "127.0.0.1"), help="Host to bind to")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), NotionBridgeHandler)
    logger.info("Notion AI Provider Bridge listening on http://%s:%d", args.host, args.port)
    logger.info("Health check: http://%s:%d/health", args.host, args.port)
    logger.info("Complete endpoint: http://%s:%d/v1/complete", args.host, args.port)

    def _handle_sigterm(signum: int, frame: Any) -> None:
        logger.info("Shutting down Notion AI Provider Bridge...")
        threading.Thread(target=server.shutdown).start()

    signal.signal(signal.SIGINT, _handle_sigterm)
    signal.signal(signal.SIGTERM, _handle_sigterm)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        logger.info("Server stopped.")


if __name__ == "__main__":
    main()
