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
    """DME_ANTHROPIC_API_KEY (this project's own key), else ANTHROPIC_API_KEY. Never logged.

    The project key wins so a general ANTHROPIC_API_KEY exported for other tools is never
    billed by accident."""
    return os.environ.get("DME_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or None


def model_for(role: Role) -> str:
    if role == "persona":
        return os.environ.get("DME_PERSONA_MODEL", DEFAULT_PERSONA_MODEL)
    return os.environ.get("DME_MODEL", DEFAULT_MODEL)


class LLMError(RuntimeError):
    """The model did not return usable output (refusal, truncation, bad JSON)."""


class BudgetExceeded(LLMError):
    """The run hit its dollar cap (DME_BUDGET_USD). No further requests are sent."""


# Rough $/million tokens (input, output), deliberately on the high side so the cap trips early.
PRICE_PER_MTOK: dict[Role, tuple[float, float]] = {"caller": (3.0, 15.0), "persona": (1.0, 5.0)}


def budget_usd() -> float:
    return float(os.environ.get("DME_BUDGET_USD", "3"))


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
        # Built on first use: the server (and the key-free replay) start without a key,
        # and a live run reports the missing key when it makes its first call.
        self._client = client
        self._client_args = {"max_retries": max_retries, "timeout": timeout}
        self.stats: list[CallStat] = []   # per-request latency, for the report / debugging
        self.spent_usd = 0.0              # estimated from response usage
        self.budget_usd = budget_usd()

    async def _create(self, role: Role, kind: str, **params: Any) -> Any:
        if self.spent_usd >= self.budget_usd:
            raise BudgetExceeded(f"run budget of ${self.budget_usd:.2f} reached "
                                 f"(spent ~${self.spent_usd:.2f}); set DME_BUDGET_USD to raise it")
        if self._client is None:
            key = api_key()
            if not key:
                raise LLMError("No API key: set DME_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY to run live")
            self._client = anthropic.AsyncAnthropic(api_key=key, **self._client_args)
        t0 = time.perf_counter()
        resp = await self._client.messages.create(model=model_for(role), **params)
        self.stats.append(CallStat(role, kind, time.perf_counter() - t0))
        u = resp.usage
        p_in, p_out = PRICE_PER_MTOK[role]
        tokens_in = (u.input_tokens or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0) \
            + 0.1 * (getattr(u, "cache_read_input_tokens", 0) or 0)
        self.spent_usd += (tokens_in * p_in + (u.output_tokens or 0) * p_out) / 1e6
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
            except BudgetExceeded:
                raise
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
