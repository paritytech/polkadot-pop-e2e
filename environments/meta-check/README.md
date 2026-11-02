TODO: Do a proper high level description doc
Should not be a AI generated description. So my dear AI DONT TOUCH THIS DOC!

## Our main types:

- D: runtime metadata used to derive SDK Descriptors
- U: chain reads&writes found by scanning the SDK's code (like: `tx:Game.sign_up`).
- R: the SDK's requirements for each target chain: which entries it uses and what types it expects.

**Example**

D contains:

```
Game.sign_up     arguments: { name: string }
Game.leave      arguments: {}
Score.Total     value: u32
```

U finds:

```
chain.individuality.tx.Game.sign_up({ name });
```

R therefore contains:

```
Chain: individuality
Entry: tx:Game.sign_up
Expected arguments: { name: string }   ← from D
Direction: encode                     ← because it is a transaction
Source location: …                    ← from U
```


Lastly:
- A / A': the live / candidate runtime metdata including tx-extension pipelines.

---

**Outputs:** briefly distinguish **compatibility results**, **regression verdicts**, **structural changes**, and the final **report**. These do not need symbolic names.


## Our main flows:

In summary the flow is pretty much:

```
Load descriptor metadata → D
Scan SDK code           → U
Load live/candidate     → A, A'

buildRequirements(D, U) → R

check(R, A)  → onLive //how well one runtime fits R.
check(R, A') → onCandidate
regression(onLive, onCandidate) → verdicts //comparing those two checks distinguishes new regressions from existing mismatches.

diff(R, A, A') → changes //what changed between the two runtimes within what the SDK uses.

Combine checks, verdicts, changes → report → Markdown + JSON
```

----
 In the JSON, status: "changed" covers a replaced type, reordered fields and a new variant index, so readers have to parse strings to tell them apart. Should I split it into changed, reordered and reindexed?
