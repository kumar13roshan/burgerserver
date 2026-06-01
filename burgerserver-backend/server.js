import { GoogleGenerativeAI } from '@google/generative-ai';

// Determine environment & load environment variables
const isBun = typeof globalThis.Bun !== 'undefined';
let PORT;

if (isBun) {
  PORT = Bun.env.PORT || 3002;
} else {
  // If running in Node, dynamically import dotenv
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  PORT = process.env.PORT || 3002;
}

// Define structured JSON schema for Gemini response
const responseSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The relative file path, e.g., "src/index.js", "style.css", "index.html"'
          },
          content: {
            type: 'string',
            description: 'The full, beautifully formatted, multi-line source code content for this file. Must contain actual newline characters (\\n) and proper indentation. Do NOT return the code as a single line or minified.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  required: ['files']
};

// Helper function to dynamically load all configured Gemini API keys
function getApiKeys() {
  const keys = [];

  const addKeyIfValid = (key) => {
    if (key) {
      const trimmed = key.trim();
      // Skip empty keys or placeholder values
      if (trimmed && !trimmed.startsWith('YOUR_') && !trimmed.includes('placeholder')) {
        keys.push(trimmed);
      }
    }
  };

  const getEnvVar = (name) => {
    return isBun ? Bun.env[name] : process.env[name];
  };

  // 1. Check standard GEMINI_API_KEY (handles comma-separated string too)
  const primaryKey = getEnvVar('GEMINI_API_KEY');
  if (primaryKey) {
    if (primaryKey.includes(',')) {
      primaryKey.split(',').forEach(addKeyIfValid);
    } else {
      addKeyIfValid(primaryKey);
    }
  }

  // 2. Check for multiple indexed keys (e.g., GEMINI_API_KEY_2, GEMINI_API_KEY_3, etc.)
  let index = 2;
  while (true) {
    const key = getEnvVar(`GEMINI_API_KEY_${index}`);
    if (key) {
      addKeyIfValid(key);
      index++;
    } else {
      break;
    }
  }

  return keys;
}

// Verify that at least one API key is present at startup
const configuredKeys = getApiKeys();
if (configuredKeys.length === 0) {
  console.error('❌ Error: No Gemini API keys are defined in the environment (e.g., GEMINI_API_KEY)!');
  process.exit(1);
} else {
  console.log(`🍔 ${isBun ? 'BurgerServer' : 'BurgerServer (Node-fallback)'} initialized with ${configuredKeys.length} API Key(s) in rotation.`);
}

// Robust JSON parser and extractor for model responses
function cleanAndParseJson(text) {
  if (!text) {
    throw new Error('Received empty text from Gemini API');
  }

  let cleanText = text.trim();

  // Strip Markdown code blocks if present
  if (cleanText.startsWith('```')) {
    // Matches ```json <content> ``` or ``` <content> ```
    const match = cleanText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (match && match[1]) {
      cleanText = match[1].trim();
    }
  }

  try {
    return JSON.parse(cleanText);
  } catch (err) {
    // Try to find any JSON substring in case of pre/post text wrapping
    const startIdx = cleanText.indexOf('{');
    const endIdx = cleanText.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const candidate = cleanText.substring(startIdx, endIdx + 1);
      try {
        return JSON.parse(candidate);
      } catch (innerErr) {
        throw new Error(`JSON parsing failed: ${err.message}. Raw: ${text.substring(0, 100)}...`);
      }
    }
    throw new Error(`JSON parsing failed: ${err.message}. Raw: ${text.substring(0, 100)}...`);
  }
}

// Check if error is key-specific (invalid key, rate limit, quota exceeded)
function isKeyExhaustedOrInvalid(errorMessage) {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('limit') ||
    msg.includes('429') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('api key is invalid')
  );
}

// Scaffolding Core Function (reusable between Bun.serve and Express)
async function generateScaffolding(prompt) {
  const keys = getApiKeys();
  if (keys.length === 0) {
    throw new Error('No Gemini API keys are configured on the server.');
  }

  // Handle extremely large prompts: check length and sanitize
  if (prompt.length > 50000) {
    console.warn(`⚠️ Warning: Prompt length is very large (${prompt.length} chars).`);
  }

  const startIndex = Math.floor(Math.random() * keys.length);
  let lastError = null;

  for (let i = 0; i < keys.length; i++) {
    const currentKeyIndex = (startIndex + i) % keys.length;
    const currentKey = keys[currentKeyIndex];

    const maskedKey = currentKey.length > 12
      ? `${currentKey.substring(0, 8)}...${currentKey.substring(currentKey.length - 4)}`
      : '***';

    console.log(`🔑 Trying API Key ${currentKeyIndex + 1}/${keys.length} (${maskedKey})`);

    const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
    let skipKey = false;

    for (const modelName of modelsToTry) {
      if (skipKey) break;

      try {
        console.log(`🤖 Trying model ${modelName} with Key ${currentKeyIndex + 1}...`);
        
        // Setup AbortController for a 90-second timeout on model generation to avoid gateway timeouts
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);

        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: 'You are a professional software scaffolding assistant. Based on the user\'s prompt, generate a fully functional, high-quality codebase structure. Return the relative paths and contents for all necessary files in the project. To prevent gateway timeouts, write clean, highly concise, and modular code. Avoid bloated comments, redundant code, or excessively large boilerplate files. Focus on the core functionality so that the response generates quickly and stays within size limits. The content of each file MUST be formatted beautifully with standard multi-line formatting, proper indentation, and actual newline characters (\\n) between statements. Under no circumstances should the code for a file be minified or squashed onto a single line. Strictly adhere to the requested JSON response schema.'
        });

        // Wrap call in a timeout promise
        const generationPromise = model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
          }
        });

        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Gemini API call timed out after 90 seconds')), 90000);
        });

        const result = await Promise.race([generationPromise, timeoutPromise]);
        clearTimeout(timeoutId);

        // Check if blocked by safety filters
        if (result.response.promptFeedback?.blockReason) {
          throw new Error(`Prompt blocked by Gemini Safety Filter: ${result.response.promptFeedback.blockReason}`);
        }

        const text = result.response.text();
        const data = cleanAndParseJson(text);

        console.log(`✅ Successfully generated ${data.files ? data.files.length : 0} files using Key ${currentKeyIndex + 1} and model ${modelName}.`);
        return data;

      } catch (error) {
        const errMsg = error.message || error.toString();
        console.error(`⚠️ Model ${modelName} failed with Key ${currentKeyIndex + 1}:`, errMsg);
        lastError = error;

        // If the API Key itself is invalid, exhausted, or has quota issues, skip trying other models with this key!
        if (isKeyExhaustedOrInvalid(errMsg)) {
          console.warn(`🛑 Key ${currentKeyIndex + 1} is invalid, exhausted, or rate-limited. Skipping other models for this key.`);
          skipKey = true;
        }
      }
    }
  }

  throw new Error('All configured Gemini API keys failed. Last error: ' + (lastError ? lastError.message : 'Unknown error'));
}

// HTML page content
const welcomeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🍔 BurgerServer is Live!</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #1e1e3f, #0f0c1b);
      color: #f3f3f3;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      padding: 3rem;
      border-radius: 16px;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      max-width: 500px;
    }
    h1 {
      font-size: 3rem;
      margin: 0 0 1rem 0;
      background: linear-gradient(45deg, #ff7b00, #ff007b);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p {
      font-size: 1.2rem;
      color: #ccc;
      margin-bottom: 2rem;
    }
    .badge {
      background-color: #ff7b00;
      color: #fff;
      padding: 0.5rem 1.2rem;
      border-radius: 20px;
      font-weight: bold;
      display: inline-block;
      box-shadow: 0 0 15px rgba(255, 123, 0, 0.5);
    }
    .runtime-badge {
      margin-top: 1.5rem;
      font-size: 0.95rem;
      color: #aaa;
    }
    .runtime-badge strong {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🍔 BurgerServer</h1>
    <p>High-performance scaffolding engine built on native Bun.serve with Node fallback.</p>
    <div class="badge">Live & Scaffolding</div>
    <div class="runtime-badge">Running on: <strong>${isBun ? 'Bun' : 'NodeJS'}</strong></div>
  </div>
</body>
</html>`;

if (isBun) {
  // Bun-native high performance server
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(welcomeHtml, {
          headers: { 'Content-Type': 'text/html', ...corsHeaders }
        });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', port: PORT }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      if (req.method === 'POST' && url.pathname === '/generate') {
        try {
          const body = await req.json();
          const { prompt } = body;

          if (!prompt) {
            return new Response(JSON.stringify({ error: 'Prompt is required.' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }

          console.log(`📡 Received prompt: "${prompt}"`);
          const data = await generateScaffolding(prompt);
          return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });

        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  });

  console.log(`🚀 BurgerServer-backend running natively on Bun at http://localhost:${PORT}`);

} else {
  // Node-Express fallback server
  const { default: express } = await import('express');
  const { default: cors } = await import('cors');

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/', (req, res) => {
    res.send(welcomeHtml);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', port: PORT });
  });

  app.post('/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    console.log(`📡 Received prompt (Node): "${prompt}"`);

    try {
      const data = await generateScaffolding(prompt);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 BurgerServer-backend running on Node fallback at http://localhost:${PORT}`);
  });
}
