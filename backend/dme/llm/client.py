"""Thin LLM client for the call runner, extraction and personas.

Two operations are all the rest of dme.llm needs:

* `text(...)`  - one free-text reply (persona lines);
* `json(...)`  - one reply constrained to a JSON schema via structured outputs
                 (`output_config.format`). Used for extraction and for the caller's
                 `{line, end_call}` turns. Forced tool_choice is not available on the
                 current Sonnet, so structured outputs are the schema-enforcing path.

`AnthropicLLM` talks to the API; `FakeLLM` is a scripted stand-in for unit tests.

Models come from the environment:
  DME_MODEL          (default claude-sonnet-5-5)  caller lines + extraction
  DME_PERSONA_MODEL  (default claude-haiku-5-5)   autopilot personas
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import anthropic

log = logging.getLogger(__name__)

Role = Literal["caller", "persona"]

DEFAULT_MODEL = "claude-sonnet-5-5"
DEFAULT_PERSONA_MODEL = "claude-haiku-5-5"

# Short, conversational turns: low effort keeps per-turn latency down. Thinking cannot be
# disabled on the current Sonnet/Haiku; effort is the lever.
EFFORT: dict[Role, str] = {"caller": "low", "persona": "low"}


def api_key() -> str | None:
    """ANTHROPIC_API_KEY, else ANTHROPIC_API_KEY_PERSONAL. Never logged."""
    return os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY_PERSONAL") or None


def model_for(role: Role) -> str:
    if role == "persona":
        return os.environ.get("DME_PERSONA_MODEL", DEFAULT_PERSONA_MODEL)
    return os.environ.get("DME_MODEL", DEFAULT_MODEL)


class LLMError(RuntimeError):
    """The model did not return usable output (refusal, truncation, bad JSON)."""


class LLM(Protocol):
    async def text(self, *, role: Role, system: str, messages: list[dict], max_tokens: int = 400) -> str: ...

    async def json(self, *, role: Role, system: str, messages: list[dict], schema: dict,
                   max_tokens: int = 2000) -> dict: ...


@dataclass
class CallStat:
    role: Role
    kind: str
    seconds: float


class AnthropicLLM:
    """AsyncAnthropic-backed implementation.

    Transient errors (connection, timeout, 408/409/429/5xx/overloaded) are retried by the
    SDK (`max_retries`). On top of that, one extra attempt is made for a refusal-free
    response that fails to parse (rare with structured outputs, but cheap to guard).
    """

    def __init__(self, *, client: anthropic.AsyncAnthropic | None = None, max_retries: int = 3,
                 timeout: float = 60.0) -> None:
        if client is None:
            key = api_key()
            if not key:
                raise LLMError("No API key: set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_PERSONAL")
            client = anthropic.AsyncAnthropic(api_key=key, max_retries=max_retries, timeout=timeout)
        self._client = client
        self.stats: list[CallStat] = []   # per-request latency, for the report / debugging

    async def _create(self, role: Role, kind: str, **params: Any) -> Any:
        t0 = time.perf_counter()
        resp = await self._client.messages.create(model=model_for(role), **params)
        self.stats.append(CallStat(role, kind, time.perf_counter() - t0))
        if resp.stop_reason == "refusal":
            raise LLMError(f"model refused ({role}/{kind})")
        if resp.stop_reason == "max_tokens":
            raise LLMError(f"output truncated ({role}/{kind})")
        return resp

    @staticmethod
    def _first_text(resp: Any) -> str:
        for block in resp.content:
            if block.type == "text":
                return block.text
        return ""

    async def text(self, *, role: Role, system: str, messages: list[dict], max_tokens: int = 400) -> str:
        resp = await self._create(
            role, "text", system=system, messages=messages, max_tokens=max_tokens,
            output_config={"effort": EFFORT[role]},
        )
        return self._first_text(resp).strip()

    async def json(self, *, role: Role, system: str, messages: list[dict], schema: dict,
                   max_tokens: int = 2000) -> dict:
        last: Exception | None = None
        for _ in range(2):
            try:
                resp = await self._create(
                    role, "json", system=system, messages=messages, max_tokens=max_tokens,
                    output_config={"effort": EFFORT[role],
                                   "format": {"type": "json_schema", "schema": schema}},
                )
                return json.loads(self._first_text(resp))
            except (json.JSONDecodeError, LLMError) as e:
                last = e
                log.warning("structured output failed, retrying once: %s", e)
        raise LLMError(f"no valid JSON after retry: {last}")


# ---------------------------------------------------------------------------
# Test double
# ---------------------------------------------------------------------------

TextFn = Callable[[str, list[dict]], str]
JsonFn = Callable[[str, list[dict], dict], dict]


@dataclass
class FakeLLM:
    """Scripted LLM for unit tests.

    Each of `text_fn` / `json_fn` is either a callable (system, messages[, schema]) -> output,
    or a list of outputs consumed in order. Every request is recorded in `calls` so tests
    can assert what the model was shown.
    """

    text_fn: TextFn | list[str] | None = None
    json_fn: JsonFn | list[dict] | None = None
    calls: list[dict] = field(default_factory=list)

    @staticmethod
    def _next(src: Any, *args: Any) -> Any:
        if callable(src):
            return src(*args)
        if isinstance(src, list):
            if not src:
                raise LLMError("FakeLLM script exhausted")
            return src.pop(0)
        raise LLMError("FakeLLM has no script for this request")

    async def text(self, *, role: Role, system: str, messages: list[dict], max_tokens: int = 400) -> str:
        self.calls.append({"kind": "text", "role": role, "system": system, "messages": messages})
        await asyncio.sleep(0)
        return self._next(self.text_fn, system, messages)

    async def json(self, *, role: Role, system: str, messages: list[dict], schema: dict,
                   max_tokens: int = 2000) -> dict:
        self.calls.append({"kind": "json", "role": role, "system": system, "messages": messages,
                           "schema": schema})
        await asyncio.sleep(0)
        return self._next(self.json_fn, system, messages, schema)
