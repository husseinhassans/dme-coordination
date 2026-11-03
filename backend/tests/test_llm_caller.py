"""LLMCallRunner loop with FakeLLM and scripted parties: stop conditions, hooks, D2."""

from datetime import datetime

from dme.contract import CALL_PURPOSES, CallGoal, Utterance
from dme.llm.caller import CLOSING_CUE, DISCLOSURE, LAST_QUESTION_CUE, LLMCallRunner
from dme.llm.client import FakeLLM

T0 = datetime(2026, 11, 2, 9, 10)


class ScriptedParty:
    kind = "supplier"
    id = "x"
    name = "Test Supply"

    def __init__(self, replies, answers=True):
        self.replies = list(replies)
        self.answers = answers
        self.seen: list[list[Utterance]] = []

    async def pick_up(self, goal):
        return self.answers

    async def reply(self, transcript):
        self.seen.append(list(transcript))
        return self.replies.pop(0) if self.replies else None


def goal(purpose="supplier_reconfirm", max_turns=4):
    return CallGoal(purpose=purpose, thread="supplier", party_kind="supplier", party_id="x",
                    party_name="Test Supply", brief="Re-check a qualified backup.",
                    facts=CALL_PURPOSES[purpose], max_turns=max_turns)


def fake(lines, extractions):
    """Caller turns come from `lines`; extraction results from `extractions` (one per party turn)."""
    lines, extractions = list(lines), list(extractions)

    def json_fn(system, messages, schema):
        if "line" in schema["properties"]:
            return lines.pop(0)
        return extractions.pop(0)
    return FakeLLM(json_fn=json_fn)


def F(**kv):
    return {"facts": [{"key": k, "value": v, "quote": q} for k, (v, q) in kv.items()]}


def L(text, end=False):
    return {"line": text, "end_call": end}


async def test_no_answer():
    runner = LLMCallRunner(FakeLLM(), now=lambda: T0)
    rec = await runner.run(goal(), ScriptedParty([], answers=False))
    assert rec.outcome == "no_answer" and rec.transcript == [] and rec.started_at == T0


async def test_stops_when_required_facts_known_then_closes():
    log = []

    async def on_utt(cid, speaker, text):
        log.append((cid, speaker, text))

    facts_log = []

    async def on_facts(cid, facts):
        facts_log.append(facts)

    full = F(still_available=("true", "We could."),
             earliest_delivery=("Thursday morning", "Thursday morning is the earliest"))
    llm = fake([L("Hi, this is an automated assistant for a care team. Could you still take the referral?"),
                L("Thanks, goodbye.", True)],
               [full])
    party = ScriptedParty(["We could. Thursday morning is the earliest.", "should not be asked"])
    runner = LLMCallRunner(llm, on_utterance=on_utt, on_facts=on_facts, now=lambda: T0)
    rec = await runner.run(goal(), party, call_id="call-1")

    assert rec.outcome == "answered" and rec.id == "call-1"
    assert [u.speaker for u in rec.transcript] == ["engine", "party", "engine"]
    assert rec.transcript[-1].text == "Thanks, goodbye."
    assert rec.facts["still_available"].known and rec.facts["earliest_delivery"].known
    assert rec.safety_flag is not None and not rec.safety_flag.known
    assert "safety_concern" not in rec.facts
    assert [x[1] for x in log] == ["engine", "party", "engine"] and all(x[0] == "call-1" for x in log)
    assert len(facts_log) == 1
    # the wrap-up cue is operator text: system prompt only, never in the party's turns
    close_call = [c for c in llm.calls if c["kind"] == "json" and "line" in c["schema"]["properties"]][-1]
    assert LAST_QUESTION_CUE in close_call["system"]
    assert all(LAST_QUESTION_CUE not in m["content"] for m in close_call["messages"])


async def test_one_more_question_for_optional_fact_then_close():
    llm = fake([L("Hi, this is an automated assistant for a care team. Could you still take the referral?"),
                L("Shall we send you the order?"),
                L("Thank you. Goodbye.")],
               [F(still_available=("true", "We could."), earliest_delivery=("Thursday", "Thursday works")),
                F(accepts_referral=("true", "send the order whenever"))])
    party = ScriptedParty(["We could. Thursday works.", "Sure, send the order whenever.", "unused"])
    rec = await LLMCallRunner(llm, now=lambda: T0).run(goal(max_turns=6), party)
    assert [u.speaker for u in rec.transcript] == ["engine", "party", "engine", "party", "engine"]
    assert rec.facts["accepts_referral"].known and rec.facts["still_available"].known
    last = [c for c in llm.calls if "line" in c["schema"]["properties"]][-1]
    assert CLOSING_CUE in last["system"]


async def test_hang_up():
    llm = fake([L("Hi, this is an automated assistant for a care team. Can you still take it?")], [])
    rec = await LLMCallRunner(llm, now=lambda: T0).run(goal(), ScriptedParty([]))
    assert rec.outcome == "hung_up"
    assert [u.speaker for u in rec.transcript] == ["engine"]


async def test_max_turns_then_close():
    nothing = F()
    llm = fake([L("Hi, this is an automated assistant for a care team. Can you take it?"),
                L("Sorry, can you take it?"), L("Bye now.")],
               [nothing, nothing])
    rec = await LLMCallRunner(llm, now=lambda: T0).run(goal(max_turns=2), ScriptedParty(["Hmm.", "Hmm."]))
    assert rec.outcome == "answered"
    assert [u.speaker for u in rec.transcript] == ["engine", "party", "engine", "party", "engine"]
    assert not rec.facts["still_available"].known


async def test_caller_ends_call_after_decisive_answer():
    llm = fake([L("Hi, this is an automated assistant for a care team. Are you taking new Medicare patients?"),
                L("Understood, thank you. Goodbye.", True)],
               [F(accepting_new_medicare=("false", "Not right now"))])
    party = ScriptedParty(["Not right now, hon.", "unused"])
    rec = await LLMCallRunner(llm, now=lambda: T0).run(goal("supplier_screen", 8), party)
    assert len(rec.transcript) == 3 and rec.transcript[-1].text.endswith("Goodbye.")
    assert rec.facts["accepting_new_medicare"].known and rec.facts["accepting_new_medicare"].value is False
    assert len(party.seen) == 1


async def test_disclosure_enforced_on_first_line():
    llm = fake([L("Can you still take the referral?"), L("Bye.", True)], [F()])
    rec = await LLMCallRunner(llm, now=lambda: T0).run(goal(), ScriptedParty(["Maybe."]))
    assert rec.transcript[0].text.startswith(DISCLOSURE)


async def test_read_document_uses_document():
    llm = FakeLLM(json_fn=[F(hcpcs=("K0001", "HCPCS: K0001"))])
    from dme.contract import ORDER_DOC_FACTS
    from dme.llm.personas import DOC2
    facts = await LLMCallRunner(llm).read_document(DOC2, ORDER_DOC_FACTS)
    assert facts["hcpcs"].known
