"""LLM layer: call runner, grounded extraction, and autopilot personas (spec §9, D12)."""

from .caller import LLMCallRunner
from .client import AnthropicLLM, FakeLLM, LLM, api_key
from .extract import extract_from_document, extract_from_transcript
from .grounding import normalize, verify_quote
from .personas import (
    DOC1, DOC2, AutopilotCast, AutopilotFaxDesk, OfficePersona, PatientPersona, SupplierPersona,
)

__all__ = [
    "LLMCallRunner", "AnthropicLLM", "FakeLLM", "LLM", "api_key",
    "extract_from_document", "extract_from_transcript", "normalize", "verify_quote",
    "DOC1", "DOC2", "AutopilotCast", "AutopilotFaxDesk", "OfficePersona", "PatientPersona", "SupplierPersona",
]
