---
"claude-dev": minor
---

Add OpenAI o3-pro model support with Responses API integration

- Added o3-pro model to OpenAI Native provider with correct pricing ($20/M input, $80/M output tokens)
- Implemented Responses API support alongside existing Chat Completions API
- Added comprehensive ApiStream integration with progress indicators for long reasoning sessions
- Included reasoning effort parameter support (low/medium/high) for optimal performance tuning
- Added detailed usage analytics including reasoning token tracking and cost breakdown
- Enhanced error handling and graceful fallbacks for API failures
- Updated OpenAI SDK to v5.3.0 for Responses API compatibility
- Added comprehensive test coverage for all o3-pro functionality
- Maintained backward compatibility with existing OpenAI models and providers

This enables users to leverage OpenAI's most advanced reasoning model for complex problem-solving tasks requiring deep computational thinking, with full integration into Cline's existing workflow and user interface.