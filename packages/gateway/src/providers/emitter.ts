import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/**
 * Single OpenAI-wire emitter for every provider lane — this is the only
 * place upstream output becomes `chat.completion` / `chat.completion.chunk`.
 * Provider ids never reach the wire: `model` in payloads is the public alias.
 */

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

const toUsage = (u: LanguageModelV4Usage | undefined): TokenUsage | undefined =>
  u
    ? {
        promptTokens: u.inputTokens?.total,
        completionTokens: u.outputTokens?.total,
      }
    : undefined;

const openaiUsage = (u: TokenUsage) => ({
  prompt_tokens: u.promptTokens ?? 0,
  completion_tokens: u.completionTokens ?? 0,
  total_tokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
});

const mapFinish = (raw: { unified: string }): string =>
  (
    {
      stop: "stop",
      length: "length",
      "content-filter": "content_filter",
      "tool-calls": "tool_calls",
    } as Record<string, string>
  )[raw.unified] ?? "stop";

interface EmitOpts {
  /** Public alias — what the client asked for. */
  alias: string;
  id: string;
  created: number;
  /** Client requested usage chunks (stream_options.include_usage). */
  sendUsage: boolean;
  /** Fires once with final usage + finish reason, after the stream ends. */
  onDone?: (info: { usage?: TokenUsage; finishReason?: string }) => void;
}

const chunkLine = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * LanguageModelV4 stream → OpenAI SSE stream. Text, reasoning (as
 * `reasoning_content`, the DeepSeek/OpenRouter convention), complete
 * tool calls, finish_reason, and terminal usage are mapped; provider
 * metadata / structural parts are dropped.
 */
export function streamToOpenAiSse(
  upstream: ReadableStream<LanguageModelV4StreamPart>,
  opts: EmitOpts,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
    encoder.encode(
      chunkLine({
        id: opts.id,
        object: "chat.completion.chunk",
        created: opts.created,
        model: opts.alias,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage !== undefined ? { usage } : {}),
      }),
    );

  let roleSent = false;
  let toolIndex = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Structural parts produce no output — keep consuming until a chunk
      // lands (a pull that enqueues nothing stalls the stream in practice).
      for (;;) {
        const { done, value: part } = await reader.read();
        if (done) {
          opts.onDone?.({});
          controller.close();
          return;
        }
        if (!roleSent) {
          controller.enqueue(chunk({ role: "assistant" }));
          roleSent = true;
        }
        switch (part.type) {
          case "text-delta":
            controller.enqueue(chunk({ content: part.delta }));
            return;
          case "reasoning-delta":
            controller.enqueue(chunk({ reasoning_content: part.delta }));
            return;
          case "tool-call":
            controller.enqueue(
              chunk({
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: part.toolCallId,
                    type: "function",
                    function: {
                      name: part.toolName,
                      arguments:
                        typeof part.input === "string"
                          ? part.input
                          : JSON.stringify(part.input ?? {}),
                    },
                  },
                ],
              }),
            );
            return;
          case "finish": {
            const fr = mapFinish(part.finishReason);
            const usage = opts.sendUsage ? openaiUsage(toUsage(part.usage) ?? {}) : undefined;
            controller.enqueue(chunk({}, fr, usage));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            opts.onDone?.({
              usage: toUsage(part.usage),
              finishReason: fr,
            });
            return;
          }
          case "error":
            controller.enqueue(
              encoder.encode(
                chunkLine({
                  error: {
                    message:
                      part.error instanceof Error
                        ? part.error.message
                        : "upstream stream error",
                    type: "upstream_error",
                  },
                }),
              ),
            );
            opts.onDone?.({});
            return;
          default:
            continue; // structural/metadata parts — not on the wire
        }
      }
    },
    cancel() {
      void reader.cancel();
      opts.onDone?.({});
    },
  });
}

/** LanguageModelV4 generate result → OpenAI `chat.completion` JSON. */
export function generateToOpenAiJson(
  result: LanguageModelV4GenerateResult,
  opts: { alias: string; id: string; created: number },
): { body: Record<string, unknown>; usage?: TokenUsage } {
  let content = "";
  let reasoning = "";
  const toolCalls: Record<string, unknown>[] = [];
  let toolIndex = 0;
  for (const part of result.content) {
    if (part.type === "text") content += part.text;
    else if (part.type === "reasoning") reasoning += part.text;
    else if (part.type === "tool-call") {
      toolCalls.push({
        index: toolIndex++,
        id: part.toolCallId,
        type: "function",
        function: {
          name: part.toolName,
          arguments:
            typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        },
      });
    }
  }
  const usage = toUsage(result.usage);
  return {
    usage,
    body: {
      id: opts.id,
      object: "chat.completion",
      created: opts.created,
      model: opts.alias,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapFinish(result.finishReason),
        },
      ],
      ...(usage ? { usage: openaiUsage(usage) } : {}),
    },
  };
}
