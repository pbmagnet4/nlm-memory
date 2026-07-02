# Classifier Gold Fixtures

A hand-authored evaluation set for the NLM session classifier. These fixtures
are part of the shipped product; they run as part of the deterministic fixture
eval in CI and are public.

## What is in this set

20 synthetic agent-session transcripts covering the range of sessions the
classifier encounters in practice:

| Category | IDs | Count |
|---|---|---|
| Coding: bug fix | 01, 02, 03 | 3 |
| Coding: feature | 04, 05, 06 | 3 |
| Coding: refactor | 07, 08 | 2 |
| Ops / infra | 09, 10, 11, 12 | 4 |
| Research / writing | 13, 14, 15 | 3 |
| Meeting notes | 16 | 1 |
| Low-signal / trivial | 17, 18, 19, 20 | 4 |

Low-signal sessions (17-20) contain no project context, no decisions, and no
meaningful entities. The classifier prompt instructs models to use confidence
<= 0.4 for routine/trivial sessions. The fixture eval asserts this calibration
in both directions (low-signal sessions must score <= 0.4; substantive sessions
must score > 0.4).

## Authorship rules

All content is fully synthetic. No real projects, people, companies, or
infrastructure appear anywhere in the transcripts or references. Invented
names follow the pattern: single lowercase word (corvid-api, taskvine, lumens,
pulsearch, irongate, gridhost, droneflow, bridgeauth, flarepath, vaultdb,
axiom-worker, crestapi, orbitflow, cobalt-api). Domains are example.com.
Paths are /opt/... or /home/dev/... style.

No em dashes appear in any file in this directory. This is a hard rule for
all text in this repository, fixtures included.

## reference.json schema

```json
[
  {
    "id": "<transcript filename without .txt>",
    "label": "Expected label string (4-10 words)",
    "labelAlternates": ["alternate phrasings that also count as correct"],
    "entities": ["exact named things the classifier must surface"],
    "decisions": ["key phrase that must appear in a matched extracted decision"],
    "expectLowConfidence": false
  }
]
```

Field notes:

- `entities`: only unambiguous named things (project names, specific
  technologies, specific error types). Do not include generic nouns. An entity
  is matched if the reference string appears (case-insensitive) as a substring
  in any extracted entity, or vice versa.
- `decisions`: concrete enough to match by key-phrase overlap. The scorer
  checks whether a reference decision's key tokens appear in at least one
  extracted decision. Author reference decisions around the unique commitment
  (e.g. "SELECT FOR UPDATE SKIP LOCKED") rather than generic phrasing.
- `expectLowConfidence`: true for sessions 17-20. The classifier must return
  confidence <= 0.4 for these or the calibration check fails.

## Frozen prompt dependency

The reference values are authored against the classifier prompt in:

    src/core/classifier/prompt.ts (CLASSIFIER_SYSTEM_PROMPT)

Specifically:
- The label style guidance ("4-10 word string title")
- The closed PREDICATE_VOCABULARY (for any expected facts, though facts are
  not included in this fixture set's reference shape)
- The confidence instruction ("Use 0.4 or below for routine/trivial sessions")

If CLASSIFIER_SYSTEM_PROMPT changes materially, review all reference.json
entries and update expectLowConfidence thresholds if the confidence instruction
changes.

## How to add a fixture

1. Write a .txt transcript in transcripts/. File name: NN-category-short-slug.txt.
   Keep it 1-6K characters. Use only invented names. No em dashes.
2. Add an entry to reference.json. Choose entities and decisions that are
   unambiguous: a competent extraction must find them; borderline cases must
   not be included.
3. Run the fixture eval to confirm your reference scores as expected:
   `npx tsx scripts/eval/classifier-eval.ts --fixtures tests/fixtures/classifier-gold`
4. Increment the fixture count comment at the top of
   src/core/eval/classifier-fixture-eval.ts if it exists.
