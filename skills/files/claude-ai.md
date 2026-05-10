# Claude CLI & SDK Testing Reference

Testing AI integrations requires different strategies than traditional code. LLM outputs
are non-deterministic, so tests must assert on **structure, constraints, and tool usage**
rather than exact text.

## What You're Testing

| Component                    | Test approach                                       |
| ---------------------------- | --------------------------------------------------- |
| Your code that calls the SDK | Unit test — mock the Anthropic client               |
| Prompt behavior              | Eval framework (promptfoo, custom harness)          |
| Tool use / function calling  | Assert on tool call names, arguments, and sequences |
| Agent workflows              | Claude Agent SDK eval patterns                      |
| Full pipeline                | Integration test with real API (rate-limit aware)   |

## Unit Testing SDK Wrapper Code

Mock the Anthropic client so tests are fast, free, and deterministic.

### Python (anthropic SDK)

```python
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from myapp.ai import summarize_text

@pytest.fixture
def mock_client():
    client = MagicMock()
    response = MagicMock()
    response.content = [MagicMock(text="This is a summary.")]
    response.usage.input_tokens = 100
    response.usage.output_tokens = 20
    client.messages.create.return_value = response
    return client

def test_summarize_calls_api_with_correct_model(mock_client):
    summarize_text(mock_client, "Long text here...")

    mock_client.messages.create.assert_called_once()
    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == "claude-sonnet-4-6"
    assert call_kwargs["max_tokens"] <= 1024

def test_summarize_includes_system_prompt(mock_client):
    summarize_text(mock_client, "Long text here...")

    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert "summarize" in call_kwargs["system"].lower()

def test_summarize_returns_text(mock_client):
    result = summarize_text(mock_client, "Long text here...")
    assert result == "This is a summary."
```

### TypeScript (@anthropic-ai/sdk)

```typescript
import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { summarizeText } from './ai'

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'This is a summary.' }],
        usage: { input_tokens: 100, output_tokens: 20 }
      })
    }
  }))
}))

describe('[unit] summarizeText', () => {
  it('calls API with correct parameters', async () => {
    const client = new Anthropic()
    await summarizeText(client, 'Long text...')

    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        max_tokens: expect.any(Number)
      })
    )
  })

  it('returns the text response', async () => {
    const client = new Anthropic()
    const result = await summarizeText(client, 'Long text...')
    expect(result).toBe('This is a summary.')
  })
})
```

## Testing Tool Use / Function Calling

When testing that your prompts trigger the right tools:

```python
def test_weather_prompt_triggers_tool_call(mock_client):
    # Set up mock to return a tool_use response
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "get_weather"
    tool_block.input = {"location": "San Francisco"}

    response = MagicMock()
    response.content = [tool_block]
    response.stop_reason = "tool_use"
    mock_client.messages.create.return_value = response

    result = handle_user_message(mock_client, "What's the weather in SF?")

    # Assert tool was called with expected arguments
    assert result["tool_called"] == "get_weather"
    assert result["args"]["location"] == "San Francisco"
```

## Prompt Evaluation with promptfoo

promptfoo is the standard tool for evaluating prompt quality across variations.

```yaml
# promptfoo.yaml
description: 'Summarization prompt evaluation'

providers:
  - id: anthropic:messages:claude-sonnet-4-6
    config:
      max_tokens: 1024

prompts:
  - "Summarize the following text in 2-3 sentences:\n\n{{text}}"

tests:
  - vars:
      text: 'The Federal Reserve announced today that it would hold interest rates steady...'
    assert:
      - type: contains
        value: 'Federal Reserve'
      - type: llm-rubric
        value: 'The summary captures the main point about interest rates'
      - type: javascript
        value: 'output.length < 500' # Not too long

  - vars:
      text: ''
    assert:
      - type: contains
        value: 'cannot summarize' # Handles empty input gracefully

  - vars:
      text: 'Short.'
    assert:
      - type: not-contains
        value: 'ERROR'
```

```bash
npx promptfoo eval
npx promptfoo view   # interactive results viewer
```

## Claude Agent SDK Testing

For agents built on the Claude Agent SDK (formerly Claude Code SDK):

### With promptfoo

```yaml
providers:
  - id: anthropic:claude-agent-sdk
    config:
      working_dir: ./test-project
      append_allowed_tools: ['Read', 'Write', 'Bash']
      permission_mode: 'acceptEdits'

prompts:
  - 'Add input validation to the login function in auth.ts'

tests:
  - assert:
      # Verify the agent used the right tools
      - type: is-valid-tool-call
        value: Read
      - type: is-valid-tool-call
        value: Write
      # Verify the output file contains validation
      - type: javascript
        value: |
          const fs = require('fs');
          const content = fs.readFileSync('./test-project/auth.ts', 'utf8');
          return content.includes('validate') || content.includes('throw');
```

### Testing Skill Invocation

```yaml
providers:
  - id: anthropic:claude-agent-sdk
    config:
      working_dir: ./my-project
      setting_sources: ['project']
      append_allowed_tools: ['Skill', 'Read']

prompts:
  - 'Review the authentication module for security issues'

tests:
  - assert:
      - type: skill-used
        value: code-review # Verify the expected skill was triggered
```

### Managing Side Effects

Agent tests that write files need cleanup:

```bash
# Reset test project before each run
git checkout -- test-project/
# Or use a fresh copy
cp -r test-project-template/ test-project/
```

## Integration Testing (Real API)

For tests that hit the real Anthropic API — use sparingly, they cost money and are slow.

```python
@pytest.mark.integration
@pytest.mark.skipif(not os.getenv("ANTHROPIC_API_KEY"), reason="No API key")
def test_real_api_responds():
    client = Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=100,
        messages=[{"role": "user", "content": "Say 'hello' and nothing else."}],
    )
    assert len(response.content) > 0
    assert response.content[0].type == "text"
    assert "hello" in response.content[0].text.lower()
```

**Rate limiting:** add delays between tests, use a dedicated test API key with
its own rate limits, and run these tests in CI only (not on every commit).

## Testing Streaming Responses

```python
def test_streaming_collects_all_chunks(mock_client):
    chunks = [
        MagicMock(type="content_block_delta",
                  delta=MagicMock(type="text_delta", text="Hello")),
        MagicMock(type="content_block_delta",
                  delta=MagicMock(type="text_delta", text=" World")),
        MagicMock(type="message_stop"),
    ]
    mock_client.messages.stream.return_value.__enter__ = MagicMock(
        return_value=iter(chunks)
    )

    result = stream_response(mock_client, "Say hello")
    assert result == "Hello World"
```

## Key Principles for AI Testing

1. **Never assert on exact text** — LLM outputs vary. Assert on structure (JSON shape,
   tool calls, length constraints) and semantic meaning (via LLM-as-judge or keywords).
2. **Mock the client for unit tests** — fast, free, deterministic. Test your code, not
   the model.
3. **Use promptfoo for prompt quality** — it handles variation, rubric grading, and
   regression detection across prompt versions.
4. **Test tool calling contracts** — verify the right tools are called with the right
   arguments. This is deterministic and testable.
5. **Budget real API tests** — run integration tests against the real API only in CI,
   with a cost cap and rate-limit awareness.
6. **Version your prompts** — treat system prompts like code. Test before and after
   changes with the same eval suite.
