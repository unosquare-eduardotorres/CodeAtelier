# .NET AI Integration

Technology selection decision tree and integration patterns for adding AI/ML capabilities to .NET applications.

## When to use

- Adding AI/ML features to a .NET application
- Choosing between LLM vs classical ML for a task
- Integrating with Azure OpenAI, local models, or ONNX
- Implementing RAG, agentic workflows, or vector search

## When NOT to use

- Non-.NET projects
- Pure prompt engineering without code
- General .NET architecture (use main SKILL.md)

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Task description | Yes | What the AI feature should do |
| Data characteristics | No | Structured/unstructured, volume, real-time vs batch |
| Deployment constraints | No | Cloud, on-prem, edge, offline |
| Latency requirements | No | Real-time vs batch tolerance |

## Workflow

### Step 1: Classify the task type

| Task type | Characteristics |
|-----------|----------------|
| Structured data (classification, regression, forecasting) | Tabular data, known features, deterministic output |
| Text generation / chat | Natural language input/output, creative or summarization |
| Multi-step reasoning / tool use | Requires planning, API calls, iterative refinement |
| Autonomous agents | Long-running, self-directed, tool orchestration |
| Custom model inference | Pre-trained model file, low-latency inference |
| Similarity search / RAG | Embedding comparison, document retrieval |

### Step 2: Select technology using the decision tree

#### Library layer selection

| Layer | Purpose | When to use |
|-------|---------|-------------|
| **Abstraction** (`Microsoft.Extensions.AI`) | Provider-agnostic AI interfaces | Default starting point for LLM integration |
| **Provider** (Azure.AI.OpenAI, OllamaSharp) | Direct provider access | Need provider-specific features |
| **Orchestration** (Semantic Kernel) | Multi-step, tool use, planners | Complex workflows with function calling |
| **Copilot** (Microsoft Agent Framework) | Autonomous multi-agent systems | Self-directed agents with iteration |

**Start at the lowest layer that meets your needs.** Don't use Semantic Kernel for a single chat call.

#### Technology selection

| Task | Data | Latency | Technology | Package |
|------|------|---------|------------|---------|
| Classification / regression | Structured, tabular | Batch OK | ML.NET | `Microsoft.ML` |
| Text generation, chat | Unstructured | Real-time | Microsoft.Extensions.AI | `Microsoft.Extensions.AI` |
| Multi-step reasoning, tool use | Mixed | Varies | Semantic Kernel | `Microsoft.SemanticKernel` |
| Autonomous agents | Mixed | Async OK | Microsoft Agent Framework | `Microsoft.Agents.AI` |
| Custom model inference | Model file | Low latency | ONNX Runtime | `Microsoft.ML.OnnxRuntime` |
| Offline / local LLM | Any | Varies | OllamaSharp | `OllamaSharp` |
| Similarity search / RAG | Embeddings | Real-time | MEVD | `Microsoft.Extensions.VectorData.Abstractions` |

**Critical rule:** Never use an LLM for tasks ML.NET handles well. LLMs are slower, more expensive, and non-deterministic for structured data tasks.

### Step 3: Set up DI registration

**Microsoft.Extensions.AI (LLM chat):**

```csharp
services.AddChatClient(builder => builder
    .UseOpenTelemetry()
    .UseDistributedCache()
    .Use(new AzureOpenAIClient(new Uri(endpoint), new ApiKeyCredential(key))
        .AsChatClient("gpt-4o-2024-08-06")));
```

**Semantic Kernel (orchestration):**

```csharp
var kernelBuilder = services.AddKernel();
kernelBuilder.AddAzureOpenAIChatCompletion(
    deploymentName: "gpt-4o-2024-08-06",
    endpoint: configuration["AzureOpenAI:Endpoint"]!,
    apiKey: configuration["AzureOpenAI:ApiKey"]!);
kernelBuilder.Plugins.AddFromType<OrderPlugin>();
```

**ML.NET (classical ML):**

```csharp
services.AddPredictionEnginePool<ModelInput, ModelOutput>()
    .FromFile(modelName: "SentimentModel", filePath: "model.zip", watchForChanges: true);
```

**OllamaSharp (local LLM):**

```csharp
services.AddSingleton<IOllamaApiClient>(new OllamaApiClient(new Uri("http://localhost:11434")));
```

### Step 4: Implement with guardrails

#### Temperature settings by use case

| Use case | Temperature | Reason |
|----------|-------------|--------|
| Classification, extraction | 0 | Deterministic output |
| Summarization | 0.3 | Slight variation acceptable |
| Creative writing, brainstorming | 0.7-1.0 | Diversity desired |

#### Retry and resilience

```csharp
services.AddHttpClient<IAIService>()
    .AddStandardResilienceHandler(options =>
    {
        options.Retry.MaxRetryAttempts = 3;
        options.Retry.BackoffType = DelayBackoffType.Exponential;
        options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(30);
    });
```

#### Agentic loop safety

```csharp
var settings = new OpenAIPromptExecutionSettings
{
    ToolCallBehavior = ToolCallBehavior.AutoInvokeKernelFunctions,
    MaximumAutoInvokeAttempts = 10  // ALWAYS set a cap
};
```

#### Key management

| Environment | Method |
|-------------|--------|
| Development | `dotnet user-secrets` |
| Production | Azure Key Vault / AWS Secrets Manager |
| CI/CD | Environment variables (secret store) |

**Never hardcode API keys.** Not in `appsettings.json`, not in source code, not in environment files committed to source control.

### Step 5: Add observability

```csharp
// OpenTelemetry for AI calls
services.AddOpenTelemetry()
    .WithTracing(builder => builder
        .AddSource("Microsoft.Extensions.AI")
        .AddSource("Microsoft.SemanticKernel"));

// Token counting and cost tracking
services.AddChatClient(builder => builder
    .UseOpenTelemetry()
    .Use(async (messages, options, next, ct) =>
    {
        var response = await next(messages, options, ct);
        logger.LogInformation("Tokens used: {Tokens}", response.Usage?.TotalTokenCount);
        return response;
    }));
```

## Classic ML guardrails (ML.NET)

| Rule | Why |
|------|-----|
| Set random seed for reproducibility | `mlContext = new MLContext(seed: 42)` |
| Split data 80/20 (train/test) | Prevents overfitting evaluation |
| Use `PredictionEnginePool` | `PredictionEngine` is NOT thread-safe |
| Validate schema before training | Catch column mismatches early |

## RAG guardrails

| Rule | Implementation |
|------|----------------|
| Cache embeddings | Don't re-embed unchanged documents |
| Set relevance threshold | Filter results below similarity score (e.g., 0.7) |
| Include source attribution | Always return which document chunks were used |
| Chunk strategically | 512-1024 tokens per chunk with overlap |

## Anti-patterns to reject

| Anti-pattern | Redirect |
|--------------|----------|
| Using LLM for tabular classification | Use ML.NET |
| `new HttpClient()` for AI API calls | Use `IHttpClientFactory` with resilience |
| Hardcoded API keys | Use Key Vault / user-secrets |
| No iteration cap on agentic loops | Set `MaximumAutoInvokeAttempts` |
| Embedding on every request | Cache embeddings, invalidate on change |
| No retry on AI API calls | Add `StandardResilienceHandler` |
| Using full Semantic Kernel for simple chat | Use `Microsoft.Extensions.AI` |
| No model version pinning | Pin: `gpt-4o-2024-08-06`, not `gpt-4o` |

## Validation checklist

- [ ] AI services registered via DI (not `new`'d directly)
- [ ] Temperature set explicitly for the use case
- [ ] Retry with exponential backoff configured
- [ ] Agentic loops capped with `MaximumIterations`
- [ ] Model version pinned (not using `latest`)
- [ ] No hardcoded API keys anywhere in source
- [ ] OpenTelemetry tracing enabled for AI calls
- [ ] Cost tracking / token counting in place

## Common pitfalls

| Pitfall | Solution |
|---------|----------|
| Using LLM for structured data tasks | ML.NET is faster, cheaper, deterministic |
| Not capping agentic loops | Always set `MaximumAutoInvokeAttempts` |
| Hardcoded API keys | Use Key Vault, user-secrets, or env vars |
| Missing retry logic on AI calls | Network failures are common — always retry |
| Not pinning model versions | Models change behavior — pin specific versions |
| Using Semantic Kernel for simple chat | Overkill — use Microsoft.Extensions.AI |
| PredictionEngine in singleton | Not thread-safe — use PredictionEnginePool |
| No content filtering | Add safety layer for user-facing AI features |
