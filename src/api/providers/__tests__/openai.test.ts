import { describe, it, beforeEach, afterEach } from "mocha"
import "should"
import sinon from "sinon"
import { Anthropic } from "@anthropic-ai/sdk"
import { OpenAiHandler } from "../openai"
import { ApiHandlerOptions } from "@shared/api"
import OpenAI from "openai"

describe("OpenAiHandler", () => {
	let handler: OpenAiHandler
	let options: ApiHandlerOptions
	let mockClient: sinon.SinonStubbedInstance<OpenAI>

	beforeEach(() => {
		options = {
			openAiApiKey: "test-api-key",
			openAiModelId: "gpt-4",
		}
		handler = new OpenAiHandler(options)

		// Mock the OpenAI client
		mockClient = sinon.createStubInstance(OpenAI)
		handler["client"] = mockClient as any
	})

	afterEach(() => {
		sinon.restore()
	})

	describe("o3-pro model handling", () => {
		beforeEach(() => {
			options.openAiModelId = "o3-pro"
			options.reasoningEffort = "high"
			handler = new OpenAiHandler(options)
			handler["client"] = mockClient as any
		})

		it("should identify o3-pro as a reasoning model", async () => {
			const mockStream = {
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Test response" } }],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 50,
							prompt_tokens_details: { cached_tokens: 10 },
							prompt_cache_miss_tokens: 5,
						},
					}
				},
			}

			mockClient.chat = {
				completions: {
					create: sinon.stub().resolves(mockStream),
				},
			} as any

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const results = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				results.push(chunk)
			}

			// Verify that the create method was called with correct parameters for reasoning model
			const createCall = (mockClient.chat.completions.create as sinon.SinonStub).getCall(0)
			const callArgs = createCall.args[0]

			// Should use developer role instead of system role
			callArgs.messages[0].should.have.property("role", "developer")
			callArgs.messages[0].should.have.property("content", systemPrompt)

			// Should not have temperature for reasoning models
			callArgs.should.not.have.property("temperature")

			// Should have reasoning_effort parameter
			callArgs.should.have.property("reasoning_effort", "high")

			// Should have correct model
			callArgs.should.have.property("model", "o3-pro")
		})

		it("should handle reasoning content in o3-pro responses", async () => {
			const mockStream = {
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { reasoning_content: "Let me think about this..." } }],
					}
					yield {
						choices: [{ delta: { content: "Final answer" } }],
					}
					yield {
						usage: {
							prompt_tokens: 100,
							completion_tokens: 50,
						},
					}
				},
			}

			mockClient.chat = {
				completions: {
					create: sinon.stub().resolves(mockStream),
				},
			} as any

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Solve this complex problem" }]

			const results = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				results.push(chunk)
			}

			// Should have both reasoning and text content
			const reasoningChunks = results.filter((r) => r.type === "reasoning")
			const textChunks = results.filter((r) => r.type === "text")
			const usageChunks = results.filter((r) => r.type === "usage")

			reasoningChunks.should.have.length(1)
			reasoningChunks[0].should.have.property("reasoning", "Let me think about this...")

			textChunks.should.have.length(1)
			textChunks[0].should.have.property("text", "Final answer")

			usageChunks.should.have.length(1)
		})

		it("should default to medium reasoning effort if not specified", async () => {
			// Reset options without explicit reasoning effort
			options.openAiModelId = "o3-pro"
			delete options.reasoningEffort
			handler = new OpenAiHandler(options)
			handler["client"] = mockClient as any

			const mockStream = {
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Test" } }],
					}
				},
			}

			mockClient.chat = {
				completions: {
					create: sinon.stub().resolves(mockStream),
				},
			} as any

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const results = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				results.push(chunk)
			}

			const createCall = (mockClient.chat.completions.create as sinon.SinonStub).getCall(0)
			const callArgs = createCall.args[0]

			// Should default to medium reasoning effort
			callArgs.should.have.property("reasoning_effort", "medium")
		})
	})

	describe("regular model handling", () => {
		it("should handle non-reasoning models normally", async () => {
			const mockStream = {
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{ delta: { content: "Regular response" } }],
						usage: {
							prompt_tokens: 50,
							completion_tokens: 25,
						},
					}
				},
			}

			mockClient.chat = {
				completions: {
					create: sinon.stub().resolves(mockStream),
				},
			} as any

			const systemPrompt = "You are a helpful assistant."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			const results = []
			for await (const chunk of handler.createMessage(systemPrompt, messages)) {
				results.push(chunk)
			}

			const createCall = (mockClient.chat.completions.create as sinon.SinonStub).getCall(0)
			const callArgs = createCall.args[0]

			// Should use system role for regular models
			callArgs.messages[0].should.have.property("role", "system")

			// Should have temperature for regular models
			callArgs.should.have.property("temperature")

			// Should not have reasoning_effort parameter
			callArgs.should.not.have.property("reasoning_effort")
		})
	})

	describe("getModel", () => {
		it("should return correct model information for o3-pro", () => {
			options.openAiModelId = "o3-pro"
			options.openAiModelInfo = {
				maxTokens: 100_000,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 20.0,
				outputPrice: 80.0,
			}
			handler = new OpenAiHandler(options)

			const model = handler.getModel()

			model.should.have.property("id", "o3-pro")
			model.info.should.have.property("inputPrice", 20.0)
			model.info.should.have.property("outputPrice", 80.0)
			model.info.should.have.property("maxTokens", 100_000)
		})
	})
})
