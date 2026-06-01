#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { program } = require('commander');
const pc = require('picocolors');

// Helper to send a POST request with support for both fetch and a native http/https module fallback
async function postData(url, data) {
  if (typeof globalThis.fetch === 'function') {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  }

  // Fallback using native http/https modules
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const bodyStr = JSON.stringify(data);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: async () => JSON.parse(body),
          });
        } catch (e) {
          reject(new Error('Invalid JSON response from server'));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

program
  .name('bunserver')
  .description('Custom AI Code Scaffolding Tool for BunServer')
  .version('1.0.0')
  .argument('<prompt>', 'The prompt describing what you want to create')
  .option('-d, --dir <directory>', 'Target directory to generate the files in', '.')
  .parse(process.argv);

const prompt = program.args[0];
const options = program.opts();
const targetDir = path.resolve(options.dir);

// Backend server URLs
const LOCAL_BACKEND_URL = 'http://localhost:3002/generate';
const CLOUD_BACKEND_URL = 'https://bunserver.onrender.com/generate';

// Helper to quickly check if a local backend is running
async function checkLocalServer() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3002/health', (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.status === 'ok');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  let backendUrl = CLOUD_BACKEND_URL;
  console.log(pc.green('\nConnecting to BunServer...'));

  try {
    const isLocalRunning = await checkLocalServer();
    if (isLocalRunning) {
      backendUrl = LOCAL_BACKEND_URL;
      console.log(pc.magenta('🍇 Native BunServer backend detected! Routing request locally (no time limits).'));
    } else {
      console.log(pc.yellow('⚠️ Local BunServer backend not detected on port 3002. Fallback to Cloud Server...'));
      console.log(pc.green('🌐 Routing request to cloud server...'));
    }

    const response = await postData(backendUrl, { prompt });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Server responded with status ${response.status}`);
    }

    const data = await response.json();

    if (!data.files || data.files.length === 0) {
      throw new Error('No files returned from the server.');
    }

    console.log(pc.green(`\n✅ Code received! Creating project in folder: "${path.relative(process.cwd(), targetDir) || '.'}"...\n`));

    // Ensure the main target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write each file
    for (const file of data.files) {
      if (!file.path || typeof file.path !== 'string') {
        continue;
      }

      const filePath = path.resolve(targetDir, file.path);

      // Security check: Prevent path traversal
      const relative = path.relative(targetDir, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        console.warn(pc.yellow(`   ⚠️ Warning: Blocked path traversal attempt for: "${file.path}"`));
        continue;
      }

      const fileDir = path.dirname(filePath);

      // Create directories leading to file recursively
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }

      fs.writeFileSync(filePath, file.content || '', 'utf8');
      console.log(`   📄 Created: ${pc.cyan(file.path)}`);
    }

    console.log(pc.bold(pc.green(`\n🎉 BunScaffolding Ready in "${path.basename(targetDir)}"!`)));

  } catch (error) {
    console.error(pc.red('\n❌ Error generating code:'), error.message);
    process.exit(1);
  }
}

main();
