import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { sendEmail } from '@/lib/gmail'

export async function POST(req: Request) {
  const session = await getServerSession(authOptions) as any
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accessToken: string = session.accessToken
  const refreshToken: string = session.refreshToken
  if (!accessToken || !refreshToken) {
    return NextResponse.json({ error: 'No Gmail tokens in session — please sign out and sign in again' }, { status: 401 })
  }

  const { to, subject, body } = await req.json()
  if (!to || !subject || !body) {
    return NextResponse.json({ error: 'to, subject, and body are required' }, { status: 400 })
  }

  const from = process.env.GMAIL_AR_MAILBOX || session.user?.email || ''

  try {
    const message = await sendEmail(accessToken, refreshToken, to, from, subject, body)
    return NextResponse.json({ messageId: message.id })
  } catch (err) {
    console.error('[/api/gmail-send] failed:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
