// Look up a Feishu bot's own open_id (in its own app scope) via GET /open-apis/bot/v3/info.
//
// `larkway init` (CLI) asks for bot_open_id but cannot resolve it itself; the Web UI
// onboarding does, but the Web UI is not reachable from outside a container (it binds
// 127.0.0.1). This helper fills that gap for Docker deployments.
//
// The app secret is read from $LARKWAY_HOME/.env (written by `larkway init`) and is
// never printed. Only the operator runs this; the bridge never calls it.
//
// Usage (inside the image, see docs/docker.md):
//   docker compose run --rm larkway node /app/scripts/get-bot-open-id.cjs <APP_ID> [SECRET_ENV_NAME]
// SECRET_ENV_NAME defaults to the only *_APP_SECRET entry in .env.
// Lark (international) tenants: set LARK_OPEN_DOMAIN=https://open.larksuite.com
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const [appId, envNameArg] = process.argv.slice(2);
  if (!appId || !appId.startsWith("cli_")) {
    console.error("usage: get-bot-open-id.cjs <APP_ID (cli_...)> [SECRET_ENV_NAME]");
    return 2;
  }

  const home = process.env.LARKWAY_HOME || path.join(os.homedir(), ".larkway");
  const envFile = path.join(home, ".env");
  if (!fs.existsSync(envFile)) {
    console.error(`${envFile} not found — run \`larkway init\` first`);
    return 2;
  }
  const env = {};
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }

  let name = envNameArg;
  if (!name) {
    const candidates = Object.keys(env).filter((k) => k.endsWith("_APP_SECRET"));
    if (candidates.length !== 1) {
      console.error(
        `found ${candidates.length} *_APP_SECRET entries in ${envFile}; ` +
          `pass the variable name as the second argument: ${candidates.join(", ")}`,
      );
      return 2;
    }
    name = candidates[0];
  }
  const secret = env[name];
  if (!secret) {
    console.error(`${name} not found in ${envFile}`);
    return 2;
  }

  const base = process.env.LARK_OPEN_DOMAIN || "https://open.feishu.cn";
  const tokenResp = await (
    await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
    })
  ).json();
  if (tokenResp.code !== 0) {
    console.error(`tenant_access_token failed: code=${tokenResp.code} msg=${tokenResp.msg}`);
    return 1;
  }

  const botResp = await (
    await fetch(`${base}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${tokenResp.tenant_access_token}` },
    })
  ).json();
  if (botResp.code !== 0 || !botResp.bot || !botResp.bot.open_id) {
    console.error(`bot/v3/info failed: code=${botResp.code} msg=${botResp.msg}`);
    return 1;
  }
  console.log(`app_name:    ${botResp.bot.app_name}`);
  console.log(`bot_open_id: ${botResp.bot.open_id}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`request failed: ${e.message}`);
    process.exit(1);
  },
);
