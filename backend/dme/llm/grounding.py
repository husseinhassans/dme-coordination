"""Quote grounding for extracted facts (spec D12).

An LLM-extracted fact is accepted only if its quote is found, by normalized substring
match, in the text the fact is allowed to come from:

* on a call: ONLY the other party's utterances. The engine's own lines never count,
  so the engine cannot "ground" a fact in something it said itself;
* on a fax: the document text.

The match is deliberately mechanical: no fuzzy matching, no LLM judgment. Normalization
only removes differences that are not differences in wording (case, whitespace, curly vs.
straight quotes, dash variants, trailing punctuation). A quote must sit inside ONE
utterance; it cannot stitch two utterances together.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from dme.contract import Utterance

_CHAR_MAP = str.maketrans({
    # single quotes / apostrophes
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
    # double quotes
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    # dashes and minus signs
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-",
    # non-breaking / narrow spaces
    " ": " ", " ": " ", " ": " ",
})

# Punctuation stripped from the ends of a quote (and of nothing else).
_EDGE_PUNCT = " .,;:!?\"'()[]-…"
_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Casefold, unify quotes/dashes, expand the ellipsis char, collapse whitespace,
    and strip punctuation from both ends."""
    t = text.translate(_CHAR_MAP).replace("…", "...").casefold()
    t = _WS.sub(" ", t)
    return t.strip(_EDGE_PUNCT)


def party_texts(transcript: Iterable[Utterance]) -> list[str]:
    """The only call text a quote may come from: the other party's lines."""
    return [u.text for u in transcript if u.speaker == "party"]


def verify_quote(quote: str | None, sources: Iterable[str]) -> bool:
    """True if `quote` (normalized) is a substring of one normalized source."""
    if not quote:
        return False
    q = normalize(quote)
    if not q:
        return False
    return any(q in normalize(s) for s in sources)
