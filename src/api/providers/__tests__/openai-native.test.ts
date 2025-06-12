import { describe, it, beforeEach, afterEach } from "mocha"
import "should"
import sinon from "sinon"
import { OpenAiNativeHandler } from "../openai-native"
import { ApiHandlerOptions } from "@shared/api"
import OpenAI from "openai"

describe("OpenAiNativeHandler", () => {
	let handler: OpenAiNativeHandler
	let options: ApiHandlerOptions
	let mockClient: sinon.SinonStubbedInstance<OpenAI>

	beforeEach(() => {
		options = {
			openAiNativeApiKey: "test-api-key",
			apiModelId: "o3-pro",
			reasoningEffort: "medium",
		}
		handler = new OpenAiNativeHandler(options)
		
		// Mock the OpenAI client
		mockClient = sinon.createStubInstance(OpenAI)
		;(handler as any).client = mockClient
	})

	afterEach(() => {
		sinon.restore()
	})

	describe("o3-pro model handling", () => {
		it("should use Responses API for o3-pro model", async () => {
			// Mock the responses.create method
			const mockResponse = {
				output_text: "This is the reasoning response from o3-pro",
				usage: {
					input_tokens: 100,
					output_tokens: 200,
					output_tokens_details: {
						reasoning_tokens: 50
					}
				}
			}
			
			mockClient.responses = {
				create: sinon.stub().resolves(mockResponse)
			} as any

			const systemPrompt = "You are a helpful assistant"
			const messages = [
				{
					role: "user" as const,
					content: "Solve this complex problem: What is 2+2?"
				}
			]

			const generator = handler.createMessage(systemPrompt, messages)
			const results = []
			
			for await (const chunk of generator) {
				results.push(chunk)
			}

			// Verify Responses API was called
			sinon.assert.calledOnce(mockClient.responses.create as sinon.SinonStub)
			
			// Check the call parameters
			const callArgs = (mockClient.responses.create as sinon.SinonStub).getCall(0).args[0]
			callArgs.should.have.property("model", "o3-pro")
			callArgs.should.have.property("instructions", systemPrompt)
			callArgs.should.have.property("input", "Solve this complex problem: What is 2+2?")
			callArgs.should.have.property("reasoning")
			callArgs.reasoning.should.have.property("effort", "medium")

			// Verify response chunks
			const textChunks = results.filter(chunk => chunk.type === "text")
			const usageChunks = results.filter(chunk => chunk.type === "usage")
			
			textChunks.length.should.be.above(0)
			usageChunks.length.should.be.above(0)
			
			// Check that reasoning response is included
			const responseContent = textChunks.find(chunk => 
				chunk.text && chunk.text.includes("This is the reasoning response from o3-pro")
			)
			responseContent!.should.not.be.undefined()
		})

		it("should handle Responses API errors gracefully", async () => {
			// Mock an error response
			const error = new Error("API quota exceeded")
			mockClient.responses = {
				create: sinon.stub().rejects(error)
			} as any

			const systemPrompt = "You are a helpful assistant"
			const messages = [
				{
					role: "user" as const,
					content: "Test question"
				}
			]

			try {
				const generator = handler.createMessage(systemPrompt, messages)
				const results = []
				
				for await (const chunk of generator) {
					results.push(chunk)
				}
				
				// Should not reach here
				throw new Error("Expected error was not thrown")
			} catch (thrownError) {
				thrownError.should.equal(error)
			}
		})

		it("should properly format reasoning effort parameter", async () => {
			const mockResponse = {
				output_text: "Response with high reasoning effort",
				usage: { input_tokens: 50, output_tokens: 100 }
			}
			
			mockClient.responses = {
				create: sinon.stub().resolves(mockResponse)
			} as any

			// Test with high reasoning effort
			const highEffortOptions = { ...options, reasoningEffort: "high" }
			const highEffortHandler = new OpenAiNativeHandler(highEffortOptions)
			;(highEffortHandler as any).client = mockClient

			const systemPrompt = "Analyze this complex problem"
			const messages = [{ role: "user" as const, content: "Complex question" }]

			const generator = highEffortHandler.createMessage(systemPrompt, messages)
			const results = []
			
			for await (const chunk of generator) {
				results.push(chunk)
			}

			const callArgs = (mockClient.responses.create as sinon.SinonStub).getCall(0).args[0]
			callArgs.reasoning.should.have.property("effort", "high")
		})
	})

	describe("regular model handling", () => {
		it("should use Chat Completions API for non-o3-pro models", async () => {
			// Test with gpt-4o
			const regularOptions = { ...options, apiModelId: "gpt-4o" }
			const regularHandler = new OpenAiNativeHandler(regularOptions)
			
			// Mock the chat completions streaming response
			const mockStream = {
				[Symbol.asyncIterator]: async function* () {
					yield {
						choices: [{
							delta: { content: "Hello" }
						}]
					}
					yield {
						choices: [{
							delta: { content: " world!" }
						}],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 20
						}
					}
				}
			}
			
			mockClient.chat = {
				completions: {
					create: sinon.stub().resolves(mockStream)
				}
			} as any
			
			;(regularHandler as any).client = mockClient

			const systemPrompt = "You are helpful"
			const messages = [{ role: "user" as const, content: "Say hello" }]

			const generator = regularHandler.createMessage(systemPrompt, messages)
			const results = []
			
			for await (const chunk of generator) {
				results.push(chunk)
			}

			// Verify Chat Completions API was called
			sinon.assert.calledOnce(mockClient.chat.completions.create as sinon.SinonStub)
			
			// Check response content
			const textChunks = results.filter(chunk => chunk.type === "text")
			textChunks.should.have.length(2)
			textChunks[0].text.should.equal("Hello")
			textChunks[1].text.should.equal(" world!")
		})
	})

	describe("model configuration", () => {
		it("should correctly identify o3-pro model info", () => {
			const model = handler.getModel()
			model.id.should.equal("o3-pro")
			model.info.should.have.property("maxTokens", 100_000)
			model.info.should.have.property("contextWindow", 200_000)
			model.info.should.have.property("inputPrice", 20.0)
			model.info.should.have.property("outputPrice", 80.0)
			model.info.should.have.property("supportsImages", true)
		})

		it("should default to supported model when apiModelId is not specified", () => {
			const defaultOptions = { openAiNativeApiKey: "test-key" }
			const defaultHandler = new OpenAiNativeHandler(defaultOptions)
			
			const model = defaultHandler.getModel()
			model.id.should.equal("gpt-4o")  // Default model
		})
	})
})