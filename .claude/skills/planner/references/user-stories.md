# User Story Writing Patterns

## INVEST Criteria

Every user story should satisfy INVEST:

| Criterion       | Description                              | Test                              |
| --------------- | ---------------------------------------- | --------------------------------- |
| **I**ndependent | Can be developed without other stories   | No blocking dependencies          |
| **N**egotiable  | Details can be discussed, not a contract | Conversation, not specification   |
| **V**aluable    | Delivers value to a stakeholder          | "So that..." clause is meaningful |
| **E**stimable   | Team can estimate effort                 | Not too vague, not too large      |
| **S**mall       | Fits in one sprint/iteration             | Max 4h implementation time        |
| **T**estable    | Has clear acceptance criteria            | Can write automated tests         |

## Story Format

```
As a [role/persona],
I want [capability/action],
So that [business value/benefit].
```

### Good Examples

```
As a developer using Agent Studio,
I want to see which specialist agent is handling my task,
So that I can provide relevant context if the agent asks follow-up questions.
```

```
As a team lead,
I want to export conversation history as markdown,
So that I can share architectural decisions with team members who don't use Agent Studio.
```

### Anti-Patterns

- **No value**: "As a user, I want a button, so that I can click it" — WHY do they click it?
- **Too large**: "As a user, I want authentication" — break into sign-up, login, password reset, etc.
- **Solution-driven**: "As a user, I want a Redis cache" — describe the NEED (fast responses), not the solution
- **Missing role**: "The system should validate input" — WHO benefits? What kind of input?

## Story Splitting Techniques

1. **By workflow step**: Sign up → Verify email → Set profile → Onboard
2. **By data variation**: Text messages → File attachments → Code snippets → Images
3. **By business rule**: Free tier → Pro tier → Enterprise tier
4. **By interface**: Desktop → Mobile → API
5. **By operation**: Create → Read → Update → Delete
6. **By performance**: Works → Works fast → Works under load
