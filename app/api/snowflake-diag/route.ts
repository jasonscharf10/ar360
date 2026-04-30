import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createPrivateKey, createPublicKey, createHash } from 'crypto'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result: Record<string, string> = {}

  try {
    const rawAccount = process.env.SNOWFLAKE_ACCOUNT ?? ''
    result.account_raw_length = String(rawAccount.length)
    result.account_trimmed = rawAccount.trim().replace(/\.snowflakecomputing\.com$/i, '')
    result.username = process.env.SNOWFLAKE_USERNAME ?? '(not set)'
    result.warehouse = process.env.SNOWFLAKE_WAREHOUSE ?? '(not set)'

    const rawKey = (process.env.SNOWFLAKE_PRIVATE_KEY ?? '')
      .replace(/\\n/g, '\n')
      .replace(/[\s%]+$/, '')
      .trim()

    result.key_header = rawKey.split('\n')[0] ?? '(empty)'
    result.key_line_count = String(rawKey.split('\n').length)

    const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE ?? ''
    const keyObj = createPrivateKey({ key: rawKey, format: 'pem', passphrase })
    result.key_type = keyObj.asymmetricKeyType ?? 'unknown'

    const pubKeyObj = createPublicKey(keyObj)
    const der = pubKeyObj.export({ format: 'der', type: 'spki' })
    result.public_key_fingerprint = 'SHA256:' + createHash('sha256').update(der).digest('base64')

    result.status = 'ok'
  } catch (e: any) {
    result.status = 'error'
    result.error = e.message
  }

  return NextResponse.json(result)
}
