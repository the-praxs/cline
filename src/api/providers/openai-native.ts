import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { withRetry } from "../retry"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openAiNativeDefaultModelId, OpenAiNativeModelId, openAiNativeModels } from "@shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { calculateApiCostOpenAI } from "../../utils/cost"
import { ApiStream } from "../transform/stream"
import type { ChatCompletionReasoningEffort } from "openai/resources/chat/completions"

export class OpenAiNativeHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			apiKey: this.options.openAiNativeApiKey,
		})
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		const inputTokens = usage?.prompt_tokens || 0 // sum of cache hits and misses
		const outputTokens = usage?.completion_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0
		const cacheWriteTokens = 0
		const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
		const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
		yield {
			type: "usage",
			inputTokens: nonCachedInputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}
	}

	private async *yieldResponsesUsage(info: ModelInfo, usage: any): ApiStream {
		const inputTokens = usage?.input_tokens || 0
		const outputTokens = usage?.output_tokens || 0
		const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens || 0
		const cacheReadTokens = usage?.input_tokens_details?.cached_tokens || 0
		const cacheWriteTokens = 0

		// For responses API, reasoning tokens are included in output tokens but billed separately
		const actualOutputTokens = outputTokens - reasoningTokens
		const totalCost = calculateApiCostOpenAI(info, inputTokens, actualOutputTokens, cacheWriteTokens, cacheReadTokens)
		const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)

		yield {
			type: "usage",
			inputTokens: nonCachedInputTokens,
			outputTokens: actualOutputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			totalCost: totalCost,
		}

		// Provide detailed reasoning token information for o3-pro
		if (reasoningTokens > 0) {
			yield {
				type: "text",
				text: `\n📊 **Token Usage Breakdown:**\n- Input tokens: ${inputTokens.toLocaleString()}\n- Output tokens: ${actualOutputTokens.toLocaleString()}\n- Reasoning tokens: ${reasoningTokens.toLocaleString()}\n- Cache hits: ${cacheReadTokens.toLocaleString()}\n- Total cost: $${totalCost?.toFixed(4) || "N/A"}\n\n💡 *Reasoning tokens show the computational effort used for advanced problem-solving*\n`,
			}
		}
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = this.getModel()

		switch (model.id) {
			case "o3-pro": {
				// o3-pro uses the Responses API, not Chat Completions API
				try {
					// Yield initial progress indication
					yield {
						type: "text",
						text: "🧠 Initializing o3-pro advanced reasoning (this may take several minutes)...\n\n",
					}

					// Convert to Responses API format
					// For simple cases, we'll combine the system prompt and messages into instructions + input
					const lastMessage = messages[messages.length - 1]
					const lastMessageContent = lastMessage?.content
					
					let input: string
					if (typeof lastMessageContent === "string") {
						input = lastMessageContent
					} else if (Array.isArray(lastMessageContent)) {
						// Handle complex content (images, etc.)
						input = lastMessageContent
							.filter(item => item.type === "text")
							.map(item => item.text)
							.join(" ")
					} else {
						input = "Please help me with this request."
					}

					// Yield progress update
					yield {
						type: "text", 
						text: `⚙️ Processing with ${this.options.reasoningEffort || "medium"} reasoning effort...\n\n`,
					}

					const requestOptions: any = {
						model: model.id,
						instructions: systemPrompt,
						input: input,
						reasoning: {
							effort: this.options.reasoningEffort || "medium"
						},
						store: false // Don't store for now
					}

					const response = await this.client.responses.create(requestOptions)

					// Yield completion notification
					yield {
						type: "text",
						text: "✅ Reasoning complete! Processing response...\n\n",
					}

					// Process the response
					if (response.output_text) {
						yield {
							type: "text",
							text: response.output_text,
						}
					}

					// Yield usage information if available
					if (response.usage) {
						yield* this.yieldResponsesUsage(model.info, response.usage)
					}

				} catch (error) {
					yield {
						type: "text",
						text: `❌ Error with o3-pro reasoning: ${error instanceof Error ? error.message : String(error)}\n`,
					}
					throw error
				}
				return
			}
			case "o1":
			case "o1-preview":
			case "o1-mini": {
				// o1 doesn't support streaming, non-1 temp, or system prompt
				const response = await this.client.chat.completions.create({
					model: model.id,
					messages: [{ role: "user", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
				})
				yield {
					type: "text",
					text: response.choices[0]?.message.content || "",
				}

				yield* this.yieldUsage(model.info, response.usage)

				break
			}
			case "o4-mini":
			case "o3":
			case "o3-mini": {
				const stream = await this.client.chat.completions.create({
					model: model.id,
					messages: [{ role: "developer", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
					stream: true,
					stream_options: { include_usage: true },
					reasoning_effort: (this.options.reasoningEffort as ChatCompletionReasoningEffort) || "medium",
				})

				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta
					if (delta?.content) {
						yield {
							type: "text",
							text: delta.content,
						}
					}
					if (chunk.usage) {
						// Only last chunk contains usage
						yield* this.yieldUsage(model.info, chunk.usage)
					}
				}
				break
			}
			default: {
				// For all other models, use Chat Completions API
				const openAiMessages: any[] = [
					{ role: "user", content: systemPrompt },
					...convertToOpenAiMessages(messages)
				]

				const createParams: any = {
					model: model.id,
					messages: openAiMessages,
					temperature: 0,
					max_tokens: model.info.maxTokens,
					stream: true,
					stream_options: { include_usage: true },
				}

				if (this.options.reasoningEffort && model.id.includes("o3")) {
					createParams.reasoning_effort = this.options.reasoningEffort
				}

				const stream = await this.client.chat.completions.create(createParams) as any

				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta
					if (delta?.content) {
						yield {
							type: "text",
							text: delta.content,
						}
					}
					if (chunk.usage) {
						// Only last chunk contains usage
						yield* this.yieldUsage(model.info, chunk.usage)
					}
				}
			}
		}
	}

	getModel(): { id: OpenAiNativeModelId; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in openAiNativeModels) {
			const id = modelId as OpenAiNativeModelId
			return { id, info: openAiNativeModels[id] }
		}
		return {
			id: openAiNativeDefaultModelId,
			info: openAiNativeModels[openAiNativeDefaultModelId],
		}
	}
}
