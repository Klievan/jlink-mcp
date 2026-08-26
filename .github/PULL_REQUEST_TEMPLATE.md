## What and why

<!-- What changes, and what problem it solves. If hardware or a tool told you
     something surprising, quote the actual output — that evidence is the most
     useful thing in the PR. -->

## How it was verified

<!-- Tick what applies. "It compiles" is not verification. -->

- [ ] `npm test` passes
- [ ] `npm run test:hil` passes against a real probe
- [ ] Behaviour asserted on *content*, not just that the call returned
- [ ] If this touches tool output an LLM reads: checked the failure path too
