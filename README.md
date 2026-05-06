# Local Pentest LLM DevTools Extension (Firefox)

Firefox DevTools panel that sends prompts to a local Ollama model.

Use only with explicit authorization.

## Load temporarily in Firefox

1. Start Ollama and ensure your model is available:
   - `ollama run gemma3:4b`
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on**.
4. Select `manifest.json` from this folder.
5. Open any site -> DevTools -> **Local LLM** tab.

## Notes

- The extension calls `http://127.0.0.1:11434/api/chat`.
- You can change the model in the panel input.
- Temporary add-ons unload when Firefox restarts; load again from `about:debugging`.
