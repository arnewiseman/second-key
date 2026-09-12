# Hackathon Brief

Context file for the Second Key build. Read this alongside `second-key-prd.md`. The PRD says what to build. This says why the constraints exist and what winning looks like.

---

## The event

AI Tinkerers "Agents, Everywhere: Bots, Channels, & More" global hackathon, Saturday 12 September 2026, Portland edition, 10:00 to 17:00 local.

Every participating city enters one shared global submission pool. There is no formal local judging, so the room's reaction on the day is worth nothing to the outcome. The two minute video is what judges actually see.

**The challenge, in their words:** most agents still wait inside a separate chat window. Build a working agent that belongs somewhere people already work, talk, and live, and make it meaningfully more useful because of that context.

**Their example surfaces:** at work (Slack, Teams, email, documents, calendars, tickets), in your pocket (messaging, mobile, notifications), on the web (browsers, transacting agents), in the room (voice, vision, wearables, robotics). These are examples, not tracks. Everyone competes in the same pool.

---

## Schedule

| Time | What |
| --- | --- |
| 10:00 to 10:30 | Doors, food, check-in |
| 10:30 to 11:00 | Global opening and starter-kit walkthrough |
| 11:00 to 11:15 | Team formation |
| 11:15 to 15:30 | Build session |
| 15:30 to 16:00 | Submissions in the portal |
| 16:00 to 16:45 | Optional local show-and-tell |
| 16:45 to 17:00 | Wrap and group photo |

The portal window is only 30 minutes and it is not enough time to both record and write. Everything except the upload has to be done before 15:30.

---

## What we must submit

All five are required. A missing one is an eligibility question, not a style question.

1. **Title.** "Second Key: an AI coworker that prepares privileged access changes and routes them to a human."
2. **Written description.** Must cover what we built, who it is for, and why the context matters. Those are their three named asks, so answer them in that order.
3. **Public GitHub repository.** Working code that can be reviewed and learned from.
4. **Two minute video.** Concise demo of the project in action.
5. **Social post.** Public, tagging the event sponsors.

---

## Prizes and where we are aiming

Global pool: first place is $10,000 in OpenAI credits, a Mac mini each, and $1,000 in Exa credits. Second is $5,000 in credits, Ray-Ban Meta glasses each, $500 Exa. Third is $2,500 in credits, a LOOI robot each, $250 Exa.

Category prizes: **Best Use of Ambiguous AI** is one NVIDIA DGX Spark for the team. Best Use of CopilotKit is purple AirPods Max each.

**We are targeting Best Use of Ambiguous AI.** The global pool contains every team in every city and will be dominated by workspace agents. Ambiguous is a new sponsor that most builders have never heard of, so the category field should be thin, and our design sits natively on their primitives (agent identity, own inbox, docs, tasks, calendar, audit log). The main pool is upside, not the plan.

**We are not chasing the CopilotKit prize.** The surfaces pull in opposite directions and splitting would mean finishing neither. We are also not using Exa, Trigger.dev, Auth0 or Mozilla.ai, and we will not claim stack breadth we do not have.

---

## Positioning

This category is crowded with funded products. Opal's Paladin agent, ConductorOne's Copilot, Risotto, Teleport's approval plugins, Orca's time-bound JIT grants, and Token Security's least-privilege generator all overlap with parts of this. Judges are not running that search, but a description claiming novelty they can disprove in one query is a real risk.

**What we claim:** the governance pattern those platforms sell as a console, rebuilt as a single workspace teammate in four hours, with the whole decision chain living in the docs, tasks, calendar and mail the team already uses.

**What we do not claim:** that AI-assisted access review is new, that this replaces an IGA platform, or that the cloud integration is live.

**The line that carries the submission:** an approval is only worth something if it is attributable and reconstructable later. That requires the agent to be a workspace member with its own identity and audit trail, not a bot posting into a chat window. Our primary reader is the auditor, not the requester.

---

## Rules of engagement

- **No new external service after 11:15.** Additions must be a new code path or a new fixture inside what already exists. Every new integration costs an auth dance, a failure mode, and a slower video.
- **Hard freeze at 14:45** regardless of state. 14:45 to 15:15 is README, video, social post, submit.
- **Submit by 15:15, not 15:29.**
- **Disjoint file ownership.** Nobody edits another stream's paths. See PRD section 6.
- **`types.ts` freezes at 11:35.** Changes after that need all three of us agreeing in person.
- **The agent never executes a grant.** This is a product decision, not a scope cut, and it is the pitch.
- **The model never decides policy.** It parses and explains. Verdicts come from YAML rules.

---

## Team

Three people, three streams, defined in PRD section 6. Stream A is platform and the Ambiguous client. Stream B is the decision engine, policy and fixtures. Stream C is the record, audit path, demo mode and the repo writeup.

Whoever has the least code at 13:30 owns the video and starts storyboarding then. The description and social post get drafted during the build, not after the freeze.

The demo needs two accounts. The requester and the approver cannot be the same person on camera, because separation of duties is the entire premise.

---

## Open items from the opening session

The judging rubric, prize category details and the starter repo are all released at the 10:30 walkthrough and did not exist when this was written.

After the session, come back and fill in:

- **Rubric weights.** If novel surface is weighted heavily, push the auditor framing harder in the title and first line. If working demo is weighted heavily, cut P1 items and polish the core loop.
- **Starter repo.** If it pushes a framework, sit our handlers inside it rather than beside it. Do not fight it.
- **Sponsor credits and model access.** Set `OPENAI_MODEL` from whatever the kit provides. Do not hardcode a model name.

Write nothing before 11:00.

---

## Definition of done

By 14:45, a person who has never seen the project can watch two minutes and understand: a request arrived as a plain email, an agent turned it into a checked, scoped, human-approved change, a different human approved it, and the whole chain is reconstructable six months later in artifacts the team already uses.

Everything else is optional.
