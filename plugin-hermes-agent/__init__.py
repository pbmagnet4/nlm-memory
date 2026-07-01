"""
nlm-memory Hermes Agent plugin.

Wires 6 Hermes lifecycle hooks to the local nlm-memory daemon
(http://localhost:3940 by default). All calls are fire-and-forget
except pre_llm_call, which returns a context string for injection.

The daemon must be running for hooks to have effect. If it is unreachable,
every hook silently returns None so the agent loop is never blocked.
"""

import http.client
import json
import os
import urllib.error
import urllib.request
from typing import Any


def _base_url() -> str:
    port = os.environ.get("NLM_DAEMON_PORT", "3940")
    return f"http://localhost:{port}"


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = f"{_base_url()}/api/{path}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError, http.client.HTTPException):
        return {}


def register(ctx: Any) -> None:
    def pre_llm_call(
        session_id: str,
        user_message: str,
        is_first_turn: bool = False,
        **kwargs: Any,
    ) -> str | None:
        result = _post(
            "hook/hermes-agent/pre-turn",
            {"session_id": session_id, "user_message": user_message, "is_first_turn": is_first_turn},
        )
        context = result.get("context")
        return context if isinstance(context, str) and context else None

    def post_llm_call(
        session_id: str,
        assistant_response: str,
        **kwargs: Any,
    ) -> None:
        _post(
            "hook/hermes-agent/post-turn",
            {"session_id": session_id, "assistant_response": assistant_response},
        )

    def _session_event(event: str, session_id: str | None, **kwargs: Any) -> None:
        _post(
            "hook/hermes-agent/session-lifecycle",
            {"event": event, "session_id": session_id},
        )

    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("on_session_start", lambda session_id, **kw: _session_event("start", session_id, **kw))
    ctx.register_hook("on_session_end", lambda session_id, **kw: _session_event("end", session_id, **kw))
    ctx.register_hook("on_session_finalize", lambda session_id=None, **kw: _session_event("finalize", session_id, **kw))
    ctx.register_hook("on_session_reset", lambda session_id, **kw: _session_event("reset", session_id, **kw))
