/**
 * Snowflake client for AR360.
 * Uses key-pair (JWT) authentication — no password or MFA required.
 *
 * Required env vars:
 *   SNOWFLAKE_ACCOUNT    e.g. pandadoc.us-east-1
 *   SNOWFLAKE_USERNAME   the service account username
 *   SNOWFLAKE_PRIVATE_KEY  PEM content with literal \n for newlines, e.g.:
 *                          -----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----
 *   SNOWFLAKE_WAREHOUSE  e.g. COMPUTE_WH
 *
 * Optional:
 *   SNOWFLAKE_PRIVATE_KEY_PASSPHRASE  if the key was generated with a passphrase
 */

import snowflake from 'snowflake-sdk'

snowflake.configure({ logLevel: 'ERROR' } as any)

interface SnowflakeConn {
  conn: snowflake.Connection
}

// Persist across Next.js HMR cycles in dev
const g = global as any
if (!g.__sf) g.__sf = { conn: null }
const cache: SnowflakeConn = g.__sf

async function getConn(): Promise<snowflake.Connection> {
  if (cache.conn?.isUp()) return cache.conn

  const required = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USERNAME', 'SNOWFLAKE_PRIVATE_KEY', 'SNOWFLAKE_WAREHOUSE']
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`)
  }

  // Env vars can't contain real newlines — stored with literal \n, restore them here
  // Also strip any trailing shell artifacts (%, spaces)
  const rawKey = process.env.SNOWFLAKE_PRIVATE_KEY!
    .replace(/\\n/g, '\n')
    .replace(/[\s%]+$/, '')
    .trim()

  // If the key is encrypted, decrypt it using Node crypto before passing to the SDK
  let privateKey: string
  if (rawKey.includes('ENCRYPTED')) {
    // PKCS8 keys always have "ENCRYPTED" in the header even when generated without a passphrase.
    // Use empty string as default — only set SNOWFLAKE_PRIVATE_KEY_PASSPHRASE if key was generated WITH one.
    const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE ?? ''
    const { createPrivateKey } = await import('crypto')
    const keyObj = createPrivateKey({ key: rawKey, format: 'pem', passphrase })
    privateKey = keyObj.export({ type: 'pkcs8', format: 'pem' }) as string
  } else {
    privateKey = rawKey
  }

  // SDK appends .snowflakecomputing.com — strip it if the env var already has it
  const account = process.env.SNOWFLAKE_ACCOUNT!.replace(/\.snowflakecomputing\.com$/i, '')

  const conn = snowflake.createConnection({
    account,
    username: process.env.SNOWFLAKE_USERNAME!,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE!,
    application: 'AR360',
  })

  await new Promise<void>((resolve, reject) => {
    conn.connect(err => {
      if (err) reject(new Error(`Snowflake connect failed: ${err.message}`))
      else resolve()
    })
  })

  cache.conn = conn
  return conn
}

export async function sfQuery<T = Record<string, any>>(sql: string): Promise<T[]> {
  const conn = await getConn()
  return new Promise<T[]>((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err, _stmt, rows) => {
        if (err) reject(new Error(`Snowflake query failed: ${err.message}`))
        else resolve((rows ?? []) as T[])
      },
    })
  })
}

/**
 * Builds a safe SQL IN-list from an array of org UUID strings.
 * Only allows alphanumeric, hyphens, and underscores — typical UUID characters.
 */
export function sfInList(values: string[]): string {
  return values
    .filter(v => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v))
    .map(v => `'${v}'`)
    .join(',')
}
