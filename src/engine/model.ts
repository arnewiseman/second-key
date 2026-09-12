import OpenAI from "openai";

export type ModelCall = {
  kind: "parse" | "explain";
  instructions: string;
  input: string;
  schema: Record<string, unknown>;
};
export type Complete = (call: ModelCall) => Promise<string>;

/** No tools, grants, cloud calls, implicit model default, or SDK retries. */
export function openAICompletion(options: { model: string; apiKey: string; provider?: "openai" | "deepseek"; fetch?: typeof globalThis.fetch }): Complete {
  if (!options.model.trim() || !options.apiKey.trim()) throw new Error("A model and API key are required for the selected provider");
  const provider = options.provider ?? "openai";
  if (provider !== "openai" && provider !== "deepseek") throw new Error("Unsupported model provider");
  // Fixed origins isolate provider credentials; OPENAI_BASE_URL cannot redirect them.
  const client = new OpenAI({ apiKey: options.apiKey,
    baseURL: provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1",
    maxRetries: 0, timeout: 30_000,
    fetch: (input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" }) });
  return async call => {
    try {
      const response = await client.responses.create({
        model: options.model, instructions: call.instructions, input: call.input,
        store: false, max_output_tokens: call.kind === "parse" ? 16_384 : 2048,
        ...(provider === "deepseek" ? { reasoning: { effort: "none" as const } } : {}),
        text: { format: { type: "json_schema", name: call.kind === "parse" ? "access_request" : "rationale",
          strict: true, schema: call.schema } },
      });
      if (response.status !== "completed" || !response.output_text || response.output.some(item =>
        item.type === "message" && item.content.some(content => content.type === "refusal"))) throw new Error();
      return response.output_text;
    } catch {
      // SDK errors may contain request content or credentials. Never propagate them.
      throw new Error(`Model ${call.kind} failed or returned an incomplete response`);
    }
  };
}

export function completionFromEnv(env: NodeJS.ProcessEnv = process.env, fetch?: typeof globalThis.fetch): Complete {
  const provider = env.MODEL_PROVIDER ?? "openai";
  if (provider !== "openai" && provider !== "deepseek") throw new Error("MODEL_PROVIDER must be openai or deepseek");
  return openAICompletion({ provider,
    model: (provider === "deepseek" ? env.DEEPSEEK_MODEL : env.OPENAI_MODEL) ?? "",
    apiKey: (provider === "deepseek" ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY) ?? "",
    ...(fetch ? { fetch } : {}),
  });
}
