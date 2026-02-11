import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hasBinary } from "../agents/skills.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR } from "../utils.js";

const log = createSubsystemLogger("alfie-integrations");

const AlfieIntegrationSnapshotSchema = z.object({
  ok: z.literal(true),
  tenantId: z.string().min(1),
  tenantStatus: z.string().min(1),
  version: z.string().min(1),
  integrations: z.object({
    google: z.object({
      configured: z.boolean(),
      clientId: z.string().nullable(),
      clientSecret: z.string().nullable(),
      accounts: z.array(
        z.object({
          id: z.string().min(1),
          email: z.string().min(1),
          refreshToken: z.string().min(1),
          scopes: z.array(z.string()).nullable(),
          updatedAtIso: z.string().min(1),
        }),
      ),
    }),
  }),
});

export type AlfieIntegrationSnapshot = z.infer<typeof AlfieIntegrationSnapshotSchema>;

type AlfieIntegrationsState = {
  version?: string;
  google?: Record<string, { updatedAtIso: string }>;
  syncedAtIso?: string;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function stateFilePath(): string {
  return path.join(CONFIG_DIR, "alfie", "integrations.json");
}

async function readState(): Promise<AlfieIntegrationsState> {
  const filePath = stateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AlfieIntegrationsState;
  } catch {
    return {};
  }
}

async function writeState(next: AlfieIntegrationsState): Promise<void> {
  const filePath = stateFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600);
}

export function resolveXdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.XDG_CONFIG_HOME ?? "").trim();
  return raw || CONFIG_DIR;
}

function gogCredentialsPath(xdgConfigHome: string): string {
  return path.join(xdgConfigHome, "gogcli", "credentials.json");
}

async function ensureGogClientCredentials(params: {
  xdgConfigHome: string;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const credsPath = gogCredentialsPath(params.xdgConfigHome);
  await fs.mkdir(path.dirname(credsPath), { recursive: true });
  const payload = {
    client_id: params.clientId,
    client_secret: params.clientSecret,
  };
  const tmpPath = `${credsPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, credsPath);
  await fs.chmod(credsPath, 0o600);
}

async function importGogRefreshToken(params: {
  xdgConfigHome: string;
  keyringPassword: string;
  email: string;
  refreshToken: string;
  scopes: string[] | null;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: params.xdgConfigHome,
    GOG_KEYRING_BACKEND: "file",
    GOG_KEYRING_PASSWORD: params.keyringPassword,
  };

  const input = JSON.stringify(
    {
      email: params.email,
      refresh_token: params.refreshToken,
      scopes: params.scopes ?? undefined,
    },
    null,
    2,
  );

  const result = await runCommandWithTimeout(
    ["gog", "--no-input", "--plain", "auth", "tokens", "import", "-"],
    { timeoutMs: params.timeoutMs, input: `${input}\n`, env },
  );

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    return { ok: false, error: stderr || stdout || `gog exited with code ${String(result.code)}` };
  }
  return { ok: true };
}

async function fetchIntegrationSnapshot(params: {
  apiUrl: string;
  gatewayToken: string;
  timeoutMs: number;
}): Promise<AlfieIntegrationSnapshot | null> {
  const base = normalizeBaseUrl(params.apiUrl);
  const url = `${base}/internal/v1/tenant-integrations/snapshot`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${params.gatewayToken}` },
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    log.warn(`snapshot fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return null;
  }
  try {
    const json = JSON.parse(text) as unknown;
    const parsed = AlfieIntegrationSnapshotSchema.safeParse(json);
    if (!parsed.success) {
      log.warn(`snapshot parse failed: ${parsed.error.message}`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn(`snapshot JSON parse failed: ${String(err)}`);
    return null;
  }
}

export async function syncAlfieIntegrationsOnce(params?: {
  apiUrl?: string;
  gatewayToken?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!isTruthyEnvValue(process.env.ALFIE_MODE)) {
    return;
  }

  const apiUrl = (params?.apiUrl ?? process.env.ALFIE_API_URL ?? "").trim();
  if (!apiUrl) {
    log.warn("ALFIE_API_URL not set; skipping integration sync");
    return;
  }

  const gatewayToken = (params?.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  if (!gatewayToken) {
    log.warn("OPENCLAW_GATEWAY_TOKEN not set; skipping integration sync");
    return;
  }

  if (!hasBinary("gog")) {
    log.warn("gog binary not found; skipping Google integration sync");
    return;
  }

  const timeoutMs = params?.timeoutMs ?? Number(process.env.ALFIE_INTEGRATION_SNAPSHOT_TIMEOUT_MS ?? "10000");
  const snapshot = await fetchIntegrationSnapshot({ apiUrl, gatewayToken, timeoutMs });
  if (!snapshot) {
    return;
  }

  const google = snapshot.integrations.google;
  if (!google.configured || !google.clientId || !google.clientSecret) {
    return;
  }

  const accounts = google.accounts
    .map((acct) => ({ ...acct, email: acct.email.trim().toLowerCase() }))
    .filter((acct) => Boolean(acct.email));

  if (accounts.length === 0) {
    return;
  }

  const xdgConfigHome = resolveXdgConfigHome();
  const keyringPassword = (process.env.GOG_KEYRING_PASSWORD ?? "").trim() || gatewayToken;

  await ensureGogClientCredentials({
    xdgConfigHome,
    clientId: google.clientId,
    clientSecret: google.clientSecret,
  });

  const state = await readState();
  const googleState: NonNullable<AlfieIntegrationsState["google"]> = { ...(state.google ?? {}) };
  let changed = false;

  for (const acct of accounts) {
    const prev = googleState[acct.email]?.updatedAtIso ?? "";
    if (prev && prev === acct.updatedAtIso) {
      continue;
    }
    const result = await importGogRefreshToken({
      xdgConfigHome,
      keyringPassword,
      email: acct.email,
      refreshToken: acct.refreshToken,
      scopes: acct.scopes,
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      log.warn(`gog token import failed for ${acct.email}: ${result.error}`);
      continue;
    }
    googleState[acct.email] = { updatedAtIso: acct.updatedAtIso };
    changed = true;
  }

  if (changed || state.version !== snapshot.version) {
    const next: AlfieIntegrationsState = {
      ...state,
      version: snapshot.version,
      google: googleState,
      syncedAtIso: new Date().toISOString(),
    };
    await writeState(next);
  }
}

export async function startAlfieIntegrationSyncIfEnabled(): Promise<void> {
  if (!isTruthyEnvValue(process.env.ALFIE_MODE)) {
    return;
  }

  const intervalMs = Number(process.env.ALFIE_INTEGRATION_SYNC_INTERVAL_MS ?? "30000");
  const boundedIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000;

  try {
    await syncAlfieIntegrationsOnce();
  } catch (err) {
    log.warn(`initial integration sync failed: ${String(err)}`);
  }

  setInterval(() => {
    void syncAlfieIntegrationsOnce().catch((err) => {
      log.warn(`integration sync failed: ${String(err)}`);
    });
  }, boundedIntervalMs);
}

