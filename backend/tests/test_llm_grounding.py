"""Quote grounding (D12): normalized substring match against the other party only."""

from dme.contract import Utterance
from dme.llm.grounding import normalize, party_texts, verify_quote


def U(speaker, text):
    return Utterance(speaker=speaker, text=text)


def test_normalize_case_space_quotes_dashes_trailing_punct():
    assert normalize("  We’re   OUT.\n") == "we're out"
    assert normalize("“Yep, and yep!”") == "yep, and yep"
    assert normalize("1EG4–TE5—MK73") == "1eg4-te5-mk73"
    assert normalize("Wait…") == "wait"


def test_exact_and_normalized_substring_verify():
    src = ["We've got standard chairs on the floor and we're right down the street."]
    assert verify_quote("we’ve got standard chairs on the floor", src)
    assert verify_quote("We're right down the street.", src)
    assert verify_quote("right   down\nthe street", src)


def test_paraphrase_and_reordering_fail():
    src = ["Yep, and yep."]
    assert not verify_quote("Yes, and yes.", src)
    assert not verify_quote("yep and yep", src)       # interior punctuation is wording
    assert not verify_quote("and yep, yep", src)


def test_empty_or_missing_quote_fails():
    assert not verify_quote(None, ["anything"])
    assert not verify_quote("", ["anything"])
    assert not verify_quote(" ... ", ["anything"])


def test_quote_cannot_span_two_utterances():
    src = ["We could.", "Thursday morning is the earliest."]
    assert not verify_quote("We could. Thursday morning", src)


def test_quote_only_in_engines_line_is_unverified():
    transcript = [
        U("engine", "So you deliver in three days, correct?"),
        U("party", "Mm, let me check with the driver."),
    ]
    assert not verify_quote("deliver in three days", party_texts(transcript))
    assert verify_quote("let me check with the driver", party_texts(transcript))
